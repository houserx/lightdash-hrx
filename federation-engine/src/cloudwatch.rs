//! `cloudwatch(metric_data_query json, start, end[, source])` (CONTRACTS §1.1): one CloudWatch
//! `GetMetricData` query as the `promql` columns `timestamp timestamptz, value float8, labels
//! json, series text`, one row per datapoint.
//!
//! `metric_data_query` is the target model Grafana's CloudWatch datasource stores, not the AWS
//! shape (contract assumption A19). Builder mode (`metricEditorMode = 0`, no `expression`) becomes
//! a `MetricStat` from `namespace`, `metricName`, `dimensions`, `statistic` and `period`. Code mode
//! (`metricEditorMode = 1` or a non-empty `expression`, e.g. `SEARCH(...)` or metric math) sends
//! the `expression` whole as the `Expression`, with the `period`, and no `MetricStat`; a search
//! then gives one series per result. The Grafana `label`, when non-empty, is sent as the AWS
//! `Label` and is the `series` of every row; otherwise `series` is each result's `Label`.
//! Metrics Insights targets (`metricQueryType = 1`) are not supported yet (0A000).
//!
//! The AWS `MetricDataQuery` shape is read too (what Investigate's CloudWatch form builds and MCP
//! callers send): an object with `Id`, `MetricStat` or `Expression` (PascalCase keys, which a
//! Grafana target never has) is sent as that query, with `Label` as its label. Both shapes of the
//! same metric reach CloudWatch as the same `MetricStat`.
//!
//! Requests are signed with SigV4 by the AWS SDK using the default credential chain, in the
//! source's region, at the source's `endpoint_url` when one is set. With `role_arn`, the client
//! signs with temporary credentials from STS `AssumeRole` (itself signed by the default chain, at
//! `sts_endpoint_url` when one is set). `NextToken` pages are followed
//! until CloudWatch has no more. As with `promql`, the arguments are constants checked when the
//! statement is planned, and CloudWatch is asked when the table is scanned.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use aws_sdk_cloudwatch::config::Region;
use aws_sdk_cloudwatch::error::{DisplayErrorContext, ProvideErrorMetadata};
use aws_sdk_cloudwatch::primitives::DateTime;
use aws_sdk_cloudwatch::types::{
    Dimension, Metric, MetricDataQuery, MetricDataResult, MetricStat, ScanBy, StandardUnit,
    StatusCode,
};
use datafusion::arrow::array::{
    ArrayRef, Float64Builder, StringBuilder, TimestampMicrosecondBuilder,
};
use datafusion::arrow::datatypes::SchemaRef;
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::catalog::memory::MemorySourceConfig;
use datafusion::catalog::{Session, TableFunctionArgs, TableFunctionImpl, TableProvider};
use datafusion::error::DataFusionError;
use datafusion::logical_expr::{Expr, TableType};
use datafusion::physical_plan::ExecutionPlan;
use engine_config::{AwsSettings, Config, SourceKind, SourceSettings};
use serde_json::{Map, Value};
use tokio::sync::OnceCell;

use crate::aws;
use crate::promql::{UTC, constant, parse_duration, sample_schema, text_argument, time_argument};
use crate::session::sqlstate;
use crate::sources::HttpSources;

const SIGNATURE: &str = "cloudwatch(metric_data_query, start, end[, source])";
/// Grafana's choice of period for `period: "auto"` (or empty) aims at no more than this many
/// datapoints over the range.
const AUTO_PERIOD_DATAPOINTS: i64 = 2000;

/// The configured CloudWatch sources, each with a lazily built SDK client.
#[derive(Debug, Clone)]
pub struct Cloudwatch {
    sources: HttpSources,
    settings: HashMap<String, AwsSettings>,
    /// One client per source, built on first use (loading the credential chain is async).
    clients: HashMap<String, Arc<OnceCell<aws_sdk_cloudwatch::Client>>>,
    connect_timeout: Duration,
}

impl Cloudwatch {
    pub fn new(config: &Config, connect_timeout: Duration) -> Cloudwatch {
        let settings: HashMap<String, AwsSettings> = config
            .sources
            .iter()
            .filter_map(|s| match &s.settings {
                SourceSettings::Cloudwatch { aws } => Some((s.name.clone(), aws.clone())),
                _ => None,
            })
            .collect();
        Cloudwatch {
            sources: HttpSources::new(config, SourceKind::Cloudwatch),
            clients: settings
                .keys()
                .map(|name| (name.clone(), Arc::default()))
                .collect(),
            settings,
            connect_timeout,
        }
    }
}

