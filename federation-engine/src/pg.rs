//! The pg-wire side (CONTRACTS §1): SCRAM-SHA-256 login against the config's `[[users]]`, then SQL
//! through DataFusion.

use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use datafusion::arrow::array::{Array, BooleanArray};
use datafusion::arrow::datatypes::{DataType, Schema};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::arrow::util::display::{ArrayFormatter, FormatOptions};
use datafusion::error::DataFusionError;
use datafusion::execution::context::SQLOptions;
use datafusion::prelude::SessionContext;
use engine_config::User;
use futures::{Sink, stream};
use pgwire::api::auth::sasl::SASLAuthStartupHandler;
use pgwire::api::auth::sasl::scram::{ScramAuth, gen_salted_password};
use pgwire::api::auth::{
    AuthSource, DefaultServerParameterProvider, LoginInfo, Password, StartupHandler,
};
use pgwire::api::query::SimpleQueryHandler;
use pgwire::api::results::{DataRowEncoder, FieldFormat, FieldInfo, QueryResponse, Response};
use pgwire::api::store::PortalStore;
use pgwire::api::{ClientInfo, ClientPortalStore, PgWireServerHandlers, Type};
use pgwire::error::{ErrorInfo, PgWireError, PgWireResult};
use pgwire::messages::PgWireBackendMessage;
use pgwire::messages::data::DataRow;

/// PBKDF2 iterations for SCRAM-SHA-256 (the Postgres default).
const SCRAM_ITERATIONS: usize = 4096;

/// Major.minor reported in the `server_version` startup parameter.
const SERVER_VERSION: &str = "16.0";

/// The configured pg-wire logins as SCRAM secrets, salted once per process.
///
/// An unknown user gets a decoy secret no password matches, so it fails exactly like a wrong
/// password (SQLSTATE 28P01) and the server never says which logins exist.
#[derive(Debug)]
struct Logins {
    users: HashMap<String, Password>,
    decoy: Password,
}

impl Logins {
    fn new(users: &[User]) -> Logins {
        let users = users
            .iter()
            .map(|u| {
                let salt = random_bytes();
                let salted = gen_salted_password(u.password.expose(), &salt, SCRAM_ITERATIONS);
                (u.name.clone(), Password::new(Some(salt), salted))
            })
            .collect();
        // Random bytes, not the PBKDF2 output of any password: nothing can produce a valid proof.
        let decoy = Password::new(Some(random_bytes()), random_bytes().repeat(2));
        Logins { users, decoy }
    }
}

#[async_trait]
impl AuthSource for Logins {
    async fn get_password(&self, login: &LoginInfo) -> PgWireResult<Password> {
        let known = login.user().and_then(|name| self.users.get(name));
        Ok(known.unwrap_or(&self.decoy).clone())
    }
}

fn random_bytes() -> Vec<u8> {
    let mut b = vec![0u8; 16];
    getrandom::fill(&mut b).expect("the OS random source is available");
    b
}

/// Everything a pg-wire connection needs; shared by all connections.
pub struct PgHandlers {
    startup: Arc<SASLAuthStartupHandler<DefaultServerParameterProvider>>,
    query: Arc<QueryHandler>,
}

impl PgHandlers {
    pub fn new(users: &[User]) -> PgHandlers {
        let mut scram = ScramAuth::new(Arc::new(Logins::new(users)));
        scram.set_iterations(SCRAM_ITERATIONS);
        let mut params = DefaultServerParameterProvider::default();
        params.server_version = SERVER_VERSION.to_string();
        params.is_superuser = false;
        PgHandlers {
            startup: Arc::new(SASLAuthStartupHandler::new(Arc::new(params)).with_scram(scram)),
            query: Arc::new(QueryHandler {
                ctx: SessionContext::new(),
            }),
        }
    }
}

impl PgWireServerHandlers for PgHandlers {
    fn startup_handler(&self) -> Arc<impl StartupHandler> {
        self.startup.clone()
    }

