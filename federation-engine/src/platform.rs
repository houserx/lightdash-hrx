//! `platform_query(sql)` (CONTRACTS §1.1): a read on the Platform Database (the
//! `platform_postgres` source), as a table of whatever columns Postgres returns for `sql`.
//! `platform_tables()` and `platform_columns(table_schema, table_name)` list its tables and
//! columns ([`PlatformCatalog`]).
//!
//! The columns are found at plan time by a describe-only round trip (Parse and Describe, never
//! Execute), so extended-protocol clients see the real column types before running the query.
//! The statement runs once, when the plan executes, over the source's read URL (the read-only
//! role), and its rows come back in Postgres binary format.
//!
//! Reading the Platform Database needs `attrs.platform_read` and is an Audited Query (§1.2, §6).
//! Then `sql` must pass the read guard (§5, [`engine_guard`]): a rejection is SQLSTATE 42501 with
//! the portal's message, before any connection, and is not audited. The guarded (trimmed) SQL is
//! what runs, as in the portal.
//!
//! Column types: `bool`, `int2`, `int4`, `int8`, `float4`, `float8`, `date`, `timestamp` and
//! `timestamptz` keep their type; `text`, `varchar`, `bpchar`, `name`, `citext`, `uuid` and
//! `numeric` (exact, as Postgres prints it) are text; `json` and `jsonb` are json. Any other type
//! is refused with SQLSTATE 0A000 and a hint to cast the column to text in `sql`.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt::Write as _;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use datafusion::arrow::array::{
    ArrayRef, BooleanArray, Date32Array, Float32Array, Float64Array, Int16Array, Int32Array,
    Int64Array, StringArray, TimestampMicrosecondArray,
};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::catalog::memory::MemorySourceConfig;
use datafusion::catalog::{Session, TableFunctionArgs, TableFunctionImpl, TableProvider};
use datafusion::error::DataFusionError;
use datafusion::logical_expr::{Expr, TableType};
use datafusion::physical_plan::ExecutionPlan;
use engine_config::{Config, SourceKind, SourceSettings};
use engine_guard::Mode;
use futures::{TryStreamExt, pin_mut};
use tokio_postgres::types::{FromSql, Type};
use tokio_postgres::{Client, NoTls, Row};

use crate::identity::{Access, Claim};
use crate::promql::{EXTENSION_NAME_KEY, JSON_EXTENSION, UTC, constant, text_argument};
use crate::session::{sqlstate, sqlstate_owned};

const SIGNATURE: &str = "platform_query(sql)";

/// The configured Platform Database: the source `platform_query` reads.
#[derive(Debug, Clone)]
struct PlatformSource {
    name: String,
    /// The read-only role's connection URL. Secret: never logged or shown.
    read_url: String,
    /// The env var `read_url` came from (safe to show).
    read_url_env: String,
    /// More rows than this is an error (SQLSTATE 54000), never a silent truncation.
    max_rows: usize,
}

impl PlatformSource {
    /// A new connection as the read-only role. It closes when the client is dropped.
    async fn connect(&self, timeout: Duration) -> Result<Client, DataFusionError> {
        let name = &self.name;
        let mut config: tokio_postgres::Config = self.read_url.parse().map_err(|_| {
            sqlstate(
                "08001",
                format!(
                    "platform source \"{name}\": {} is not a valid Postgres connection URL",
                    self.read_url_env
                ),
            )
        })?;
        config
            .connect_timeout(timeout)
            .application_name("hrx-federation-engine");
        let (client, connection) = config.connect(NoTls).await.map_err(|e| {
            sqlstate(
                "08001",
                format!("platform source \"{name}\" is unreachable: {}", cause(&e)),
            )
        })?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(client)
    }

    /// A failure the Platform Database reported, with its own SQLSTATE; any other failure is a
    /// lost connection (08006).
    fn error(&self, e: tokio_postgres::Error) -> DataFusionError {
        match e.as_db_error() {
            Some(db) => sqlstate_owned(
                db.code().code().to_string(),
                format!("platform source \"{}\": {}", self.name, db.message()),
            ),
            None => sqlstate(
                "08006",
                format!(
                    "platform source \"{}\": the connection failed: {}",
                    self.name,
                    cause(&e)
                ),
            ),
        }
    }
}

/// An error's text with its causes (tokio-postgres puts the useful part in the source).
fn cause(e: &tokio_postgres::Error) -> String {
    match e.source() {
        Some(inner) => format!("{e}: {inner}"),
        None => e.to_string(),
    }
}

