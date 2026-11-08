//! `cloudwatch_logs(log_groups text, query text, start, end[, source])` (CONTRACTS §1.1): one
//! CloudWatch Logs Insights query as `timestamp timestamptz, message text, fields json`, one row
//! per result.
//!
//! `log_groups` is comma-separated; each name is trimmed and empty ones are dropped. `query` is
//! Logs Insights and goes to `StartQuery` unchanged, with the range as epoch seconds (`start`
//! rounded down, `end` up). `GetQueryResults` is then polled every `poll_interval_ms` of the source
//! until the query leaves `Scheduled`/`Running`. `Complete` gives the rows; any other final status
//! is an error naming it. Following contract assumption A20, `timestamp` is `@timestamp` read as
//! UTC, `message` is `@message` (either NULL when the result lacks it), and `fields` is a JSON
//! object of every result field except `@ptr`.
//!
//! Requests are signed with SigV4 by the AWS SDK as for `cloudwatch()`: the default credential
//! chain in the source's region, at its `endpoint_url` when one is set, through an assumed role
//! when the source has `role_arn`. The arguments are constants checked when the statement is
//! planned, and Logs Insights is asked when the table is scanned.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use aws_sdk_cloudwatchlogs::error::{DisplayErrorContext, ProvideErrorMetadata};
use aws_sdk_cloudwatchlogs::types::{QueryStatus, ResultField};
use datafusion::arrow::array::{ArrayRef, StringBuilder, TimestampMicrosecondBuilder};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
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
use crate::promql::{EXTENSION_NAME_KEY, JSON_EXTENSION, UTC, constant, text_argument, time_argument};
use crate::session::sqlstate;
use crate::sources::HttpSources;

const SIGNATURE: &str = "cloudwatch_logs(log_groups, query, start, end[, source])";

/// The result columns of `cloudwatch_logs`.
pub fn logs_schema() -> SchemaRef {
    let json = HashMap::from([(EXTENSION_NAME_KEY.to_string(), JSON_EXTENSION.to_string())]);
    Arc::new(Schema::new(vec![
        Field::new(
            "timestamp",
            DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())),
            true,
        ),
        Field::new("message", DataType::Utf8, true),
        Field::new("fields", DataType::Utf8, false).with_metadata(json),
    ]))
}

/// A configured `cloudwatch_logs` source.
#[derive(Debug, Clone)]
struct LogsSource {
    aws: AwsSettings,
    poll_interval: Duration,
    /// The SDK client, built on first use (loading the credential chain is async).
    client: Arc<OnceCell<aws_sdk_cloudwatchlogs::Client>>,
}

/// The configured CloudWatch Logs sources.
#[derive(Debug, Clone)]
pub struct CloudwatchLogs {
    sources: HttpSources,
    settings: HashMap<String, LogsSource>,
    connect_timeout: Duration,
}

impl CloudwatchLogs {
    pub fn new(config: &Config, connect_timeout: Duration) -> CloudwatchLogs {
        let settings = config
            .sources
            .iter()
            .filter_map(|s| match &s.settings {
                SourceSettings::CloudwatchLogs {
                    aws,
                    poll_interval_ms,
                    ..
                } => Some((
                    s.name.clone(),
                    LogsSource {
                        aws: aws.clone(),
                        poll_interval: Duration::from_millis(*poll_interval_ms),
                        client: Arc::default(),
                    },
                )),
                _ => None,
            })
            .collect();
        CloudwatchLogs {
            sources: HttpSources::new(config, SourceKind::CloudwatchLogs),
            settings,
            connect_timeout,
        }
    }
}

