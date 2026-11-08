//! Ops Marts (CONTRACTS §1.1): the allowlisted BigQuery tables of every `bigquery` source, as the
//! catalog `ops_marts`, one schema per dataset (`ops_marts.<dataset>.<table>`).
//!
//! Only `allow` entries are listed or resolved, so a table outside the allowlist is never named
//! to BigQuery. A table's columns come from BigQuery's `tables.get` the first time the table is
//! resolved (planning a query on it, or reading `information_schema.columns`), and are cached
//! for [`SCHEMA_TTL`]. Listing tables (`information_schema.tables`) needs no BigQuery call.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
use datafusion::catalog::{CatalogProvider, SchemaProvider, Session, TableProvider};
use datafusion::error::DataFusionError;
use datafusion::logical_expr::{Expr, TableType};
use datafusion::physical_plan::ExecutionPlan;
use engine_config::{BigQueryAuth, BigQuerySettings, Config, SourceSettings};
use serde_json::Value;

use crate::session::sqlstate;

/// The catalog name Ops Marts appear under.
pub const CATALOG: &str = "ops_marts";

/// How long a table's BigQuery schema is reused before `tables.get` is asked again.
const SCHEMA_TTL: Duration = Duration::from_secs(300);

/// One `bigquery` source: where its API is and how calls authenticate.
#[derive(Debug)]
struct BigQuerySource {
    name: String,
    project: String,
    /// `api_base_url` without a trailing `/`.
    api_base_url: String,
    auth: BigQueryAuth,
}

impl BigQuerySource {
    /// The bearer token for BigQuery calls.
    fn token(&self) -> Result<String, DataFusionError> {
        match &self.auth {
            BigQueryAuth::StaticToken(secret) => Ok(secret.expose().to_string()),
            BigQueryAuth::WorkloadIdentity { .. } => Err(sqlstate(
                "0A000",
                format!(
                    "bigquery source \"{}\": workload identity federation is not supported yet; set access_token_env",
                    self.name
                ),
            )),
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
        let source = &t.source;
        let fail = |what: String| {
            DataFusionError::Execution(format!(
                "bigquery source \"{}\": table {}.{}: {what}",
                source.name, t.dataset, t.table
            ))
        };
        let mut url = reqwest::Url::parse(&source.api_base_url)
            .map_err(|e| fail(format!("api_base_url is not a URL: {e}")))?;
        url.path_segments_mut()
            .map_err(|()| fail("api_base_url cannot take a path".to_string()))?
            .pop_if_empty()
            .extend([
                "bigquery",
                "v2",
                "projects",
                &source.project,
                "datasets",
                &t.dataset,
                "tables",
                &t.table,
            ]);
        let response = self
            .http
            .get(url)
            .bearer_auth(source.token()?)
            .send()
            .await
            .map_err(|e| fail(format!("BigQuery is unreachable: {e}")))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|e| fail(format!("reading the response failed: {e}")))?;
        let answer: Value = serde_json::from_slice(&body)
            .map_err(|_| fail(format!("HTTP {status} with a response that is not JSON")))?;
        if !status.is_success() {
            let message = answer["error"]["message"]
                .as_str()
                .unwrap_or("no error message");
            return Err(fail(format!("HTTP {status}: {message}")));
        }
        let fields = answer["schema"]["fields"]
            .as_array()
            .ok_or_else(|| fail("the table has no schema.fields".to_string()))?;
        Ok(Schema::new(
            fields.iter().map(arrow_field).collect::<Vec<_>>(),
        ))
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
            auth: auth.clone(),
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
        Ok(Some(Arc::new(OpsMartTable { schema })))
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

    /// Reading rows is not built yet: tables can be listed, described and planned only.
    async fn scan(
        &self,
        _state: &dyn Session,
        _projection: Option<&Vec<usize>>,
        _filters: &[Expr],
        _limit: Option<usize>,
    ) -> datafusion::error::Result<Arc<dyn ExecutionPlan>> {
        Err(sqlstate(
            "0A000",
            "reading Ops Mart rows is not supported yet".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

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
}
