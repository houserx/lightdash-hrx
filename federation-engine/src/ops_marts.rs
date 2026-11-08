//! Ops Marts (CONTRACTS §1.1): the allowlisted BigQuery tables of every `bigquery` source, as the
//! catalog `ops_marts`, one schema per dataset (`ops_marts.<dataset>.<table>`).
//!
//! Only `allow` entries are listed or resolved, so a table outside the allowlist is never named
//! to BigQuery. A table's columns come from BigQuery's `tables.get` the first time the table is
//! resolved (planning a query on it, or reading `information_schema.columns`), and are cached
//! for [`SCHEMA_TTL`]. Listing tables (`information_schema.tables`) needs no BigQuery call.
//!
//! Reading a table runs `SELECT <projected columns> FROM <table> [LIMIT n]` with `jobs.query` and
//! reads every result page with `jobs.getQueryResults`; filters, aggregates and joins run in the
//! engine. Every call carries the source's bearer token: `access_token_env`, or else a
//! service-account token from workload identity federation ([`crate::gcp_auth`]).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use datafusion::arrow::array::{ArrayRef, StringArray};
use datafusion::arrow::compute::{CastOptions, cast_with_options};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
use datafusion::arrow::error::ArrowError;
use datafusion::arrow::record_batch::{RecordBatch, RecordBatchOptions};
use datafusion::catalog::memory::MemorySourceConfig;
use datafusion::catalog::{CatalogProvider, SchemaProvider, Session, TableProvider};
use datafusion::error::DataFusionError;
use datafusion::logical_expr::{Expr, TableType};
use datafusion::physical_plan::ExecutionPlan;
use engine_config::{BigQueryAuth, BigQuerySettings, Config, Secret, SourceSettings};
use serde_json::{Value, json};

use crate::gcp_auth::WorkloadIdentity;
use crate::session::sqlstate;

/// The catalog name Ops Marts appear under.
pub const CATALOG: &str = "ops_marts";

/// How long a table's BigQuery schema is reused before `tables.get` is asked again.
const SCHEMA_TTL: Duration = Duration::from_secs(300);

/// One `bigquery` source: where its API is, how calls authenticate, and its row cap.
#[derive(Debug)]
struct BigQuerySource {
    name: String,
    project: String,
    /// `api_base_url` without a trailing `/`.
    api_base_url: String,
    auth: Auth,
    /// More rows than this is an error (SQLSTATE 54000), never a silent truncation.
    max_rows: usize,
}

/// How a source's BigQuery calls get their bearer token.
#[derive(Debug)]
enum Auth {
    /// `access_token_env`.
    Static(Secret),
    /// Workload identity federation from the engine's AWS identity, cached.
    Federated(Box<WorkloadIdentity>),
}

impl BigQuerySource {
    /// The bearer token for BigQuery calls.
    async fn token(&self, http: &reqwest::Client) -> Result<String, DataFusionError> {
        match &self.auth {
            Auth::Static(secret) => Ok(secret.expose().to_string()),
            Auth::Federated(federation) => federation.token(http).await.map_err(|e| {
                DataFusionError::Execution(format!("bigquery source \"{}\": {e}", self.name))
            }),
        }
    }
}

/// An allowlisted table and the source that serves it.
#[derive(Debug, Clone)]
struct MartTable {
    source: Arc<BigQuerySource>,
    dataset: String,
    table: String,
}

/// Shared by the catalog, its schemas and tables: the HTTP client and the schema cache.
#[derive(Debug)]
struct Marts {
    http: reqwest::Client,
    /// Table by name, by dataset (both as written in `allow`, case-sensitive).
    datasets: BTreeMap<String, BTreeMap<String, MartTable>>,
    /// Fetched schemas by (dataset, table), with when they were fetched.
    schemas: Mutex<HashMap<(String, String), (Instant, SchemaRef)>>,
}

impl Marts {
    /// The table's schema: cached, or from BigQuery `tables.get`.
    async fn schema(&self, t: &MartTable) -> Result<SchemaRef, DataFusionError> {
        let key = (t.dataset.clone(), t.table.clone());
        if let Some((at, schema)) = self.schemas.lock().unwrap().get(&key)
            && at.elapsed() < SCHEMA_TTL
        {
            return Ok(schema.clone());
        }
        let schema = Arc::new(self.fetch_schema(t).await?);
        self.schemas
            .lock()
            .unwrap()
            .insert(key, (Instant::now(), schema.clone()));
        Ok(schema)
    }