impl TableFunctionImpl for CloudwatchLogs {
    fn call_with_args(
        &self,
        args: TableFunctionArgs,
    ) -> datafusion::error::Result<Arc<dyn TableProvider>> {
        let exprs = args.exprs();
        if !(4..=5).contains(&exprs.len()) {
            return Err(sqlstate(
                "42883",
                format!("{SIGNATURE} takes 4 or 5 arguments, not {}", exprs.len()),
            ));
        }
        let session = args.session();
        let arg = |i: usize| constant(&exprs[i], session, SIGNATURE);
        let log_groups = log_group_names(&text_argument(arg(0)?, "log_groups", SIGNATURE)?)?;
        let query = text_argument(arg(1)?, "query", SIGNATURE)?;
        if query.trim().is_empty() {
            return Err(sqlstate("22023", format!("{SIGNATURE}: query is empty")));
        }
        let start = time_argument(arg(2)?, "start", SIGNATURE)?;
        let end = time_argument(arg(3)?, "end", SIGNATURE)?;
        if end <= start {
            return Err(sqlstate("22023", format!("{SIGNATURE}: end must be after start")));
        }
        let source = match exprs.get(4) {
            Some(_) => Some(text_argument(arg(4)?, "source", SIGNATURE)?),
            None => None,
        };
        let (name, max_rows) = self.sources.pick(source)?;
        Ok(Arc::new(LogsQuery {
            source: self.settings[&name].clone(),
            connect_timeout: self.connect_timeout,
            name,
            max_rows,
            log_groups,
            query,
            start: start.div_euclid(1_000_000),
            end: end.div_euclid(1_000_000) + i64::from(end.rem_euclid(1_000_000) != 0),
        }))
    }
}

/// The comma-separated log group names, trimmed, without empty ones; at least one.
fn log_group_names(text: &str) -> Result<Vec<String>, DataFusionError> {
    let names: Vec<String> = text
        .split(',')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(String::from)
        .collect();
    if names.is_empty() {
        return Err(sqlstate(
            "22023",
            format!("{SIGNATURE}: log_groups names no log group"),
        ));
    }
    Ok(names)
}

/// One `cloudwatch_logs()` call: the query to start and where.
#[derive(Debug)]
struct LogsQuery {
    source: LogsSource,
    connect_timeout: Duration,
    name: String,
    max_rows: usize,
    log_groups: Vec<String>,
    query: String,
    /// Epoch seconds.
    start: i64,
    end: i64,
}

impl LogsQuery {
    async fn client(&self) -> &aws_sdk_cloudwatchlogs::Client {
        let aws = &self.source.aws;
        self.source
            .client
            .get_or_init(|| async {
                let shared = aws::shared_config(aws, self.connect_timeout).await;
                let mut config = aws_sdk_cloudwatchlogs::config::Builder::from(&shared);
                if let Some(url) = &aws.endpoint_url {
                    config = config.endpoint_url(url);
                }
                if let Some(role) = &aws.role_arn {
                    let provider = aws::assume_role(&shared, role, aws).await;
                    config = config.credentials_provider(provider);
                }
                aws_sdk_cloudwatchlogs::Client::from_conf(config.build())
            })
            .await
    }

    fn failed<E: ProvideErrorMetadata + std::error::Error + 'static, R: std::fmt::Debug>(
        &self,
        operation: &str,
        e: aws_sdk_cloudwatchlogs::error::SdkError<E, R>,
    ) -> DataFusionError {
        let what = match e.as_service_error() {
            Some(se) => format!(
                "{}: {}",
                se.code().unwrap_or("error"),
                se.message().unwrap_or("no error message")
            ),
            None => DisplayErrorContext(&e).to_string(),
        };
        DataFusionError::Execution(format!(
            "cloudwatch_logs source \"{}\": {operation} failed: {what}",
            self.name
        ))
    }

    /// Starts the query and polls until it is no longer scheduled or running.
    async fn fetch(&self) -> Result<RecordBatch, DataFusionError> {
        let client = self.client().await;
        let started = client
            .start_query()
            .set_log_group_names(Some(self.log_groups.clone()))
            .query_string(&self.query)
            .start_time(self.start)
            .end_time(self.end)
            .send()
            .await
            .map_err(|e| self.failed("StartQuery", e))?;
        let Some(id) = started.query_id() else {
            return Err(DataFusionError::Execution(format!(
                "cloudwatch_logs source \"{}\": StartQuery returned no queryId",
                self.name
            )));
        };
        loop {
            let page = client
                .get_query_results()
                .query_id(id)
                .send()
                .await
                .map_err(|e| self.failed("GetQueryResults", e))?;
            match page.status() {
                Some(QueryStatus::Scheduled | QueryStatus::Running) => {
                    tokio::time::sleep(self.source.poll_interval).await;
                }
                Some(QueryStatus::Complete) => {
                    return results_batch(&self.name, page.results(), self.max_rows);
                }
                other => {
                    let status = other.map_or("missing", QueryStatus::as_str);
                    return Err(DataFusionError::Execution(format!(
                        "cloudwatch_logs source \"{}\": Logs Insights query {id} ended with \
                         status {status}",
                        self.name
                    )));
                }
            }
        }
    }
}