impl PlatformSource {
    /// The config's default `platform_postgres` source, or why there is none to read.
    fn from_config(config: &Config) -> Result<PlatformSource, String> {
        let kind = SourceKind::PlatformPostgres;
        match config.default_source(kind) {
            Some(s) => match &s.settings {
                SourceSettings::PlatformPostgres { read_url, .. } => Ok(PlatformSource {
                    name: s.name.clone(),
                    read_url: read_url.expose().to_string(),
                    read_url_env: read_url.env_name().to_string(),
                    max_rows: usize::try_from(s.max_rows.unwrap_or(config.max_rows))
                        .unwrap_or(usize::MAX),
                }),
                _ => Err("the default platform_postgres source has no read URL".to_string()),
            },
            None if config.sources.iter().any(|s| s.kind() == kind) => Err(
                "there are several platform_postgres sources and none is the default".to_string(),
            ),
            None => Err("there is no platform_postgres source in the config".to_string()),
        }
    }

    /// The source for a call of `signature`, once the session may read it (42501 otherwise,
    /// before anything reaches the Platform Database). The statement becomes an Audited Query.
    fn for_call(
        source: &Result<PlatformSource, String>,
        session: &dyn Session,
        signature: &str,
    ) -> Result<PlatformSource, DataFusionError> {
        let source = source
            .clone()
            .map_err(|why| sqlstate("42704", format!("{signature}: {why}")))?;
        Access::require(session, &source.name, Claim::PlatformRead)?;
        Ok(source)
    }
}

/// The `platform_query` table function.
#[derive(Debug, Clone)]
pub struct PlatformQuery {
    /// `Err` holds why there is no source to read (none configured, or no default among many).
    source: Result<PlatformSource, String>,
    connect_timeout: Duration,
}

impl PlatformQuery {
    pub fn new(config: &Config, connect_timeout: Duration) -> PlatformQuery {
        PlatformQuery {
            source: PlatformSource::from_config(config),
            connect_timeout,
        }
    }
}

impl TableFunctionImpl for PlatformQuery {
    fn call_with_args(
        &self,
        args: TableFunctionArgs,
    ) -> datafusion::error::Result<Arc<dyn TableProvider>> {
        let exprs = args.exprs();
        if exprs.len() != 1 {
            return Err(sqlstate(
                "42883",
                format!("{SIGNATURE} takes 1 argument, not {}", exprs.len()),
            ));
        }
        let session = args.session();
        let sql = text_argument(constant(&exprs[0], session, SIGNATURE)?, "sql", SIGNATURE)?;
        let source = PlatformSource::for_call(&self.source, session, SIGNATURE)?;
        let sql =
            engine_guard::guard(&sql, Mode::Read).map_err(|r| sqlstate("42501", r.message))?;
        let timeout = self.connect_timeout;
        let types = block_on(async {
            let client = source.connect(timeout).await?;
            let statement = client.prepare(&sql).await.map_err(|e| source.error(e))?;
            Ok::<_, DataFusionError>(
                statement
                    .columns()
                    .iter()
                    .map(|c| (c.name().to_string(), c.type_().clone()))
                    .collect::<Vec<_>>(),
            )
        })??;
        let schema = schema_of(&types)?;
        Ok(Arc::new(PlatformTable {
            source,
            connect_timeout: timeout,
            signature: SIGNATURE,
            sql,
            params: vec![],
            types: types.into_iter().map(|(_, ty)| ty).collect(),
            schema,
        }))
    }
}

/// `platform_tables()` and `platform_columns(table_schema, table_name)` (CONTRACTS §1.1): the
/// Platform Database's user tables, and a table's columns, from its `information_schema` as the
/// read-only role sees it. Each call needs `attrs.platform_read` and is an Audited Query, like
/// `platform_query`. Their SQL is the engine's own (the names are bound parameters), so it does
/// not go through the read guard, and their columns are fixed, so planning needs no round trip.
#[derive(Debug, Clone)]
pub struct PlatformCatalog {
    listing: Listing,
    source: Result<PlatformSource, String>,
    connect_timeout: Duration,
}

#[derive(Debug, Clone, Copy)]
enum Listing {
    Tables,
    Columns,
}