    async fn fetch_schema(&self, t: &MartTable) -> Result<Schema, DataFusionError> {
        let url = t.api_url(&["datasets", &t.dataset, "tables", &t.table])?;
        let answer = self.call(t, self.http.get(url)).await?;
        let fields = answer["schema"]["fields"]
            .as_array()
            .ok_or_else(|| t.fail("the table has no schema.fields"))?;
        Ok(Schema::new(
            fields.iter().map(arrow_field).collect::<Vec<_>>(),
        ))
    }

    /// Sends one BigQuery API call with the source's bearer and returns its JSON answer. A
    /// non-2xx answer is an error carrying BigQuery's message.
    async fn call(
        &self,
        t: &MartTable,
        request: reqwest::RequestBuilder,
    ) -> Result<Value, DataFusionError> {
        let response = request
            .bearer_auth(t.source.token(&self.http).await?)
            .send()
            .await
            .map_err(|e| t.fail(format!("BigQuery is unreachable: {e}")))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|e| t.fail(format!("reading the response failed: {e}")))?;
        let answer: Value = serde_json::from_slice(&body)
            .map_err(|_| t.fail(format!("HTTP {status} with a response that is not JSON")))?;
        if !status.is_success() {
            let message = answer["error"]["message"]
                .as_str()
                .unwrap_or("no error message");
            return Err(t.fail(format!("HTTP {status}: {message}")));
        }
        Ok(answer)
    }

    /// Reads `columns` of every row of the table (at most `limit` rows) with `jobs.query`, then
    /// `jobs.getQueryResults` until BigQuery has no next page. Filters, aggregates and joins run
    /// in the engine. More than the source's `max_rows` rows fails with SQLSTATE 54000.
    async fn read(
        &self,
        t: &MartTable,
        columns: &Schema,
        limit: Option<usize>,
    ) -> Result<RecordBatch, DataFusionError> {
        let source = &t.source;
        let sql = select_sql(&source.project, t, columns, limit);
        let mut answer = self
            .call(
                t,
                self.http.post(t.api_url(&["queries"])?).json(&json!({
                    "query": sql,
                    "useLegacySql": false,
                    "formatOptions": {"useInt64Timestamp": true},
                })),
            )
            .await?;
        let mut cells: Vec<Vec<Option<String>>> = vec![Vec::new(); columns.fields().len()];
        let mut rows = 0usize;
        loop {
            let complete = answer["jobComplete"].as_bool().unwrap_or(false);
            if complete {
                rows += add_page(t, columns, &answer, &mut cells)?;
                if rows > source.max_rows {
                    return Err(sqlstate(
                        "54000",
                        format!(
                            "result exceeds max_rows ({}) for source \"{}\"",
                            source.max_rows, source.name
                        ),
                    ));
                }
            }
            let page_token = answer["pageToken"].as_str().filter(|s| !s.is_empty());
            if complete && page_token.is_none() {
                break;
            }
            let job = &answer["jobReference"];
            let job_id = job["jobId"]
                .as_str()
                .ok_or_else(|| t.fail("the query answer has no jobReference.jobId"))?;
            let mut query = vec![("formatOptions.useInt64Timestamp", "true".to_string())];
            if let Some(location) = job["location"].as_str() {
                query.push(("location", location.to_string()));
            }
            // An incomplete job is asked again without a page token: getQueryResults waits for it.
            if let Some(token) = page_token.filter(|_| complete) {
                query.push(("pageToken", token.to_string()));
            }
            let url = t.api_url(&["queries", job_id])?;
            answer = self.call(t, self.http.get(url).query(&query)).await?;
        }
        let arrays = columns
            .fields()
            .iter()
            .zip(cells)
            .map(|(field, cells)| column_array(t, field, cells))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(RecordBatch::try_new_with_options(
            Arc::new(columns.clone()),
            arrays,
            &RecordBatchOptions::new().with_row_count(Some(rows)),
        )?)
    }
}