/// A Logs Insights `@timestamp` (`2025-11-08 00:00:01.250`, UTC) as µs since the Unix epoch.
fn parse_timestamp(text: &str) -> Option<i64> {
    let text = text.trim();
    chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f")
        .map(|t| t.and_utc())
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(text).map(|t| t.to_utc()))
        .ok()
        .map(|t| t.timestamp_micros())
}

/// The rows of a complete query. More than `max_rows` results fails with SQLSTATE 54000.
fn results_batch(
    source: &str,
    results: &[Vec<ResultField>],
    max_rows: usize,
) -> Result<RecordBatch, DataFusionError> {
    if results.len() > max_rows {
        return Err(sqlstate(
            "54000",
            format!("result exceeds max_rows ({max_rows}) for source \"{source}\""),
        ));
    }
    let mut timestamps = TimestampMicrosecondBuilder::new().with_timezone(UTC);
    let mut messages = StringBuilder::new();
    let mut fields = StringBuilder::new();
    for row in results {
        let mut object = Map::new();
        let (mut timestamp, mut message) = (None, None);
        for f in row {
            let (Some(field), Some(value)) = (f.field(), f.value()) else {
                continue;
            };
            match field {
                "@ptr" => continue,
                "@timestamp" => timestamp = parse_timestamp(value),
                "@message" => message = Some(value),
                _ => {}
            }
            object.insert(field.to_string(), Value::String(value.to_string()));
        }
        timestamps.append_option(timestamp);
        messages.append_option(message);
        fields.append_value(Value::Object(object).to_string());
    }
    let columns: Vec<ArrayRef> = vec![
        Arc::new(timestamps.finish()),
        Arc::new(messages.finish()),
        Arc::new(fields.finish()),
    ];
    Ok(RecordBatch::try_new(logs_schema(), columns)?)
}

#[async_trait]
impl TableProvider for LogsQuery {
    fn schema(&self) -> SchemaRef {
        logs_schema()
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
        let batch = self.fetch().await?;
        Ok(MemorySourceConfig::try_new_exec(
            &[vec![batch]],
            self.schema(),
            projection.cloned(),
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use datafusion::arrow::array::{Array, StringArray, TimestampMicrosecondArray};

    const T0: i64 = 1_762_560_000_000_000; // 2025-11-08T00:00:00Z in µs

    fn field(f: &str, v: &str) -> ResultField {
        ResultField::builder().field(f).value(v).build()
    }

    #[test]
    fn log_groups_are_split_and_trimmed() {
        assert_eq!(
            log_group_names(" /aws/lambda/a, /aws/lambda/b ,").unwrap(),
            ["/aws/lambda/a", "/aws/lambda/b"]
        );
        assert!(log_group_names(" , ").is_err());
    }

    #[test]
    fn timestamps_are_utc() {
        assert_eq!(parse_timestamp("2025-11-08 00:00:01.250"), Some(T0 + 1_250_000));
        assert_eq!(parse_timestamp("2025-11-08 00:00:02"), Some(T0 + 2_000_000));
        assert_eq!(parse_timestamp("2025-11-08T01:00:00+01:00"), Some(T0));
        assert_eq!(parse_timestamp("yesterday"), None);
    }

    #[test]
    fn results_become_rows() {
        let results = vec![
            vec![
                field("@timestamp", "2025-11-08 00:00:01.250"),
                field("@message", "first"),
                field("level", "error"),
                field("@ptr", "p"),
            ],
            vec![field("count", "3")],
        ];
        let batch = results_batch("logs", &results, 2).unwrap();
        assert_eq!(batch.num_rows(), 2);
        let ts = batch.column(0).as_any().downcast_ref::<TimestampMicrosecondArray>().unwrap();
        assert_eq!(ts.value(0), T0 + 1_250_000);
        assert!(ts.is_null(1));
        let messages = batch.column(1).as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(messages.value(0), "first");
        assert!(messages.is_null(1));
        let fields = batch.column(2).as_any().downcast_ref::<StringArray>().unwrap();
        let first: Value = serde_json::from_str(fields.value(0)).unwrap();
        assert_eq!(
            first,
            serde_json::json!({"@timestamp": "2025-11-08 00:00:01.250", "@message": "first",
                "level": "error"})
        );
        let e = results_batch("logs", &results, 1).unwrap_err().to_string();
        assert!(e.contains("result exceeds max_rows (1)"), "{e}");
    }
}