/// Every table and view outside the system schemas (`pg_*` names are reserved for them).
const TABLES_SQL: &str = "SELECT table_schema::text AS table_schema, table_name::text AS table_name \
     FROM information_schema.tables \
     WHERE table_schema::text <> 'information_schema' AND table_schema::text !~ '^pg_' \
     ORDER BY 1, 2";

/// A table's columns in ordinal order; `data_type` as `information_schema` names it.
const COLUMNS_SQL: &str = "SELECT column_name::text AS column_name, data_type::text AS data_type, \
     is_nullable::text = 'YES' AS is_nullable \
     FROM information_schema.columns \
     WHERE table_schema::text = $1::text AND table_name::text = $2::text \
     ORDER BY ordinal_position";

impl PlatformCatalog {
    pub fn tables(config: &Config, connect_timeout: Duration) -> PlatformCatalog {
        PlatformCatalog {
            listing: Listing::Tables,
            source: PlatformSource::from_config(config),
            connect_timeout,
        }
    }

    pub fn columns(config: &Config, connect_timeout: Duration) -> PlatformCatalog {
        PlatformCatalog {
            listing: Listing::Columns,
            ..PlatformCatalog::tables(config, connect_timeout)
        }
    }
}

impl TableFunctionImpl for PlatformCatalog {
    fn call_with_args(
        &self,
        args: TableFunctionArgs,
    ) -> datafusion::error::Result<Arc<dyn TableProvider>> {
        let (signature, names, sql, columns): (_, &[&str], _, &[(&str, Type)]) = match self.listing
        {
            Listing::Tables => (
                "platform_tables()",
                &[],
                TABLES_SQL,
                &[("table_schema", Type::TEXT), ("table_name", Type::TEXT)],
            ),
            Listing::Columns => (
                "platform_columns(table_schema, table_name)",
                &["table_schema", "table_name"],
                COLUMNS_SQL,
                &[
                    ("column_name", Type::TEXT),
                    ("data_type", Type::TEXT),
                    ("is_nullable", Type::BOOL),
                ],
            ),
        };
        let exprs = args.exprs();
        if exprs.len() != names.len() {
            return Err(sqlstate(
                "42883",
                format!(
                    "{signature} takes {} argument{}, not {}",
                    names.len(),
                    if names.len() == 1 { "" } else { "s" },
                    exprs.len()
                ),
            ));
        }
        let session = args.session();
        let params = exprs
            .iter()
            .zip(names)
            .map(|(e, name)| text_argument(constant(e, session, signature)?, name, signature))
            .collect::<Result<Vec<_>, _>>()?;
        let source = PlatformSource::for_call(&self.source, session, signature)?;
        let columns: Vec<(String, Type)> = columns
            .iter()
            .map(|(name, ty)| (name.to_string(), ty.clone()))
            .collect();
        let schema = schema_of(&columns)?;
        Ok(Arc::new(PlatformTable {
            source,
            connect_timeout: self.connect_timeout,
            signature,
            sql: sql.to_string(),
            params,
            types: columns.into_iter().map(|(_, ty)| ty).collect(),
            schema,
        }))
    }
}

/// Runs `future` to completion from synchronous planning code. Table functions are called
/// synchronously while a statement is planned, on the engine's multi-threaded runtime, so this
/// moves the worker's other tasks elsewhere while it waits.
fn block_on<F: Future>(future: F) -> Result<F::Output, DataFusionError> {
    let handle = tokio::runtime::Handle::try_current()
        .ok()
        .filter(|h| h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
        .ok_or_else(|| {
            DataFusionError::Internal(format!(
                "{SIGNATURE} must be planned on a multi-threaded tokio runtime"
            ))
        })?;
    Ok(tokio::task::block_in_place(|| handle.block_on(future)))
}

/// The engine's column type for a Platform Database column type, and whether it is json.
fn arrow_type(ty: &Type) -> Option<(DataType, bool)> {
    let dt = match *ty {
        Type::BOOL => DataType::Boolean,
        Type::INT2 => DataType::Int16,
        Type::INT4 => DataType::Int32,
        Type::INT8 => DataType::Int64,
        Type::FLOAT4 => DataType::Float32,
        Type::FLOAT8 => DataType::Float64,
        Type::DATE => DataType::Date32,
        Type::TIMESTAMP => DataType::Timestamp(TimeUnit::Microsecond, None),
        Type::TIMESTAMPTZ => DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())),
        Type::JSON | Type::JSONB => return Some((DataType::Utf8, true)),
        Type::UUID | Type::NUMERIC => DataType::Utf8,
        ref other if <String as FromSql>::accepts(other) => DataType::Utf8,
        _ => return None,
    };
    Some((dt, false))
}