    fn simple_query_handler(&self) -> Arc<impl SimpleQueryHandler> {
        self.query.clone()
    }
}

/// Runs SQL on DataFusion. Read-only: DDL, DML and session statements are refused.
pub struct QueryHandler {
    ctx: SessionContext,
}

impl QueryHandler {
    async fn run(&self, sql: &str) -> Result<(Schema, Vec<RecordBatch>), DataFusionError> {
        let options = SQLOptions::new()
            .with_allow_ddl(false)
            .with_allow_dml(false)
            .with_allow_statements(false);
        let df = self.ctx.sql_with_options(sql, options).await?;
        let schema = df.schema().as_arrow().clone();
        let batches = df.collect().await?;
        Ok((schema, batches))
    }
}

#[async_trait]
impl SimpleQueryHandler for QueryHandler {
    async fn do_query<C>(&self, _client: &mut C, query: &str) -> PgWireResult<Vec<Response>>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let (schema, batches) = self.run(query).await.map_err(query_error)?;
        let fields = Arc::new(
            schema
                .fields()
                .iter()
                .map(|f| {
                    let ty = pg_type(f.data_type());
                    FieldInfo::new(f.name().clone(), None, None, ty, FieldFormat::Text)
                })
                .collect::<Vec<_>>(),
        );
        let rows = text_rows(&fields, &batches)?;
        Ok(vec![Response::Query(QueryResponse::new(
            fields,
            stream::iter(rows.into_iter().map(Ok)),
        ))])
    }
}

/// The Postgres type sent for an Arrow column (CONTRACTS §1 type table; anything else is text).
fn pg_type(dt: &DataType) -> Type {
    match dt {
        DataType::Boolean => Type::BOOL,
        DataType::Int8 | DataType::Int16 | DataType::UInt8 => Type::INT2,
        DataType::Int32 | DataType::UInt16 => Type::INT4,
        DataType::Int64 | DataType::UInt32 | DataType::UInt64 => Type::INT8,
        DataType::Float16 | DataType::Float32 => Type::FLOAT4,
        DataType::Float64 => Type::FLOAT8,
        DataType::Timestamp(_, Some(_)) => Type::TIMESTAMPTZ,
        DataType::Timestamp(_, None) => Type::TIMESTAMP,
        DataType::Date32 | DataType::Date64 => Type::DATE,
        _ => Type::TEXT,
    }
}

/// Encodes every row as Postgres text-format values.
fn text_rows(fields: &Arc<Vec<FieldInfo>>, batches: &[RecordBatch]) -> PgWireResult<Vec<DataRow>> {
    let options = FormatOptions::default();
    let mut encoder = DataRowEncoder::new(fields.clone());
    let mut rows = Vec::new();
    for batch in batches {
        let formatters = batch
            .columns()
            .iter()
            .map(|c| ArrayFormatter::try_new(c.as_ref(), &options))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| query_error(e.into()))?;
        // Logical nulls: a `NullArray` (e.g. `SELECT NULL`) has no validity buffer.
        let nulls: Vec<_> = batch.columns().iter().map(|c| c.logical_nulls()).collect();
        for row in 0..batch.num_rows() {
            for ((col, formatter), nulls) in batch.columns().iter().zip(&formatters).zip(&nulls) {
                let value = if nulls.as_ref().is_some_and(|n| n.is_null(row)) {
                    None
                } else if let Some(b) = col.as_any().downcast_ref::<BooleanArray>() {
                    Some(if b.value(row) { "t" } else { "f" }.to_string())
                } else {
                    Some(formatter.value(row).to_string())
                };
                encoder.encode_field(&value)?;
            }
            rows.push(encoder.take_row());
        }
    }
    Ok(rows)
}