impl MartTable {
    /// A failure reading this table, naming the source and the table.
    fn fail(&self, what: impl std::fmt::Display) -> DataFusionError {
        DataFusionError::Execution(format!(
            "bigquery source \"{}\": table {}.{}: {what}",
            self.source.name, self.dataset, self.table
        ))
    }

    /// `{api_base_url}/bigquery/v2/projects/{project}/{path...}`, each segment escaped.
    fn api_url(&self, path: &[&str]) -> Result<reqwest::Url, DataFusionError> {
        let source = &self.source;
        let mut url = reqwest::Url::parse(&source.api_base_url)
            .map_err(|e| self.fail(format!("api_base_url is not a URL: {e}")))?;
        url.path_segments_mut()
            .map_err(|()| self.fail("api_base_url cannot take a path"))?
            .pop_if_empty()
            .extend(["bigquery", "v2", "projects", &source.project])
            .extend(path);
        Ok(url)
    }
}

/// The GoogleSQL statement reading `columns` of the table, with every name quoted.
fn select_sql(project: &str, t: &MartTable, columns: &Schema, limit: Option<usize>) -> String {
    let quote = |name: &str| format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`"));
    let list = columns
        .fields()
        .iter()
        .map(|f| quote(f.name()))
        .collect::<Vec<_>>()
        .join(", ");
    let table = quote(&format!("{project}.{}.{}", t.dataset, t.table));
    let mut sql = format!("SELECT {list} FROM {table}");
    if let Some(n) = limit {
        sql.push_str(&format!(" LIMIT {n}"));
    }
    sql
}

/// Appends one result page's cells to `cells` (one list per wanted column), matching result
/// columns by name. Returns the page's row count.
fn add_page(
    t: &MartTable,
    columns: &Schema,
    answer: &Value,
    cells: &mut [Vec<Option<String>>],
) -> Result<usize, DataFusionError> {
    let Some(rows) = answer["rows"].as_array() else {
        return Ok(0);
    };
    let names: Vec<&str> = answer["schema"]["fields"]
        .as_array()
        .ok_or_else(|| t.fail("the query answer has no schema.fields"))?
        .iter()
        .map(|f| f["name"].as_str().unwrap_or_default())
        .collect();
    let positions = columns
        .fields()
        .iter()
        .map(|f| {
            names
                .iter()
                .position(|n| n == f.name())
                .ok_or_else(|| t.fail(format!("the query answer has no column {}", f.name())))
        })
        .collect::<Result<Vec<_>, _>>()?;
    for row in rows {
        let row = row["f"]
            .as_array()
            .ok_or_else(|| t.fail("a result row has no cells"))?;
        for (out, &at) in cells.iter_mut().zip(&positions) {
            out.push(match row.get(at).map(|c| &c["v"]) {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                // REPEATED and RECORD cells: their JSON, as text.
                Some(other) => Some(other.to_string()),
            });
        }
    }
    Ok(rows.len())
}

/// One column of BigQuery cells as the field's Arrow type. TIMESTAMP cells are int64
/// microseconds (`formatOptions.useInt64Timestamp`); the other types parse from BigQuery's text.
fn column_array(
    t: &MartTable,
    field: &Field,
    cells: Vec<Option<String>>,
) -> Result<ArrayRef, DataFusionError> {
    let text: ArrayRef = Arc::new(StringArray::from(cells));
    let strict = CastOptions {
        safe: false,
        ..Default::default()
    };
    let bad = |e: ArrowError| t.fail(format!("column {}: {e}", field.name()));
    match field.data_type() {
        DataType::Utf8 => Ok(text),
        DataType::Timestamp(TimeUnit::Microsecond, Some(_)) => {
            let micros = cast_with_options(&text, &DataType::Int64, &strict).map_err(bad)?;
            cast_with_options(&micros, field.data_type(), &strict).map_err(bad)
        }
        other => cast_with_options(&text, other, &strict).map_err(bad),
    }
}

/// A BigQuery schema field as an Arrow field. Columns are nullable unless their mode is
/// `REQUIRED`. Scalar types map as CONTRACTS §1 wants them on the wire (TIMESTAMP is
/// timestamptz, DATETIME timestamp); `REPEATED` and `RECORD` columns, and types with no closer
/// Postgres type, are text.
fn arrow_field(field: &Value) -> Field {
    let name = field["name"].as_str().unwrap_or_default();
    let mode = field["mode"].as_str().unwrap_or("NULLABLE");
    let ty = field["type"].as_str().unwrap_or_default();
    let data_type = if mode == "REPEATED" {
        DataType::Utf8
    } else {
        bigquery_type(ty)
    };
    Field::new(name, data_type, mode != "REQUIRED")
}

/// The Arrow type of a BigQuery column type (legacy or standard SQL name).
fn bigquery_type(ty: &str) -> DataType {
    match ty {
        "INTEGER" | "INT64" => DataType::Int64,
        "FLOAT" | "FLOAT64" => DataType::Float64,
        "BOOLEAN" | "BOOL" => DataType::Boolean,
        "TIMESTAMP" => DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
        "DATETIME" => DataType::Timestamp(TimeUnit::Microsecond, None),
        "DATE" => DataType::Date32,
        "NUMERIC" => DataType::Decimal128(38, 9),
        _ => DataType::Utf8,
    }
}

/// The `ops_marts` catalog, or `None` when no `bigquery` source allows a table.
pub fn catalog(config: &Config, http: reqwest::Client) -> Option<Arc<dyn CatalogProvider>> {
    let mut datasets: BTreeMap<String, BTreeMap<String, MartTable>> = BTreeMap::new();
    for s in &config.sources {
        let SourceSettings::Bigquery(BigQuerySettings {
            project,
            allow,
            api_base_url,
            auth,
        }) = &s.settings
        else {
            continue;
        };
        let source = Arc::new(BigQuerySource {
            name: s.name.clone(),
            project: project.clone(),
            api_base_url: api_base_url.trim_end_matches('/').to_string(),
            auth: match auth {
                BigQueryAuth::StaticToken(secret) => Auth::Static(secret.clone()),
                BigQueryAuth::WorkloadIdentity {
                    audience,
                    service_account,
                    sts_url,
                    iam_credentials_url,
                } => Auth::Federated(Box::new(WorkloadIdentity::new(
                    audience,
                    service_account,
                    sts_url,
                    iam_credentials_url,
                ))),
            },
            max_rows: usize::try_from(s.max_rows.unwrap_or(config.max_rows)).unwrap_or(usize::MAX),
        });
        for entry in allow {
            // The config check guarantees `dataset.table`.
            let Some((dataset, table)) = entry.split_once('.') else {
                continue;
            };
            // The first source to allow a table serves it.
            datasets
                .entry(dataset.to_string())
                .or_default()
                .entry(table.to_string())
                .or_insert_with(|| MartTable {
                    source: source.clone(),
                    dataset: dataset.to_string(),
                    table: table.to_string(),
                });
        }
    }
    if datasets.is_empty() {
        return None;
    }
    Some(Arc::new(OpsMarts(Arc::new(Marts {
        http,
        datasets,
        schemas: Mutex::new(HashMap::new()),
    }))))
}

#[derive(Debug)]
struct OpsMarts(Arc<Marts>);

impl CatalogProvider for OpsMarts {
    fn schema_names(&self) -> Vec<String> {
        self.0.datasets.keys().cloned().collect()
    }

    fn schema(&self, name: &str) -> Option<Arc<dyn SchemaProvider>> {
        self.0.datasets.contains_key(name).then(|| {
            Arc::new(Dataset {
                marts: self.0.clone(),
                name: name.to_string(),
            }) as Arc<dyn SchemaProvider>
        })
    }
}

/// One BigQuery dataset's allowlisted tables.
#[derive(Debug)]
struct Dataset {
    marts: Arc<Marts>,
    name: String,
}

impl Dataset {
    fn tables(&self) -> &BTreeMap<String, MartTable> {
        &self.marts.datasets[&self.name]
    }
}

#[async_trait]
impl SchemaProvider for Dataset {
    fn table_names(&self) -> Vec<String> {
        self.tables().keys().cloned().collect()
    }

    async fn table(&self, name: &str) -> Result<Option<Arc<dyn TableProvider>>, DataFusionError> {
        let Some(t) = self.tables().get(name) else {
            return Ok(None);
        };
        let schema = self.marts.schema(t).await?;
        Ok(Some(Arc::new(OpsMartTable {
            marts: self.marts.clone(),
            table: t.clone(),
            schema,
        })))
    }

    /// Listing tables needs no schema, so no BigQuery call.
    async fn table_type(&self, name: &str) -> Result<Option<TableType>, DataFusionError> {
        Ok(self.tables().contains_key(name).then_some(TableType::Base))
    }

    fn table_exist(&self, name: &str) -> bool {
        self.tables().contains_key(name)
    }
}

/// An allowlisted table with its BigQuery schema.
#[derive(Debug)]
struct OpsMartTable {
    marts: Arc<Marts>,
    table: MartTable,
    schema: SchemaRef,
}

#[async_trait]
impl TableProvider for OpsMartTable {
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }

    fn table_type(&self) -> TableType {
        TableType::Base
    }

    /// Reads the projected columns of every row from BigQuery (filters stay in the engine, so a
    /// pushed-down `limit` is safe to send). With no column wanted (e.g. `count(*)`), the first
    /// column is read for its row count only.
    async fn scan(
        &self,
        _state: &dyn Session,
        projection: Option<&Vec<usize>>,
        _filters: &[Expr],
        limit: Option<usize>,
    ) -> datafusion::error::Result<Arc<dyn ExecutionPlan>> {
        let (wanted, output) = match projection {
            Some(p) if p.is_empty() => (vec![0], Some(vec![])),
            Some(p) => (p.clone(), None),
            None => ((0..self.schema.fields().len()).collect(), None),
        };
        if self.schema.fields().is_empty() {
            return Err(self.table.fail("the table has no columns"));
        }
        let columns = self.schema.project(&wanted)?;
        let batch = self.marts.read(&self.table, &columns, limit).await?;
        Ok(MemorySourceConfig::try_new_exec(
            &[vec![batch]],
            Arc::new(columns),
            output,
        )?)
    }
}

#[cfg(test)]
mod tests {
    use datafusion::arrow::array::{Array, AsArray};
    use datafusion::arrow::datatypes::{Float64Type, TimestampMicrosecondType};

    use super::*;

    #[test]
    fn bigquery_fields_map_to_postgres_shaped_arrow_types() {
        let field = |name: &str, ty: &str, mode: &str| {
            arrow_field(&json!({"name": name, "type": ty, "mode": mode}))
        };
        let ts = DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into()));
        assert_eq!(field("hour", "TIMESTAMP", "NULLABLE").data_type(), &ts);
        assert_eq!(
            field("p", "STRING", "NULLABLE").data_type(),
            &DataType::Utf8
        );
        assert_eq!(
            field("n", "INTEGER", "NULLABLE").data_type(),
            &DataType::Int64
        );
        assert_eq!(
            field("n", "INT64", "NULLABLE").data_type(),
            &DataType::Int64
        );
        assert_eq!(
            field("f", "FLOAT", "NULLABLE").data_type(),
            &DataType::Float64
        );
        assert_eq!(
            field("b", "BOOLEAN", "NULLABLE").data_type(),
            &DataType::Boolean
        );
        assert_eq!(
            field("d", "DATE", "NULLABLE").data_type(),
            &DataType::Date32
        );
        assert_eq!(
            field("t", "DATETIME", "NULLABLE").data_type(),
            &DataType::Timestamp(TimeUnit::Microsecond, None)
        );
        assert_eq!(field("r", "INT64", "REPEATED").data_type(), &DataType::Utf8);
        assert_eq!(
            field("g", "GEOGRAPHY", "NULLABLE").data_type(),
            &DataType::Utf8
        );
        assert!(field("x", "STRING", "NULLABLE").is_nullable());
        assert!(!field("x", "STRING", "REQUIRED").is_nullable());
        assert!(arrow_field(&json!({"name": "x", "type": "STRING"})).is_nullable());
    }

    fn mart_table() -> MartTable {
        MartTable {
            source: Arc::new(BigQuerySource {
                name: "ops-marts".into(),
                project: "p-1".into(),
                api_base_url: "http://127.0.0.1:1".into(),
                auth: Auth::Federated(Box::new(WorkloadIdentity::new("", "", "", ""))),
                max_rows: 10,
            }),
            dataset: "ops_marts".into(),
            table: "fills_hourly".into(),
        }
    }

    /// Only `allow` entries resolve, by exact (case-sensitive) dataset and table name, and
    /// resolving anything else answers "no such table" without a BigQuery call (the API base URL
    /// is unroutable, so a call would error instead of returning `None`).
    #[tokio::test]
    async fn only_allowlisted_tables_resolve() {
        let config = Config::from_toml(
            r#"
listen_pg = "127.0.0.1:1"
listen_http = "127.0.0.1:2"
identity_secret_env = "SECRET"
[[users]]
name = "u"
password_env = "PW"
[[sources]]
name = "ops-marts"
kind = "bigquery"
project = "p-1"
allow = ["ops_marts.fills_hourly", "ops_marts.queue_depth"]
api_base_url = "http://127.0.0.1:1"
access_token_env = "TOKEN"
"#,
            |_| Some("0123456789abcdef0123456789abcdef".into()),
        )
        .expect("config");
        let catalog = catalog(&config, reqwest::Client::new()).expect("ops_marts catalog");
        assert_eq!(catalog.schema_names(), vec!["ops_marts".to_string()]);
        for dataset in ["other_dataset", "OPS_MARTS", "Ops_Marts"] {
            assert!(catalog.schema(dataset).is_none(), "{dataset}");
        }
        let schema = catalog.schema("ops_marts").expect("allowlisted dataset");
        assert_eq!(schema.table_names(), vec!["fills_hourly", "queue_depth"]);
        for table in [
            "not_allowlisted",
            "FILLS_HOURLY",
            "Fills_Hourly",
            "fills_hourly ",
        ] {
            assert!(!schema.table_exist(table), "{table}");
            assert!(schema.table_type(table).await.unwrap().is_none(), "{table}");
            assert!(schema.table(table).await.unwrap().is_none(), "{table}");
        }
        assert!(schema.table_exist("fills_hourly"));
    }

    #[test]
    fn select_sql_quotes_names_and_sends_the_limit() {
        let t = mart_table();
        let columns = Schema::new(vec![
            Field::new("hour", DataType::Utf8, true),
            Field::new("we`ird", DataType::Utf8, true),
        ]);
        assert_eq!(
            select_sql("p-1", &t, &columns, None),
            "SELECT `hour`, `we\\`ird` FROM `p-1.ops_marts.fills_hourly`"
        );
        assert!(select_sql("p-1", &t, &columns, Some(5)).ends_with(" LIMIT 5"));
    }

    #[test]
    fn cells_parse_into_the_column_types() {
        let t = mart_table();
        let cells = |v: &[Option<&str>]| v.iter().map(|c| c.map(str::to_string)).collect();
        let ts = Field::new(
            "hour",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            true,
        );
        let a = column_array(&t, &ts, cells(&[Some("1762588800000000"), None])).unwrap();
        let a = a.as_primitive::<TimestampMicrosecondType>();
        assert_eq!(a.value(0), 1_762_588_800_000_000);
        assert!(a.is_null(1));
        let f = Field::new("f", DataType::Float64, true);
        let a = column_array(&t, &f, cells(&[Some("20.25"), None])).unwrap();
        assert_eq!(a.as_primitive::<Float64Type>().value(0), 20.25);
        assert!(a.is_null(1));
        let b = Field::new("b", DataType::Boolean, true);
        let a = column_array(&t, &b, cells(&[Some("true"), Some("false")])).unwrap();
        assert!(a.as_boolean().value(0) && !a.as_boolean().value(1));
        let n = Field::new("n", DataType::Int64, true);
        let e = column_array(&t, &n, cells(&[Some("x")])).unwrap_err();
        assert!(e.to_string().contains("column n"), "{e}");
    }

    #[test]
    fn pages_map_result_columns_by_name() {
        let t = mart_table();
        let columns = Schema::new(vec![Field::new("b", DataType::Utf8, true)]);
        let answer = json!({
            "schema": {"fields": [{"name": "a"}, {"name": "b"}]},
            "rows": [{"f": [{"v": "1"}, {"v": "x"}]}, {"f": [{"v": "2"}, {"v": null}]}]
        });
        let mut cells = vec![Vec::new()];
        assert_eq!(add_page(&t, &columns, &answer, &mut cells).unwrap(), 2);
        assert_eq!(cells, vec![vec![Some("x".to_string()), None]]);
    }
}