/// The table schema for described columns: every column nullable, json columns marked json.
fn schema_of(columns: &[(String, Type)]) -> Result<SchemaRef, DataFusionError> {
    let mut seen = HashSet::new();
    let mut fields = Vec::with_capacity(columns.len());
    for (name, ty) in columns {
        if !seen.insert(name.as_str()) {
            return Err(sqlstate(
                "42701",
                format!(
                    "{SIGNATURE}: the column name \"{name}\" appears more than once; give the \
                     columns distinct names in sql"
                ),
            ));
        }
        let Some((dt, json)) = arrow_type(ty) else {
            return Err(sqlstate(
                "0A000",
                format!(
                    "{SIGNATURE}: column \"{name}\" has type {}, which platform_query does not \
                     read; cast it to text in sql",
                    ty.name()
                ),
            ));
        };
        let mut field = Field::new(name, dt, true);
        if json {
            field = field.with_metadata(HashMap::from([(
                EXTENSION_NAME_KEY.to_string(),
                JSON_EXTENSION.to_string(),
            )]));
        }
        fields.push(field);
    }
    Ok(Arc::new(Schema::new(fields)))
}

/// One Platform Database call: the statement, its text parameters, and the columns it was
/// planned with.
#[derive(Debug)]
struct PlatformTable {
    source: PlatformSource,
    connect_timeout: Duration,
    /// The calling function, for error messages.
    signature: &'static str,
    sql: String,
    params: Vec<String>,
    /// The Postgres type of each column, as described at plan time.
    types: Vec<Type>,
    schema: SchemaRef,
}

impl PlatformTable {
    /// Runs the statement once and returns all its rows. Fails with 54000 past `max_rows`, and
    /// with 0A000 when the result's columns are no longer the ones it was planned with.
    async fn fetch(&self) -> Result<Vec<Row>, DataFusionError> {
        let source = &self.source;
        let client = source.connect(self.connect_timeout).await?;
        let statement = client
            .prepare(&self.sql)
            .await
            .map_err(|e| source.error(e))?;
        let now: Vec<&Type> = statement.columns().iter().map(|c| c.type_()).collect();
        let planned: Vec<&Type> = self.types.iter().collect();
        if now != planned {
            return Err(sqlstate(
                "0A000",
                format!(
                    "{}: the result's columns changed since the statement was planned; run it \
                     again",
                    self.signature
                ),
            ));
        }
        let stream = client
            .query_raw(&statement, &self.params)
            .await
            .map_err(|e| source.error(e))?;
        pin_mut!(stream);
        let mut rows = vec![];
        while let Some(row) = stream.try_next().await.map_err(|e| source.error(e))? {
            if rows.len() == source.max_rows {
                return Err(sqlstate(
                    "54000",
                    format!(
                        "result exceeds max_rows ({}) for source \"{}\"",
                        source.max_rows, source.name
                    ),
                ));
            }
            rows.push(row);
        }
        Ok(rows)
    }
}

#[async_trait]
impl TableProvider for PlatformTable {
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
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
        let rows = self.fetch().await?;
        let batch = to_batch(&self.schema, &rows)?;
        Ok(MemorySourceConfig::try_new_exec(
            &[vec![batch]],
            self.schema(),
            projection.cloned(),
        )?)
    }
}

/// The rows as one batch of `schema`.
fn to_batch(schema: &SchemaRef, rows: &[Row]) -> Result<RecordBatch, DataFusionError> {
    let columns = schema
        .fields()
        .iter()
        .enumerate()
        .map(|(i, field)| column(field.name(), field.data_type(), rows, i))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RecordBatch::try_new(schema.clone(), columns)?)
}