impl TableFunctionImpl for Cloudwatch {
    fn call_with_args(
        &self,
        args: TableFunctionArgs,
    ) -> datafusion::error::Result<Arc<dyn TableProvider>> {
        let exprs = args.exprs();
        if !(3..=4).contains(&exprs.len()) {
            return Err(sqlstate(
                "42883",
                format!("{SIGNATURE} takes 3 or 4 arguments, not {}", exprs.len()),
            ));
        }
        let session = args.session();
        let arg = |i: usize| constant(&exprs[i], session, SIGNATURE);
        let target = text_argument(arg(0)?, "metric_data_query", SIGNATURE)?;
        let start = time_argument(arg(1)?, "start", SIGNATURE)?;
        let end = time_argument(arg(2)?, "end", SIGNATURE)?;
        if end <= start {
            return Err(sqlstate("22023", format!("{SIGNATURE}: end must be after start")));
        }
        let source = match exprs.get(3) {
            Some(_) => Some(text_argument(arg(3)?, "source", SIGNATURE)?),
            None => None,
        };
        let (name, max_rows) = self.sources.pick(source, session)?;
        let aws = self.settings[&name].clone();
        let now = chrono::Utc::now().timestamp_micros();
        let target = Target::parse(&target, start, end, now)?;
        Ok(Arc::new(CloudwatchQuery {
            client: self.clients[&name].clone(),
            connect_timeout: self.connect_timeout,
            name,
            aws,
            max_rows,
            target,
            start,
            end,
        }))
    }
}

/// A Grafana CloudWatch target, checked and ready to send.
#[derive(Debug, Clone, PartialEq)]
struct Target {
    id: String,
    metric: TargetMetric,
    period: i32,
    /// Grafana's `label`, when non-empty.
    label: Option<String>,
    /// A region other than `default`.
    region: Option<String>,
}

/// What a target asks CloudWatch for.
#[derive(Debug, Clone, PartialEq)]
enum TargetMetric {
    /// Builder mode: one metric and statistic.
    Stat {
        namespace: String,
        metric_name: String,
        /// (name, value), in the target's order.
        dimensions: Vec<(String, String)>,
        statistic: String,
        /// The AWS shape's optional `Unit`; Grafana targets have none.
        unit: Option<String>,
    },
    /// Code mode: a search or metric math expression, sent unchanged.
    Expression(String),
}

impl Target {
    /// Reads Grafana's stored target JSON. `start`, `end` and `now` (µs) pick an `auto` period.
    fn parse(text: &str, start: i64, end: i64, now: i64) -> Result<Target, DataFusionError> {
        let invalid = |what: String| sqlstate("22023", format!("{SIGNATURE}: {what}"));
        let target: Value = serde_json::from_str(text).map_err(|e| {
            sqlstate(
                "22P02",
                format!("{SIGNATURE}: metric_data_query is not valid JSON: {e}"),
            )
        })?;
        let Some(t) = target.as_object() else {
            return Err(invalid("metric_data_query must be a JSON object".into()));
        };
        // Grafana's keys are camelCase; the AWS shape's are PascalCase, so they cannot be mixed up.
        if ["Id", "MetricStat", "Expression"]
            .iter()
            .any(|key| t.contains_key(*key))
        {
            return Target::parse_aws(t, start, end, now);
        }
        let text = |key: &str| t.get(key).and_then(Value::as_str).unwrap_or("");
        if t.get("metricQueryType").and_then(Value::as_i64) == Some(1) {
            return Err(sqlstate(
                "0A000",
                format!(
                    "{SIGNATURE}: Metrics Insights queries (metricQueryType = 1) are not \
                     supported yet; use a metric stat or a search or math expression"
                ),
            ));
        }
        let code_mode = !text("expression").trim().is_empty()
            || t.get("metricEditorMode").and_then(Value::as_i64) == Some(1);
        let metric = if code_mode {
            match text("expression") {
                e if e.trim().is_empty() => {
                    return Err(invalid("the code-mode target has no expression".into()));
                }
                e => TargetMetric::Expression(e.to_string()),
            }
        } else {
            Target::metric_stat(t)?
        };
        let period = target_period(t.get("period"), start, end, now)?;
        let label = Some(text("label").to_string()).filter(|l| !l.is_empty());
        let region = match text("region") {
            "" | "default" => None,
            r => Some(r.to_string()),
        };
        Ok(Target {
            id: query_id(text("id"), text("refId")),
            metric,
            period,
            label,
            region,
        })
    }