/// Maps a DataFusion error to an ErrorResponse with a SQLSTATE.
fn query_error(e: DataFusionError) -> PgWireError {
    let code = match e.find_root() {
        // DataFusion has no typed "unknown table" error, only this wording (unit-tested below).
        DataFusionError::Plan(msg)
            if msg.starts_with("table '") && msg.ends_with("' not found") =>
        {
            "42P01"
        }
        DataFusionError::SQL(..) => "42601",
        DataFusionError::Plan(_) | DataFusionError::SchemaError(..) => "42000",
        DataFusionError::NotImplemented(_) => "0A000",
        _ => "XX000",
    };
    PgWireError::UserError(Box::new(ErrorInfo::new(
        "ERROR".to_string(),
        code.to_string(),
        e.to_string(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use datafusion::arrow::array::{ArrayRef, Int64Array, NullArray, StringArray};

    #[test]
    fn unknown_users_get_a_decoy_secret_unlike_any_real_one() {
        let logins = Logins {
            users: HashMap::from([("a".to_string(), Password::new(Some(vec![1]), vec![2]))]),
            decoy: Password::new(Some(vec![3]), vec![4]),
        };
        let get = |user: Option<&str>| {
            let login = LoginInfo::new(user, None, "127.0.0.1".to_string());
            futures::executor::block_on(logins.get_password(&login)).unwrap()
        };
        assert_eq!(get(Some("a")).password(), [2]);
        assert_eq!(get(Some("nobody")).password(), [4]);
        assert_eq!(get(None).password(), [4]);
    }

    fn sqlstate_of(sql: &str) -> String {
        let handler = QueryHandler {
            ctx: SessionContext::new(),
        };
        let e = futures::executor::block_on(handler.run(sql)).unwrap_err();
        match query_error(e) {
            PgWireError::UserError(info) => info.code.clone(),
            other => panic!("not a user error: {other:?}"),
        }
    }

    #[test]
    fn query_errors_carry_postgres_sqlstates() {
        assert_eq!(sqlstate_of("SELECT * FROM no_such_table"), "42P01");
        assert_eq!(sqlstate_of("SELECT * FROM public.no_such_table"), "42P01");
        assert_eq!(sqlstate_of("SELECT no_such_column"), "42000");
        assert_eq!(sqlstate_of("SELEC 1"), "42601");
        assert_eq!(sqlstate_of("CREATE TABLE t (a int)"), "42000");
    }

    #[test]
    fn rows_are_postgres_text_with_real_nulls() {
        let cols: Vec<ArrayRef> = vec![
            Arc::new(Int64Array::from(vec![Some(1), None])),
            Arc::new(BooleanArray::from(vec![true, false])),
            Arc::new(StringArray::from(vec!["x", "y"])),
            Arc::new(NullArray::new(2)),
        ];
        let batch = RecordBatch::try_from_iter(["i", "b", "s", "n"].into_iter().zip(cols)).unwrap();
        let fields = Arc::new(
            batch
                .schema()
                .fields()
                .iter()
                .map(|f| {
                    FieldInfo::new(
                        f.name().clone(),
                        None,
                        None,
                        pg_type(f.data_type()),
                        FieldFormat::Text,
                    )
                })
                .collect::<Vec<_>>(),
        );
        assert_eq!(fields[0].datatype(), &Type::INT8);
        assert_eq!(fields[1].datatype(), &Type::BOOL);
        let rows = text_rows(&fields, &[batch]).unwrap();
        // DataRow bodies: per field an i32 length (-1 = NULL) then the bytes.
        let first = &rows[0].data;
        assert_eq!(
            &first[..],
            b"\0\0\0\x011\0\0\0\x01t\0\0\0\x01x\xff\xff\xff\xff"
        );
        let second = &rows[1].data;
        assert_eq!(
            &second[..],
            b"\xff\xff\xff\xff\0\0\0\x01f\0\0\0\x01y\xff\xff\xff\xff"
        );
    }
}