/// Column `i` of every row as an Arrow array of `dt`.
fn column(name: &str, dt: &DataType, rows: &[Row], i: usize) -> Result<ArrayRef, DataFusionError> {
    fn values<'a, T: FromSql<'a>>(
        name: &str,
        rows: &'a [Row],
        i: usize,
    ) -> Result<Vec<Option<T>>, DataFusionError> {
        rows.iter()
            .map(|r| r.try_get::<_, Option<T>>(i))
            .collect::<Result<_, _>>()
            .map_err(|e| {
                DataFusionError::Execution(format!(
                    "{SIGNATURE}: column \"{name}\" could not be read: {}",
                    cause(&e)
                ))
            })
    }
    Ok(match dt {
        DataType::Boolean => Arc::new(BooleanArray::from(values::<bool>(name, rows, i)?)),
        DataType::Int16 => Arc::new(Int16Array::from(values::<i16>(name, rows, i)?)),
        DataType::Int32 => Arc::new(Int32Array::from(values::<i32>(name, rows, i)?)),
        DataType::Int64 => Arc::new(Int64Array::from(values::<i64>(name, rows, i)?)),
        DataType::Float32 => Arc::new(Float32Array::from(values::<f32>(name, rows, i)?)),
        DataType::Float64 => Arc::new(Float64Array::from(values::<f64>(name, rows, i)?)),
        DataType::Date32 => {
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid date");
            let days = values::<NaiveDate>(name, rows, i)?
                .into_iter()
                .map(|d| d.map(|d| (d - epoch).num_days() as i32))
                .collect::<Vec<_>>();
            Arc::new(Date32Array::from(days))
        }
        DataType::Timestamp(_, Some(tz)) => {
            let micros = values::<DateTime<Utc>>(name, rows, i)?
                .into_iter()
                .map(|t| t.map(|t| t.timestamp_micros()))
                .collect::<Vec<_>>();
            Arc::new(TimestampMicrosecondArray::from(micros).with_timezone(tz.clone()))
        }
        DataType::Timestamp(_, None) => {
            let micros = values::<NaiveDateTime>(name, rows, i)?
                .into_iter()
                .map(|t| t.map(|t| t.and_utc().timestamp_micros()))
                .collect::<Vec<_>>();
            Arc::new(TimestampMicrosecondArray::from(micros))
        }
        _ => {
            let texts = values::<AsText>(name, rows, i)?
                .into_iter()
                .map(|t| t.map(|t| t.0))
                .collect::<Vec<_>>();
            Arc::new(StringArray::from(texts))
        }
    })
}

/// A text-shaped Postgres value as text: text types as they are, `json`/`jsonb` as their JSON
/// text, `uuid` hyphenated and `numeric` exactly as Postgres prints it.
struct AsText(String);

impl<'a> FromSql<'a> for AsText {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> Result<AsText, Box<dyn Error + Sync + Send>> {
        let utf8 = |b: &[u8]| String::from_utf8(b.to_vec());
        Ok(AsText(match *ty {
            Type::JSON => utf8(raw)?,
            Type::JSONB => match raw.split_first() {
                Some((1, text)) => utf8(text)?,
                _ => return Err("unsupported jsonb encoding version".into()),
            },
            Type::UUID => uuid_text(raw)?,
            Type::NUMERIC => numeric_text(raw)?,
            _ => String::from_sql(ty, raw)?,
        }))
    }

    fn accepts(ty: &Type) -> bool {
        matches!(*ty, Type::JSON | Type::JSONB | Type::UUID | Type::NUMERIC)
            || <String as FromSql>::accepts(ty)
    }
}