    /// Reads the AWS `MetricDataQuery` shape (what Investigate's CloudWatch form builds and MCP
    /// callers send): `Id`, then either `MetricStat` (`Metric` with `Namespace`, `MetricName` and
    /// `Dimensions` as `[{Name, Value}]`, `Period`, `Stat`, optional `Unit`) or an `Expression`
    /// with an optional `Period` (`auto` when absent), and an optional `Label`.
    fn parse_aws(
        t: &Map<String, Value>,
        start: i64,
        end: i64,
        now: i64,
    ) -> Result<Target, DataFusionError> {
        let invalid = |what: String| sqlstate("22023", format!("{SIGNATURE}: {what}"));
        let text = |m: &Map<String, Value>, key: &str| -> Result<Option<String>, DataFusionError> {
            match m.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(s)) if s.is_empty() => Ok(None),
                Some(Value::String(s)) => Ok(Some(s.clone())),
                Some(_) => Err(invalid(format!("{key} must be a string"))),
            }
        };
        if t.contains_key("AccountId") {
            return Err(sqlstate(
                "0A000",
                format!("{SIGNATURE}: cross-account queries (AccountId) are not supported yet"),
            ));
        }
        if t.get("ReturnData") == Some(&Value::Bool(false)) {
            return Err(invalid(
                "ReturnData = false would return no data for the only query".into(),
            ));
        }
        let expression = text(t, "Expression")?.filter(|e| !e.trim().is_empty());
        let (metric, period) = match (t.get("MetricStat"), expression) {
            (Some(_), Some(_)) => {
                return Err(invalid(
                    "the query has both MetricStat and Expression; give one".into(),
                ));
            }
            (None, None) => {
                return Err(invalid("the query has neither MetricStat nor Expression".into()));
            }
            (None, Some(expression)) => (
                TargetMetric::Expression(expression),
                target_period(t.get("Period"), start, end, now)?,
            ),
            (Some(stat), None) => {
                let Some(stat) = stat.as_object() else {
                    return Err(invalid("MetricStat must be a JSON object".into()));
                };
                let Some(metric) = stat.get("Metric").and_then(Value::as_object) else {
                    return Err(invalid("MetricStat has no Metric object".into()));
                };
                let required = |m: &Map<String, Value>, key: &str| {
                    text(m, key)?.ok_or_else(|| invalid(format!("the query has no {key}")))
                };
                let mut dimensions = vec![];
                match metric.get("Dimensions") {
                    None | Some(Value::Null) => {}
                    Some(Value::Array(dims)) => {
                        for dim in dims {
                            let pair = dim.as_object().and_then(|d| {
                                Some((d.get("Name")?.as_str()?, d.get("Value")?.as_str()?))
                            });
                            let Some((name, value)) = pair else {
                                return Err(invalid(
                                    "each dimension must be {\"Name\": text, \"Value\": text}"
                                        .into(),
                                ));
                            };
                            dimensions.push((name.to_string(), value.to_string()));
                        }
                    }
                    Some(_) => return Err(invalid("Dimensions must be a JSON array".into())),
                }
                let period = match stat.get("Period") {
                    None | Some(Value::Null) => {
                        return Err(invalid("MetricStat has no Period".into()));
                    }
                    p => target_period(p, start, end, now)?,
                };
                (
                    TargetMetric::Stat {
                        namespace: required(metric, "Namespace")?,
                        metric_name: required(metric, "MetricName")?,
                        dimensions,
                        statistic: required(stat, "Stat")?,
                        unit: text(stat, "Unit")?,
                    },
                    period,
                )
            }
        };
        Ok(Target {
            id: query_id(&text(t, "Id")?.unwrap_or_default(), ""),
            metric,
            period,
            label: text(t, "Label")?,
            region: None,
        })
    }

    /// The builder-mode part of a target: namespace, metric name, dimensions and statistic.
    fn metric_stat(t: &Map<String, Value>) -> Result<TargetMetric, DataFusionError> {
        let invalid = |what: String| sqlstate("22023", format!("{SIGNATURE}: {what}"));
        let unsupported = |what: &str| {
            let hint = "use a metric stat with exact, single-value dimensions or an expression";
            sqlstate(
                "0A000",
                format!("{SIGNATURE}: {what} are not supported yet; {hint}"),
            )
        };
        let text = |key: &str| t.get(key).and_then(Value::as_str).unwrap_or("");
        if t.get("matchExact") == Some(&Value::Bool(false)) {
            return Err(unsupported("matchExact = false (Grafana's SEARCH translation)"));
        }
        let required = |key: &str| -> Result<String, DataFusionError> {
            match text(key) {
                "" => Err(invalid(format!("the target has no {key}"))),
                s => Ok(s.to_string()),
            }
        };
        let namespace = required("namespace")?;
        let metric_name = required("metricName")?;
        let statistic = match text("statistic") {
            "" => match t.get("statistics").and_then(Value::as_array).map(Vec::as_slice) {
                Some([one]) if one.as_str().is_some_and(|s| !s.is_empty()) => {
                    one.as_str().unwrap_or_default().to_string()
                }
                _ => return Err(invalid("the target has no statistic".into())),
            },
            s => s.to_string(),
        };
        let mut dimensions = vec![];
        match t.get("dimensions") {
            None | Some(Value::Null) => {}
            Some(Value::Object(dims)) => {
                for (key, value) in dims {
                    let value = match value {
                        Value::String(s) => s.as_str(),
                        Value::Array(values) => match values.as_slice() {
                            [Value::String(s)] => s.as_str(),
                            [] => return Err(invalid(format!("dimension \"{key}\" has no value"))),
                            _ => return Err(unsupported("multi-value dimensions")),
                        },
                        _ => {
                            return Err(invalid(format!(
                                "dimension \"{key}\" must be a string or a list of strings"
                            )));
                        }
                    };
                    if value == "*" {
                        return Err(unsupported("wildcard dimensions"));
                    }
                    dimensions.push((key.clone(), value.to_string()));
                }
            }
            Some(_) => return Err(invalid("dimensions must be a JSON object".into())),
        }
        Ok(TargetMetric::Stat {
            namespace,
            metric_name,
            dimensions,
            statistic,
            unit: None,
        })
    }

    fn query(&self) -> MetricDataQuery {
        let query = MetricDataQuery::builder()
            .id(&self.id)
            .set_label(self.label.clone())
            .return_data(true);
        match &self.metric {
            TargetMetric::Stat {
                namespace,
                metric_name,
                dimensions,
                statistic,
                unit,
            } => {
                let mut metric = Metric::builder().namespace(namespace).metric_name(metric_name);
                for (name, value) in dimensions {
                    metric =
                        metric.dimensions(Dimension::builder().name(name).value(value).build());
                }
                let stat = MetricStat::builder()
                    .metric(metric.build())
                    .period(self.period)
                    .stat(statistic)
                    .set_unit(unit.as_deref().map(StandardUnit::from))
                    .build();
                query.metric_stat(stat).build()
            }
            // As Grafana does for code mode: the expression whole, with the target's period.
            TargetMetric::Expression(expression) => {
                query.expression(expression).period(self.period).build()
            }
        }
    }

    /// The `labels` JSON of every row: the metric's identity (or the expression) and the
    /// result's label.
    fn labels(&self, result_label: &str) -> String {
        let mut labels = Map::new();
        match &self.metric {
            TargetMetric::Stat {
                namespace,
                metric_name,
                dimensions,
                statistic,
                ..
            } => {
                for (name, value) in dimensions {
                    labels.insert(name.clone(), Value::String(value.clone()));
                }
                labels.insert("namespace".into(), namespace.clone().into());
                labels.insert("metric_name".into(), metric_name.clone().into());
                labels.insert("statistic".into(), statistic.clone().into());
            }
            TargetMetric::Expression(expression) => {
                labels.insert("expression".into(), expression.clone().into());
            }
        }
        labels.insert("label".into(), result_label.into());
        Value::Object(labels).to_string()
    }
}

/// A valid CloudWatch query id (`^[a-z][a-zA-Z0-9_]*$`): Grafana's `id` if it is one, else
/// `query<refId>` as Grafana does, else `query`.
fn query_id(id: &str, ref_id: &str) -> String {
    let valid = |s: &str| {
        s.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    if valid(id) {
        return id.to_string();
    }
    let generated = format!("query{ref_id}");
    if valid(&generated) {
        generated
    } else {
        "query".to_string()
    }
}

/// A target's period: whole seconds as a number or text (`300`, `5m`), or `auto` (also when
/// absent or empty), which picks one for the range as Grafana does.
fn target_period(
    value: Option<&Value>,
    start: i64,
    end: i64,
    now: i64,
) -> Result<i32, DataFusionError> {
    let invalid = |what: String| sqlstate("22023", format!("{SIGNATURE}: {what}"));
    Ok(match value {
        None | Some(Value::Null) => auto_period(start, end, now),
        Some(Value::String(s)) if s.trim().is_empty() || s.trim() == "auto" => {
            auto_period(start, end, now)
        }
        Some(Value::String(s)) => period_seconds(s.trim())
            .ok_or_else(|| invalid(format!("invalid period \"{s}\"")))?,
        Some(Value::Number(n)) => n
            .as_i64()
            .filter(|p| *p > 0)
            .and_then(|p| i32::try_from(p).ok())
            .ok_or_else(|| invalid(format!("invalid period {n}")))?,
        Some(other) => return Err(invalid(format!("invalid period {other}"))),
    })
}

/// A period as whole seconds: `300`, or a duration such as `5m`.
fn period_seconds(s: &str) -> Option<i32> {
    let us = parse_duration(s)?;
    if us % 1_000_000 != 0 {
        return None;
    }
    i32::try_from(us / 1_000_000).ok().filter(|p| *p > 0)
}

/// Grafana's `auto` period: the smallest period CloudWatch still retains for data as old as
/// `start` that gives at most 2000 datapoints over the range, else the largest one.
fn auto_period(start: i64, end: i64, now: i64) -> i32 {
    const DAY: i64 = 86_400;
    let age = (now - start).max(0) / 1_000_000;
    let periods: &[i32] = if age < 15 * DAY {
        &[60, 300, 900, 3600, 21600, 86400]
    } else if age < 63 * DAY {
        &[300, 900, 3600, 21600, 86400]
    } else if age < 455 * DAY {
        &[3600, 21600, 86400]
    } else {
        &[86400]
    };
    let range = (end - start).max(0);
    let per_point = AUTO_PERIOD_DATAPOINTS * 1_000_000;
    let datapoints = (range + per_point - 1) / per_point;
    periods
        .iter()
        .copied()
        .find(|p| datapoints <= i64::from(*p))
        .unwrap_or(86400)
}

/// µs since the Unix epoch as an AWS timestamp.
fn aws_time(us: i64) -> DateTime {
    let nanos = (us.rem_euclid(1_000_000) * 1000) as u32;
    DateTime::from_secs_and_nanos(us.div_euclid(1_000_000), nanos)
}

/// An AWS timestamp as µs since the Unix epoch (truncated).
fn micros(t: &DateTime) -> i64 {
    t.secs() * 1_000_000 + i64::from(t.subsec_nanos() / 1000)
}

/// One `cloudwatch()` call: the query to send and where.
#[derive(Debug)]
struct CloudwatchQuery {
    client: Arc<OnceCell<aws_sdk_cloudwatch::Client>>,
    connect_timeout: Duration,
    name: String,
    aws: AwsSettings,
    max_rows: usize,
    target: Target,
    start: i64,
    end: i64,
}

impl CloudwatchQuery {
    async fn client(&self) -> &aws_sdk_cloudwatch::Client {
        self.client
            .get_or_init(|| async {
                let shared = aws::shared_config(&self.aws, self.connect_timeout).await;
                let mut config = aws_sdk_cloudwatch::config::Builder::from(&shared);
                if let Some(url) = &self.aws.endpoint_url {
                    config = config.endpoint_url(url);
                }
                if let Some(role) = &self.aws.role_arn {
                    let provider = aws::assume_role(&shared, role, &self.aws).await;
                    config = config.credentials_provider(provider);
                }
                aws_sdk_cloudwatch::Client::from_conf(config.build())
            })
            .await
    }

    /// Every result of every `NextToken` page, in CloudWatch's order.
    async fn fetch(&self) -> Result<Rows, DataFusionError> {
        let mut client = self.client().await.clone();
        if let Some(region) = &self.target.region {
            let config = client.config().to_builder().region(Region::new(region.clone()));
            client = aws_sdk_cloudwatch::Client::from_conf(config.build());
        }
        let source = &self.name;
        let mut rows = Rows::default();
        let mut next_token: Option<String> = None;
        loop {
            let request = client
                .get_metric_data()
                .metric_data_queries(self.target.query())
                .start_time(aws_time(self.start))
                .end_time(aws_time(self.end))
                .scan_by(ScanBy::TimestampAscending)
                .set_next_token(next_token.take());
            let page = request.send().await.map_err(|e| {
                let what = match e.as_service_error() {
                    Some(se) => format!(
                        "{}: {}",
                        se.code().unwrap_or("error"),
                        se.message().unwrap_or("no error message")
                    ),
                    None => DisplayErrorContext(&e).to_string(),
                };
                DataFusionError::Execution(format!(
                    "cloudwatch source \"{source}\": GetMetricData failed: {what}"
                ))
            })?;
            for result in page.metric_data_results() {
                rows.add(source, &self.target, result, self.max_rows)?;
            }
            match page.next_token() {
                Some(token) if !token.is_empty() => next_token = Some(token.to_string()),
                _ => return Ok(rows),
            }
        }
    }
}

/// The rows of a `cloudwatch()` call, built page by page.
#[derive(Default)]
struct Rows {
    timestamps: Vec<i64>,
    values: Vec<f64>,
    labels: Vec<String>,
    series: Vec<String>,
}

impl Rows {
    /// Appends one result's datapoints. A failed result is an error; more than `max_rows`
    /// datapoints in all fails with SQLSTATE 54000.
    fn add(
        &mut self,
        source: &str,
        target: &Target,
        result: &MetricDataResult,
        max_rows: usize,
    ) -> Result<(), DataFusionError> {
        let fail = |what: String| {
            DataFusionError::Execution(format!("cloudwatch source \"{source}\": {what}"))
        };
        if let Some(status @ (StatusCode::Forbidden | StatusCode::InternalError)) =
            result.status_code()
        {
            let detail = result
                .messages()
                .iter()
                .filter_map(|m| m.value())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(fail(format!("the query result is {}: {detail}", status.as_str())));
        }
        let (ts, vs) = (result.timestamps(), result.values());
        if ts.len() != vs.len() {
            return Err(fail(format!(
                "a result has {} timestamps but {} values",
                ts.len(),
                vs.len()
            )));
        }
        if self.timestamps.len() + ts.len() > max_rows {
            return Err(sqlstate(
                "54000",
                format!("result exceeds max_rows ({max_rows}) for source \"{source}\""),
            ));
        }
        let result_label = result.label().or(result.id()).unwrap_or_default();
        let series = target.label.as_deref().unwrap_or(result_label);
        let labels = target.labels(result_label);
        for (t, v) in ts.iter().zip(vs) {
            self.timestamps.push(micros(t));
            self.values.push(*v);
            self.labels.push(labels.clone());
            self.series.push(series.to_string());
        }
        Ok(())
    }

    fn batch(self) -> Result<RecordBatch, DataFusionError> {
        let mut timestamps = TimestampMicrosecondBuilder::new().with_timezone(UTC);
        timestamps.append_slice(&self.timestamps);
        let mut values = Float64Builder::new();
        values.append_slice(&self.values);
        let mut labels = StringBuilder::new();
        let mut series = StringBuilder::new();
        for (l, s) in self.labels.iter().zip(&self.series) {
            labels.append_value(l);
            series.append_value(s);
        }
        let columns: Vec<ArrayRef> = vec![
            Arc::new(timestamps.finish()),
            Arc::new(values.finish()),
            Arc::new(labels.finish()),
            Arc::new(series.finish()),
        ];
        Ok(RecordBatch::try_new(sample_schema(), columns)?)
    }
}

#[async_trait]
impl TableProvider for CloudwatchQuery {
    fn schema(&self) -> SchemaRef {
        sample_schema()
    }

    fn table_type(&self) -> TableType {
        TableType::Temporary
    }

    async fn scan(
        &self,
        _state: &dyn Session,
        projection: Option<&Vec<usize>>,
        _filters: &[Expr],
        _limit: Option<usize>,
    ) -> datafusion::error::Result<Arc<dyn ExecutionPlan>> {
        crate::metrics::observe(&self.name, async {
            let batch = self.fetch().await?.batch()?;
            Ok::<Arc<dyn ExecutionPlan>, _>(MemorySourceConfig::try_new_exec(
                &[vec![batch]],
                self.schema(),
                projection.cloned(),
            )?)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T0: i64 = 1_762_560_000_000_000; // 2025-11-08T00:00:00Z in µs
    const HOUR: i64 = 3_600_000_000;

    fn parse(v: Value) -> Result<Target, DataFusionError> {
        Target::parse(&v.to_string(), T0, T0 + HOUR, T0 + HOUR)
    }

    #[test]
    fn a_grafana_metric_stat_target_is_read() {
        let t = parse(json!({"refId": "A", "id": "", "namespace": "AWS/RDS",
            "metricName": "CPUUtilization",
            "dimensions": {"DBInstanceIdentifier": ["db-1"], "Role": "writer"},
            "statistic": "Average", "period": "300", "metricEditorMode": 0, "matchExact": true,
            "expression": "", "label": "cpu-db-1", "region": "default"}))
        .unwrap();
        assert_eq!(t.id, "queryA");
        assert_eq!(t.period, 300);
        assert_eq!(t.label.as_deref(), Some("cpu-db-1"));
        assert_eq!(t.region, None);
        assert_eq!(
            t.metric,
            TargetMetric::Stat {
                namespace: "AWS/RDS".into(),
                metric_name: "CPUUtilization".into(),
                dimensions: vec![
                    ("DBInstanceIdentifier".into(), "db-1".into()),
                    ("Role".into(), "writer".into())
                ],
                statistic: "Average".into(),
                unit: None,
            }
        );
        let q = t.query();
        assert_eq!(q.id(), Some("queryA"));
        assert_eq!(q.label(), Some("cpu-db-1"));
        let ms = q.metric_stat().unwrap();
        assert_eq!(ms.period(), Some(300));
        assert_eq!(ms.metric().unwrap().dimensions().len(), 2);
        let labels: Value = serde_json::from_str(&t.labels("x")).unwrap();
        assert_eq!(labels["Role"], "writer");
        assert_eq!(labels["label"], "x");
    }

    #[test]
    fn a_grafana_code_mode_target_is_sent_whole() {
        let expr = r#"SEARCH('{AWS/EC2,InstanceId} MetricName="CPUUtilization"', 'Average', 300)"#;
        let t = parse(json!({"refId": "B", "id": "", "expression": expr, "metricEditorMode": 1,
            "metricQueryType": 0, "label": "", "period": "300", "region": "default",
            "namespace": "", "metricName": "", "dimensions": {}, "statistic": "Average"}))
        .unwrap();
        assert_eq!(t.metric, TargetMetric::Expression(expr.into()));
        let q = t.query();
        assert_eq!(q.id(), Some("queryB"));
        assert_eq!(q.expression(), Some(expr));
        assert_eq!(q.period(), Some(300));
        assert_eq!(q.label(), None);
        assert!(q.metric_stat().is_none());
        let labels: Value = serde_json::from_str(&t.labels("i-aaa")).unwrap();
        assert_eq!(labels, json!({"expression": expr, "label": "i-aaa"}));
        // A legacy target without metricEditorMode is code mode when it has an expression.
        let t = parse(json!({"expression": "m1 * 2", "matchExact": false})).unwrap();
        assert_eq!(t.metric, TargetMetric::Expression("m1 * 2".into()));
    }

    #[test]
    fn the_aws_shape_is_the_same_metric_stat_as_the_grafana_target() {
        let aws = parse(json!({"Id": "m1", "MetricStat": {"Metric": {"Namespace": "AWS/EC2",
            "MetricName": "CPUUtilization",
            "Dimensions": [{"Name": "InstanceId", "Value": "i-1"}]},
            "Period": 60, "Stat": "Average"}, "Label": "cpu", "ReturnData": true}))
        .unwrap();
        let grafana = parse(json!({"refId": "A", "id": "m1", "namespace": "AWS/EC2",
            "metricName": "CPUUtilization", "dimensions": {"InstanceId": "i-1"},
            "statistic": "Average", "period": "60", "label": "cpu"}))
        .unwrap();
        assert_eq!(aws, grafana);
        assert_eq!(aws.query(), grafana.query());
        let with_unit = parse(json!({"Id": "m1", "MetricStat": {"Metric": {"Namespace": "N",
            "MetricName": "M"}, "Period": 300, "Stat": "Sum", "Unit": "Count"}}))
        .unwrap();
        let q = with_unit.query();
        assert_eq!(q.metric_stat().unwrap().unit(), Some(&StandardUnit::Count));
        assert_eq!(q.label(), None);

        let e = parse(json!({"Id": "e1", "Expression": "SUM(METRICS())", "Period": 300})).unwrap();
        assert_eq!(e.metric, TargetMetric::Expression("SUM(METRICS())".into()));
        assert_eq!((e.id.as_str(), e.period), ("e1", 300));
        let e = parse(json!({"Id": "Bad-id", "Expression": "m1 * 2"})).unwrap();
        assert_eq!((e.id.as_str(), e.period), ("query", 60));
    }

    #[test]
    fn invalid_aws_shapes_are_errors() {
        let error = |v: Value| parse(v).unwrap_err().to_string();
        let stat = json!({"Metric": {"Namespace": "N", "MetricName": "M"}, "Period": 60,
            "Stat": "Sum"});
        assert!(error(json!({"Id": "m1"})).contains("neither"));
        assert!(error(json!({"Id": "m1", "MetricStat": stat, "Expression": "x"})).contains("both"));
        assert!(error(json!({"MetricStat": "Average"})).contains("JSON object"));
        assert!(error(json!({"MetricStat": {"Period": 60, "Stat": "Sum"}})).contains("Metric"));
        let mut s = stat.clone();
        s.as_object_mut().unwrap().remove("Period");
        assert!(error(json!({"MetricStat": s})).contains("no Period"));
        let mut s = stat.clone();
        s["Stat"] = json!("");
        assert!(error(json!({"MetricStat": s})).contains("no Stat"));
        let mut s = stat.clone();
        s["Metric"]["Dimensions"] = json!({"InstanceId": "i-1"});
        assert!(error(json!({"MetricStat": s})).contains("Dimensions"));
        let mut s = stat.clone();
        s["Metric"]["Dimensions"] = json!([{"Name": "InstanceId"}]);
        assert!(error(json!({"MetricStat": s})).contains("each dimension"));
        assert!(error(json!({"MetricStat": stat, "ReturnData": false})).contains("ReturnData"));
        assert!(error(json!({"MetricStat": stat, "AccountId": "1"})).contains("AccountId"));
    }

    #[test]
    fn ids_periods_and_regions() {
        let base = json!({"namespace": "N", "metricName": "M", "statistic": "Sum"});
        let with = |k: &str, v: Value| {
            let mut t = base.clone();
            t[k] = v;
            parse(t)
        };
        assert_eq!(with("id", json!("m_1")).unwrap().id, "m_1");
        assert_eq!(with("id", json!("Bad")).unwrap().id, "query");
        assert_eq!(with("refId", json!("B")).unwrap().id, "queryB");
        assert_eq!(with("refId", json!("a-b")).unwrap().id, "query");
        assert_eq!(with("period", json!(60)).unwrap().period, 60);
        assert_eq!(with("period", json!("5m")).unwrap().period, 300);
        assert_eq!(with("period", json!("auto")).unwrap().period, 60);
        assert!(with("period", json!("0")).is_err());
        assert!(with("period", json!("1.5s")).is_err());
        assert_eq!(
            with("region", json!("eu-west-1")).unwrap().region.as_deref(),
            Some("eu-west-1")
        );
        assert_eq!(with("label", json!("")).unwrap().label, None);
        let e = with("statistic", json!("")).unwrap_err().to_string();
        assert!(e.contains("statistic"), "{e}");
    }

    #[test]
    fn auto_period_follows_grafana() {
        let day = 24 * HOUR;
        assert_eq!(auto_period(T0, T0 + HOUR, T0 + HOUR), 60);
        assert_eq!(auto_period(T0, T0 + 3 * day, T0 + 3 * day), 300);
        assert_eq!(auto_period(T0, T0 + HOUR, T0 + 30 * day), 300);
        assert_eq!(auto_period(T0, T0 + HOUR, T0 + 100 * day), 3600);
        assert_eq!(auto_period(T0, T0 + HOUR, T0 + 500 * day), 86400);
    }

    #[test]
    fn unsupported_and_invalid_targets_are_errors() {
        let code = |v: Value| match parse(v).unwrap_err() {
            DataFusionError::External(e) => e.to_string(),
            e => e.to_string(),
        };
        let ok = json!({"namespace": "N", "metricName": "M", "statistic": "Sum"});
        let mut t = ok.clone();
        t["metricEditorMode"] = json!(1);
        assert!(code(t).contains("no expression"));
        let mut t = ok.clone();
        t["metricQueryType"] = json!(1);
        assert!(code(t).contains("Metrics Insights"));
        let mut t = ok.clone();
        t["dimensions"] = json!({"A": ["x", "y"]});
        assert!(code(t).contains("multi-value"));
        let mut t = ok.clone();
        t["dimensions"] = json!({"A": "*"});
        assert!(code(t).contains("wildcard"));
        let mut t = ok.clone();
        t["matchExact"] = json!(false);
        assert!(code(t).contains("matchExact"));
        assert!(code(json!({"metricName": "M", "statistic": "Sum"})).contains("namespace"));
        assert!(Target::parse("not json", T0, T0 + HOUR, T0).is_err());
        assert!(Target::parse("[]", T0, T0 + HOUR, T0).is_err());
    }

    #[test]
    fn results_become_rows() {
        let t = parse(json!({"namespace": "N", "metricName": "M", "statistic": "Sum"})).unwrap();
        let result = |label: &str, n: usize| {
            MetricDataResult::builder()
                .id("m")
                .label(label)
                .status_code(StatusCode::Complete)
                .set_timestamps(Some(
                    (0..n)
                        .map(|i| aws_time(T0 + i as i64 * 60_000_000))
                        .collect(),
                ))
                .set_values(Some((0..n).map(|i| i as f64).collect()))
                .build()
        };
        let mut rows = Rows::default();
        rows.add("cw", &t, &result("a", 2), 3).unwrap();
        assert_eq!(rows.series, ["a", "a"]);
        assert_eq!(rows.timestamps[1], T0 + 60_000_000);
        let e = rows.add("cw", &t, &result("b", 2), 3).unwrap_err().to_string();
        assert!(e.contains("result exceeds max_rows (3)"), "{e}");
        let batch = rows.batch().unwrap();
        assert_eq!(batch.num_rows(), 2);
        assert_eq!(micros(&aws_time(T0 + 7)), T0 + 7);
    }
}