fn uuid_text(raw: &[u8]) -> Result<String, Box<dyn Error + Sync + Send>> {
    if raw.len() != 16 {
        return Err("a uuid is 16 bytes".into());
    }
    let h = hex::encode(raw);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

/// A binary `numeric` as Postgres's text output: base-10000 digit groups, `weight` the power of
/// the first group, `dscale` the digits after the point.
fn numeric_text(raw: &[u8]) -> Result<String, Box<dyn Error + Sync + Send>> {
    let word = |i: usize| -> Result<u16, Box<dyn Error + Sync + Send>> {
        raw.get(i..i + 2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))
            .ok_or_else(|| "truncated numeric".into())
    };
    let ndigits = usize::from(word(0)?);
    let weight = i64::from(word(2)? as i16);
    let sign = word(4)?;
    let dscale = usize::from(word(6)?);
    let digits = (0..ndigits)
        .map(|k| word(8 + 2 * k))
        .collect::<Result<Vec<u16>, _>>()?;
    match sign {
        0x0000 | 0x4000 => {}
        0xC000 => return Ok("NaN".to_string()),
        0xD000 => return Ok("Infinity".to_string()),
        0xF000 => return Ok("-Infinity".to_string()),
        _ => return Err("invalid numeric sign".into()),
    }
    let group = |k: i64| -> u16 {
        usize::try_from(k)
            .ok()
            .and_then(|k| digits.get(k).copied())
            .unwrap_or(0)
    };
    let mut text = String::new();
    if sign == 0x4000 {
        text.push('-');
    }
    if weight < 0 {
        text.push('0');
    } else {
        for k in 0..=weight {
            if k == 0 {
                write!(text, "{}", group(k))?;
            } else {
                write!(text, "{:04}", group(k))?;
            }
        }
    }
    if dscale > 0 {
        let mut fraction = String::with_capacity(dscale + 4);
        let mut k = weight + 1;
        while fraction.len() < dscale {
            write!(fraction, "{:04}", group(k))?;
            k += 1;
        }
        fraction.truncate(dscale);
        text.push('.');
        text.push_str(&fraction);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The binary form of a numeric from its parts.
    fn numeric(weight: i16, sign: u16, dscale: u16, digits: &[u16]) -> Vec<u8> {
        let mut b = vec![];
        b.extend((digits.len() as u16).to_be_bytes());
        b.extend(weight.to_be_bytes());
        b.extend(sign.to_be_bytes());
        b.extend(dscale.to_be_bytes());
        for d in digits {
            b.extend(d.to_be_bytes());
        }
        b
    }

    #[test]
    fn numerics_print_as_postgres_prints_them() {
        let cases: &[(Vec<u8>, &str)] = &[
            (numeric(0, 0, 0, &[]), "0"),
            (numeric(0, 0, 2, &[]), "0.00"),
            (numeric(0, 0, 0, &[42]), "42"),
            (numeric(1, 0, 0, &[1, 2345]), "12345"),
            (numeric(2, 0, 0, &[1]), "100000000"),
            (numeric(0, 0x4000, 3, &[3, 1415]), "-3.141"),
            (numeric(0, 0, 4, &[3, 1415]), "3.1415"),
            (numeric(0, 0, 6, &[3, 1415]), "3.141500"),
            (numeric(-1, 0, 4, &[50]), "0.0050"),
            (numeric(-2, 0, 8, &[12]), "0.00000012"),
            (numeric(0, 0xC000, 0, &[]), "NaN"),
            (numeric(0, 0xD000, 0, &[]), "Infinity"),
            (numeric(0, 0xF000, 0, &[]), "-Infinity"),
        ];
        for (raw, want) in cases {
            assert_eq!(numeric_text(raw).unwrap(), *want);
        }
        assert!(numeric_text(&[0, 1]).is_err());
    }

    #[test]
    fn uuids_are_hyphenated() {
        let raw: Vec<u8> = (0u8..16).collect();
        assert_eq!(
            uuid_text(&raw).unwrap(),
            "00010203-0405-0607-0809-0a0b0c0d0e0f"
        );
        assert!(uuid_text(&raw[..15]).is_err());
    }

    #[test]
    fn columns_keep_their_types() {
        let schema = schema_of(&[
            ("id".into(), Type::INT8),
            ("name".into(), Type::TEXT),
            ("active".into(), Type::BOOL),
            ("created_at".into(), Type::TIMESTAMPTZ),
            ("score".into(), Type::FLOAT8),
            ("doc".into(), Type::JSONB),
            ("amount".into(), Type::NUMERIC),
        ])
        .unwrap();
        let types: Vec<DataType> = schema.fields().iter().map(|f| f.data_type().clone()).collect();
        assert_eq!(
            types,
            [
                DataType::Int64,
                DataType::Utf8,
                DataType::Boolean,
                DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())),
                DataType::Float64,
                DataType::Utf8,
                DataType::Utf8,
            ]
        );
        assert_eq!(
            schema.field(5).metadata().get(EXTENSION_NAME_KEY).map(String::as_str),
            Some(JSON_EXTENSION)
        );
        assert!(schema.field(6).metadata().is_empty());
    }

    #[test]
    fn unreadable_types_and_repeated_names_are_refused() {
        let code = |r: Result<SchemaRef, DataFusionError>| match r {
            Err(DataFusionError::External(e)) => e.to_string(),
            other => panic!("{other:?}"),
        };
        let refusal = code(schema_of(&[("tags".into(), Type::TEXT_ARRAY)]));
        assert!(refusal.contains("cast it to text"), "{refusal}");
        let refusal = code(schema_of(&[("id".into(), Type::INT8), ("id".into(), Type::INT4)]));
        assert!(refusal.contains("\"id\" appears more than once"), "{refusal}");
    }
}
