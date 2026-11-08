//! The pg-wire side (CONTRACTS §1): SCRAM-SHA-256 login against the config's `[[users]]`, then SQL
//! through DataFusion.

use std::collections::{HashMap, VecDeque};
use std::fmt::Debug;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, NaiveDateTime, Offset, TimeZone, Timelike};
use datafusion::arrow::array::timezone::Tz;
use datafusion::arrow::array::{Array, ArrayRef, AsArray};
use datafusion::arrow::compute::cast;
use datafusion::arrow::datatypes::{
    DataType, Date32Type, Float32Type, Float64Type, Int16Type, Int32Type, Int64Type, Schema,
    TimeUnit, TimestampMicrosecondType,
};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::arrow::util::display::{ArrayFormatter, FormatOptions};
use datafusion::common::ScalarValue;
use datafusion::common::tree_node::{TreeNode, TreeNodeRecursion};
use datafusion::dataframe::DataFrame;
use datafusion::error::DataFusionError;
use datafusion::execution::FunctionRegistry;
use datafusion::execution::context::SQLOptions;
use datafusion::execution::{SessionState, SessionStateBuilder};
use datafusion::logical_expr::{
    Cast, ColumnarValue, Expr, LogicalPlan, ScalarUDF, TryCast, Volatility, create_udf,
};
use datafusion::prelude::{SessionConfig, SessionContext};
use datafusion::sql::parser::{DFParserBuilder, Statement as DFStatement};
use datafusion::sql::sqlparser::dialect::dialect_from_str;
use engine_config::{Config, User};
use futures::{Sink, stream};
use pgwire::api::auth::sasl::SASLAuthStartupHandler;
use pgwire::api::auth::sasl::scram::{ScramAuth, gen_salted_password};
use pgwire::api::auth::{
    AuthSource, DefaultServerParameterProvider, LoginInfo, Password, StartupHandler,
};
use pgwire::api::cancel::{CancelHandler, DefaultCancelHandler};
use pgwire::api::portal::{Format, Portal};
use pgwire::api::query::{ExtendedQueryHandler, SimpleQueryHandler};
use pgwire::api::results::{
    DataRowEncoder, DescribePortalResponse, DescribeStatementResponse, FieldFormat, FieldInfo,
    QueryResponse, Response, Tag,
};
use pgwire::api::stmt::{QueryParser, StoredStatement};
use pgwire::api::store::PortalStore;
use pgwire::api::{ClientInfo, ClientPortalStore, ConnectionManager, PgWireServerHandlers, Type};
use pgwire::error::{ErrorInfo, PgWireError, PgWireResult};
use pgwire::messages::PgWireBackendMessage;
use pgwire::messages::data::DataRow;
use pgwire::messages::response::TransactionStatus;
use pgwire::types::format::FormatOptions as PgFormatOptions;

use crate::labels::{label_udf, series_name_udf};
use crate::promql::{EXTENSION_NAME_KEY, JSON_EXTENSION, Promql};
use crate::session::{Change, Settings, SqlStateError, current_setting_udf, sqlstate};
use crate::transaction::{Transaction, aborted_block, check_not_aborted};

/// PBKDF2 iterations for SCRAM-SHA-256 (the Postgres default).
const SCRAM_ITERATIONS: usize = 4096;

/// Major.minor reported in the `server_version` startup parameter and by `version()`.
const SERVER_VERSION: &str = "16.0";

/// What `SELECT version()` returns. Lightdash reads the major version with
/// `/PostgreSQL (\d+)\./`, so this must start with `PostgreSQL 16.`.
const VERSION_STRING: &str = concat!(
    "PostgreSQL 16.0 (hrx-federation-engine ",
    env!("CARGO_PKG_VERSION"),
    ")"
);

/// How long a Telemetry Source has to accept a connection.
const SOURCE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The session time zone: DataFusion's zone for `TIMESTAMP WITH TIME ZONE` and `now()`.
const SESSION_TIME_ZONE: &str = "+00:00";

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
    cancel: Arc<DefaultCancelHandler>,
}

impl PgHandlers {
    /// Fails only if the HTTP client for Telemetry Sources cannot be built.
    pub fn new(config: &Config) -> Result<PgHandlers, String> {
        let http = reqwest::Client::builder()
            .connect_timeout(SOURCE_CONNECT_TIMEOUT)
            .build()
            .map_err(|e| format!("cannot build the HTTP client for sources: {e}"))?;
        let sql = Sql::new();
        let promql = Promql::new(config, http);
        sql.ctx
            .register_udtf("promql_instant", Arc::new(promql.clone().instant()));
        sql.ctx.register_udtf("promql", Arc::new(promql));
        let mut scram = ScramAuth::new(Arc::new(Logins::new(&config.users)));
        scram.set_iterations(SCRAM_ITERATIONS);
        let mut params = DefaultServerParameterProvider::default();
        params.server_version = SERVER_VERSION.to_string();
        params.is_superuser = false;
        // Cancellation (CONTRACTS §1): each login gets a random backend pid and secret key in
        // BackendKeyData and is registered here. A CancelRequest whose (pid, secret) matches
        // fires that connection's cancel receiver, which pgwire races against `do_query`; the
        // query is dropped (abandoning any in-flight source request) and fails with 57014.
        // A wrong pid or secret matches nothing and is ignored, as in Postgres.
        let connections = Arc::new(ConnectionManager::new());
        Ok(PgHandlers {
            startup: Arc::new(
                SASLAuthStartupHandler::new(Arc::new(params))
                    .with_scram(scram)
                    .with_connection_manager(connections.clone()),
            ),
            query: Arc::new(QueryHandler { sql: Arc::new(sql) }),
            cancel: Arc::new(DefaultCancelHandler::new(connections)),
        })
    }
}

impl PgWireServerHandlers for PgHandlers {
    fn startup_handler(&self) -> Arc<impl StartupHandler> {
        self.startup.clone()
    }

    fn simple_query_handler(&self) -> Arc<impl SimpleQueryHandler> {
        self.query.clone()
    }

    fn extended_query_handler(&self) -> Arc<impl ExtendedQueryHandler> {
        self.query.clone()
    }

    fn cancel_handler(&self) -> Arc<impl CancelHandler> {
        self.cancel.clone()
    }
}

/// SQL planning and execution on DataFusion. Read-only: DDL and DML are refused; `SET` and
/// `RESET` change the connection's [`Settings`], transaction statements its transaction status,
/// and DataFusion's own statements are refused.
pub struct Sql {
    ctx: SessionContext,
}

/// What a planned statement does when executed.
#[derive(Debug)]
enum Action {
    Query(LogicalPlan),
    Change(Change),
    Transaction(Transaction),
}

impl Action {
    /// Refuses the action in a failed transaction block unless it ends the block (25P02).
    fn check_not_aborted(&self, status: TransactionStatus) -> PgWireResult<()> {
        let ends_block = matches!(self, Action::Transaction(t) if t.ends_block());
        if status == TransactionStatus::Error && !ends_block {
            return Err(query_error(aborted_block()));
        }
        Ok(())
    }
}

impl Sql {
    /// Sessions default to UTC, so `TIMESTAMP WITH TIME ZONE` values carry a zone (and are sent
    /// as timestamptz) rather than being planned as zone-less timestamps.
    ///
    /// DataFusion's own `version()` is replaced by [`version_udf`].
    ///
    /// DataFusion's `information_schema` is the catalog clients see (CONTRACTS §1 "Catalog"):
    /// Lightdash's `getAllTables` and `getFields` read `information_schema.tables` and
    /// `information_schema.columns`. Nothing from `pg_catalog` is provided.
    fn new() -> Sql {
        let mut config = SessionConfig::new().with_information_schema(true);
        config.options_mut().execution.time_zone = Some(SESSION_TIME_ZONE.to_string());
        let ctx = SessionContext::new_with_config(config);
        ctx.register_udf(version_udf());
        ctx.register_udf(label_udf());
        ctx.register_udf(series_name_udf());
        Sql { ctx }
    }

    /// The shared state as one connection sees it: planned in its time zone, with
    /// `current_setting` reading its settings.
    fn state_for(&self, settings: &Settings) -> Result<SessionState, DataFusionError> {
        let mut state = self.ctx.state();
        if let Some(zone) = settings.time_zone() {
            state.config_mut().options_mut().execution.time_zone = Some(zone.to_string());
            // Rebuilt so zone-aware functions such as `now()` pick up the new zone.
            state = SessionStateBuilder::new_from_existing(state).build();
        }
        state.register_udf(Arc::new(current_setting_udf(settings.clone())))?;
        Ok(state)
    }

    /// The statements in a query string, in order (`BEGIN; ROLLBACK` is two).
    fn statements(&self, sql: &str) -> Result<VecDeque<DFStatement>, DataFusionError> {
        let config = self.ctx.copied_config();
        let options = &config.options().sql_parser;
        let dialect = dialect_from_str(options.dialect).ok_or_else(|| {
            DataFusionError::Plan(format!("unsupported SQL dialect: {}", options.dialect))
        })?;
        DFParserBuilder::new(sql)
            .with_dialect(dialect.as_ref())
            .with_recursion_limit(options.recursion_limit.get())
            .build()?
            .parse_statements()
    }

    /// Plans a query string that must hold exactly one statement (a Parse message).
    async fn plan(
        &self,
        sql: &str,
        settings: &Settings,
        status: TransactionStatus,
    ) -> Result<Action, DataFusionError> {
        let mut statements = self.statements(sql)?;
        if statements.len() > 1 {
            return Err(sqlstate(
                "42601",
                "cannot insert multiple commands into a prepared statement".to_string(),
            ));
        }
        let statement = statements.pop_front().ok_or_else(|| {
            DataFusionError::Plan("no SQL statement in the query string".to_string())
        })?;
        self.plan_statement(statement, settings, status).await
    }

    /// Plans one statement in a connection's settings and transaction status.
    async fn plan_statement(
        &self,
        statement: DFStatement,
        settings: &Settings,
        status: TransactionStatus,
    ) -> Result<Action, DataFusionError> {
        check_not_aborted(status, &statement)?;
        if let Some(change) = Change::of(&statement) {
            return Ok(Action::Change(change?));
        }
        if let Some(txn) = Transaction::of(&statement) {
            return Ok(Action::Transaction(txn?));
        }
        let state = self.state_for(settings)?;
        let plan = state.statement_to_plan(statement).await?;
        SQLOptions::new()
            .with_allow_ddl(false)
            .with_allow_dml(false)
            .with_allow_statements(false)
            .verify_plan(&plan)?;
        Ok(Action::Query(plan))
    }

    /// Runs a plan to completion in a connection's settings. With a `statement_timeout` set,
    /// a run that outlasts it fails with SQLSTATE 57014.
    async fn execute(
        &self,
        plan: LogicalPlan,
        settings: &Settings,
    ) -> Result<(Schema, Vec<RecordBatch>), DataFusionError> {
        let df = DataFrame::new(self.state_for(settings)?, plan);
        let schema = df.schema().as_arrow().clone();
        let batches = match settings.statement_timeout() {
            None => df.collect().await?,
            // On timeout the collect future is dropped, and with it any in-flight source
            // request (CONTRACTS §1 "Cancellation").
            Some(limit) => tokio::time::timeout(limit, df.collect())
                .await
                .map_err(|_| {
                    sqlstate(
                        "57014",
                        "canceling statement due to statement timeout".to_string(),
                    )
                })??,
        };
        Ok((schema, batches))
    }
}

/// `version()` as Postgres clients expect it: [`VERSION_STRING`] instead of DataFusion's
/// `Apache DataFusion ...`.
fn version_udf() -> ScalarUDF {
    create_udf(
        "version",
        vec![],
        DataType::Utf8,
        Volatility::Immutable,
        Arc::new(|_args: &[ColumnarValue]| {
            Ok(ColumnarValue::Scalar(ScalarValue::Utf8(Some(
                VERSION_STRING.to_string(),
            ))))
        }),
    )
}

/// Serves both the simple and the extended query protocol from one [`Sql`].
pub struct QueryHandler {
    sql: Arc<Sql>,
}

#[async_trait]
impl SimpleQueryHandler for QueryHandler {
    async fn do_query<C>(&self, client: &mut C, query: &str) -> PgWireResult<Vec<Response>>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let statements = self.sql.statements(query).map_err(query_error)?;
        // Each statement sees the settings and transaction status the ones before it left.
        let mut status = client.transaction_status();
        let mut responses = Vec::with_capacity(statements.len());
        for statement in statements {
            let response = match self.run_simple(client, statement, status).await {
                Ok(response) => response,
                // Postgres stops at the first failing statement; earlier results stand.
                Err(PgWireError::UserError(info)) => {
                    responses.push(Response::Error(info));
                    break;
                }
                Err(e) => return Err(e),
            };
            status = match &response {
                Response::TransactionStart(_) => status.to_in_transaction_state(),
                Response::TransactionEnd(_) => status.to_idle_state(),
                _ => status,
            };
            responses.push(response);
        }
        Ok(responses)
    }
}

impl QueryHandler {
    /// Runs one statement of a simple query.
    async fn run_simple<C>(
        &self,
        client: &mut C,
        statement: DFStatement,
        status: TransactionStatus,
    ) -> PgWireResult<Response>
    where
        C: ClientInfo,
    {
        let settings = Settings::of(client.metadata());
        let action = self
            .sql
            .plan_statement(statement, &settings, status)
            .await
            .map_err(query_error)?;
        let plan = match action {
            Action::Query(plan) => plan,
            Action::Change(change) => {
                change.apply(client.metadata_mut());
                return Ok(Response::Execution(Tag::new(change.tag())));
            }
            Action::Transaction(txn) => return Ok(txn.response(status)),
        };
        let (schema, batches) = self
            .sql
            .execute(plan, &settings)
            .await
            .map_err(query_error)?;
        let columns = columns_of(&schema);
        let fields = Arc::new(field_infos(&columns, &Format::UnifiedText)?);
        let rows = encode_rows(&fields, &batches)?;
        Ok(Response::Query(QueryResponse::new(
            fields,
            stream::iter(rows.into_iter().map(Ok)),
        )))
    }
}

/// A statement from a Parse message: planned once, executed on every Bind/Execute.
#[derive(Debug)]
pub struct Prepared {
    /// The plan with `$n` placeholders still in it, or the `SET` it makes.
    action: Action,
    /// The Arrow type each `$n` binds as (index 0 is `$1`).
    params: Vec<DataType>,
    /// The Postgres type each `$n` is described as.
    param_types: Vec<Type>,
    /// Result column names and Postgres types.
    columns: Vec<(String, Type)>,
}

#[async_trait]
impl QueryParser for Sql {
    type Statement = Arc<Prepared>;

    async fn parse_sql<C>(
        &self,
        client: &C,
        sql: &str,
        types: &[Option<Type>],
    ) -> PgWireResult<Option<Arc<Prepared>>>
    where
        C: ClientInfo + Unpin + Send + Sync,
    {
        let settings = Settings::of(client.metadata());
        let action = self
            .plan(sql, &settings, client.transaction_status())
            .await
            .map_err(query_error)?;
        let prepared = match action {
            Action::Query(plan) => prepare(plan, types)?,
            action @ (Action::Change(_) | Action::Transaction(_)) => Prepared {
                action,
                params: vec![],
                param_types: vec![],
                columns: vec![],
            },
        };
        Ok(Some(Arc::new(prepared)))
    }

    fn get_parameter_types(&self, stmt: &Arc<Prepared>) -> PgWireResult<Vec<Type>> {
        Ok(stmt.param_types.clone())
    }

    fn get_result_schema(
        &self,
        stmt: &Arc<Prepared>,
        column_format: Option<&Format>,
    ) -> PgWireResult<Vec<FieldInfo>> {
        field_infos(&stmt.columns, column_format.unwrap_or(&Format::UnifiedText))
    }
}

#[async_trait]
impl ExtendedQueryHandler for QueryHandler {
    type Statement = Arc<Prepared>;
    type QueryParser = Sql;

    fn query_parser(&self) -> Arc<Sql> {
        self.sql.clone()
    }

    // Postgres describes a statement's columns as text; the format is only known at Bind.
    async fn do_describe_statement<C>(
        &self,
        _client: &mut C,
        target: &StoredStatement<Arc<Prepared>>,
    ) -> PgWireResult<DescribeStatementResponse>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = Arc<Prepared>>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let stmt = &target.statement;
        Ok(DescribeStatementResponse::new(
            stmt.param_types.clone(),
            field_infos(&stmt.columns, &Format::UnifiedText)?,
        ))
    }

    async fn do_describe_portal<C>(
        &self,
        _client: &mut C,
        target: &Portal<Arc<Prepared>>,
    ) -> PgWireResult<DescribePortalResponse>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = Arc<Prepared>>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let columns = &target.statement.statement.columns;
        Ok(DescribePortalResponse::new(field_infos(
            columns,
            &target.result_column_format,
        )?))
    }

    async fn do_query<C>(
        &self,
        client: &mut C,
        portal: &Portal<Arc<Prepared>>,
        _max_rows: usize,
    ) -> PgWireResult<Response>
    where
        C: ClientInfo + ClientPortalStore + Sink<PgWireBackendMessage> + Unpin + Send + Sync,
        C::PortalStore: PortalStore<Statement = Arc<Prepared>>,
        C::Error: Debug,
        PgWireError: From<<C as Sink<PgWireBackendMessage>>::Error>,
    {
        let stmt = &portal.statement.statement;
        let status = client.transaction_status();
        stmt.action.check_not_aborted(status)?;
        let values = bind_params(stmt, portal)?;
        let plan = match &stmt.action {
            Action::Query(plan) => plan.clone(),
            Action::Change(change) => {
                change.apply(client.metadata_mut());
                return Ok(Response::Execution(Tag::new(change.tag())));
            }
            Action::Transaction(txn) => return Ok(txn.response(status)),
        };
        let plan = plan.with_param_values(values).map_err(query_error)?;
        let settings = Settings::of(client.metadata());
        let (_, batches) = self
            .sql
            .execute(plan, &settings)
            .await
            .map_err(query_error)?;
        // Encoded as described, so binary values match the types in RowDescription.
        let fields = Arc::new(field_infos(&stmt.columns, &portal.result_column_format)?);
        let rows = encode_rows(&fields, &batches)?;
        Ok(Response::Query(QueryResponse::new(
            fields,
            stream::iter(rows.into_iter().map(Ok)),
        )))
    }
}

/// Settles parameter and result types for a planned statement.
///
/// A parameter's type is, in order: the one the client declared in Parse, the one DataFusion
/// inferred from context (`col = $1`), the target of a direct cast (`$1::bigint`), else text.
fn prepare(plan: LogicalPlan, declared: &[Option<Type>]) -> PgWireResult<Prepared> {
    let inferred = placeholder_types(&plan).map_err(query_error)?;
    let count = inferred
        .keys()
        .copied()
        .max()
        .unwrap_or(0)
        .max(declared.len());
    let mut params = Vec::with_capacity(count);
    let mut param_types = Vec::with_capacity(count);
    for i in 0..count {
        match declared.get(i).cloned().flatten() {
            Some(ty) => {
                params.push(arrow_type_of(&ty)?);
                param_types.push(ty);
            }
            None => {
                let dt = inferred.get(&(i + 1)).cloned().flatten();
                let dt = dt.unwrap_or(DataType::Utf8);
                param_types.push(pg_type(&dt));
                params.push(dt);
            }
        }
    }
    let columns = columns_of(plan.schema().as_arrow());
    Ok(Prepared {
        action: Action::Query(plan),
        params,
        param_types,
        columns,
    })
}

/// The type of every `$n` placeholder in the plan, keyed by `n`.
fn placeholder_types(
    plan: &LogicalPlan,
) -> Result<HashMap<usize, Option<DataType>>, DataFusionError> {
    let mut types: HashMap<usize, Option<DataType>> = HashMap::new();
    let mut note = |id: &str, dt: Option<&DataType>| -> Result<(), DataFusionError> {
        let n = id
            .strip_prefix('$')
            .and_then(|n| n.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .ok_or_else(|| {
                DataFusionError::NotImplemented(format!(
                    "parameter {id} is not supported; use $1, $2, ..."
                ))
            })?;
        let slot = types.entry(n).or_default();
        if slot.is_none() {
            *slot = dt.cloned();
        }
        Ok(())
    };
    plan.apply_with_subqueries(|p| {
        p.apply_expressions(|e| {
            e.apply(|e| {
                match e {
                    Expr::Placeholder(ph) => {
                        note(&ph.id, ph.field.as_ref().map(|f| f.data_type()))?
                    }
                    Expr::Cast(Cast { expr, field }) | Expr::TryCast(TryCast { expr, field }) => {
                        if let Expr::Placeholder(ph) = expr.as_ref()
                            && ph.field.is_none()
                        {
                            note(&ph.id, Some(field.data_type()))?;
                        }
                    }
                    _ => {}
                }
                Ok(TreeNodeRecursion::Continue)
            })
        })
    })?;
    Ok(types)
}

/// The Arrow type a client-declared parameter type binds as.
fn arrow_type_of(ty: &Type) -> PgWireResult<DataType> {
    Ok(match *ty {
        Type::BOOL => DataType::Boolean,
        Type::INT2 => DataType::Int16,
        Type::INT4 => DataType::Int32,
        Type::INT8 => DataType::Int64,
        Type::FLOAT4 => DataType::Float32,
        Type::FLOAT8 => DataType::Float64,
        Type::TIMESTAMP => DataType::Timestamp(TimeUnit::Microsecond, None),
        Type::TIMESTAMPTZ => DataType::Timestamp(TimeUnit::Microsecond, Some("+00:00".into())),
        Type::DATE => DataType::Date32,
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => DataType::Utf8,
        _ => {
            return Err(user_error(
                "0A000",
                format!("parameter type {} is not supported", ty.name()),
            ));
        }
    })
}

/// Microseconds from the Unix epoch to the Postgres epoch (2000-01-01).
const PG_EPOCH_MICROS: i64 = 946_684_800_000_000;
/// Days from the Unix epoch to the Postgres epoch (2000-01-01).
const PG_EPOCH_DAYS: i32 = 10_957;

/// The values a portal's parameters bind as, in `$n` order.
fn bind_params(stmt: &Prepared, portal: &Portal<Arc<Prepared>>) -> PgWireResult<Vec<ScalarValue>> {
    if portal.parameters.len() != stmt.params.len() {
        return Err(user_error(
            "08P01",
            format!(
                "bind message supplies {} parameters, but prepared statement requires {}",
                portal.parameters.len(),
                stmt.params.len()
            ),
        ));
    }
    check_format_count(&portal.parameter_format, stmt.params.len(), "parameter")?;
    stmt.params
        .iter()
        .zip(&portal.parameters)
        .enumerate()
        .map(|(i, (dt, value))| {
            let Some(bytes) = value else {
                return ScalarValue::try_from(dt).map_err(query_error);
            };
            let value = if portal.parameter_format.is_binary(i) {
                decode_binary(&pg_type(dt), bytes).ok_or_else(|| {
                    user_error(
                        "22P03",
                        format!("invalid binary value for parameter ${}", i + 1),
                    )
                })?
            } else {
                let text = std::str::from_utf8(bytes).map_err(|_| {
                    user_error("22021", format!("parameter ${} is not valid UTF-8", i + 1))
                })?;
                ScalarValue::Utf8(Some(text.to_string()))
            };
            value.cast_to(dt).map_err(|e| {
                user_error(
                    "22P02",
                    format!("invalid value for parameter ${} of type {dt}: {e}", i + 1),
                )
            })
        })
        .collect()
}

/// Decodes a binary-format parameter of the given Postgres type; `None` if the bytes don't fit.
fn decode_binary(ty: &Type, b: &[u8]) -> Option<ScalarValue> {
    Some(match *ty {
        Type::BOOL => ScalarValue::Boolean(Some(*<&[u8; 1]>::try_from(b).ok()? != [0])),
        Type::INT2 => ScalarValue::Int16(Some(i16::from_be_bytes(b.try_into().ok()?))),
        Type::INT4 => ScalarValue::Int32(Some(i32::from_be_bytes(b.try_into().ok()?))),
        Type::INT8 => ScalarValue::Int64(Some(i64::from_be_bytes(b.try_into().ok()?))),
        Type::FLOAT4 => ScalarValue::Float32(Some(f32::from_be_bytes(b.try_into().ok()?))),
        Type::FLOAT8 => ScalarValue::Float64(Some(f64::from_be_bytes(b.try_into().ok()?))),
        Type::TIMESTAMP | Type::TIMESTAMPTZ => {
            let micros = i64::from_be_bytes(b.try_into().ok()?).checked_add(PG_EPOCH_MICROS)?;
            let tz = (*ty == Type::TIMESTAMPTZ).then(|| "+00:00".into());
            ScalarValue::TimestampMicrosecond(Some(micros), tz)
        }
        Type::DATE => {
            let days = i32::from_be_bytes(b.try_into().ok()?).checked_add(PG_EPOCH_DAYS)?;
            ScalarValue::Date32(Some(days))
        }
        _ => ScalarValue::Utf8(Some(std::str::from_utf8(b).ok()?.to_string())),
    })
}

/// Rejects a Bind whose per-column format codes don't match the column count.
fn check_format_count(format: &Format, count: usize, what: &str) -> PgWireResult<()> {
    match format {
        Format::Individual(codes) if codes.len() != count => Err(user_error(
            "08P01",
            format!(
                "bind message has {} {what} formats but {count} {what}s",
                codes.len()
            ),
        )),
        _ => Ok(()),
    }
}

/// Result column names and Postgres types for an Arrow schema.
fn columns_of(schema: &Schema) -> Vec<(String, Type)> {
    schema
        .fields()
        .iter()
        .map(|f| {
            let json =
                f.metadata().get(EXTENSION_NAME_KEY).map(String::as_str) == Some(JSON_EXTENSION);
            let ty = match f.data_type() {
                DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View if json => Type::JSON,
                dt => pg_type(dt),
            };
            (f.name().clone(), ty)
        })
        .collect()
}

/// RowDescription fields for the columns, each in the format the client asked for.
fn field_infos(columns: &[(String, Type)], format: &Format) -> PgWireResult<Vec<FieldInfo>> {
    check_format_count(format, columns.len(), "result")?;
    Ok(columns
        .iter()
        .enumerate()
        .map(|(i, (name, ty))| {
            FieldInfo::new(name.clone(), None, None, ty.clone(), format.format_for(i))
        })
        .collect())
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

/// Encodes every row, each column in its field's format (text, or Postgres binary).
fn encode_rows(
    fields: &Arc<Vec<FieldInfo>>,
    batches: &[RecordBatch],
) -> PgWireResult<Vec<DataRow>> {
    let options = FormatOptions::default();
    let pg_options = PgFormatOptions::default();
    let mut encoder = DataRowEncoder::new(fields.clone());
    let mut rows = Vec::new();
    for batch in batches {
        // Columns are first cast to the Arrow type their Postgres type is read from.
        let columns = batch
            .columns()
            .iter()
            .zip(fields.iter())
            .map(|(c, f)| {
                wire_source_type(f.datatype(), c.data_type())
                    .map_or_else(|| Ok(c.clone()), |dt| cast(c, &dt))
            })
            .collect::<Result<Vec<ArrayRef>, _>>()
            .map_err(|e| query_error(e.into()))?;
        // The zone of each timestamptz column, for its Postgres text form.
        let zones = columns
            .iter()
            .map(|c| match c.data_type() {
                DataType::Timestamp(_, Some(tz)) => tz.parse::<Tz>().map(Some),
                _ => Ok(None),
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| query_error(e.into()))?;
        let formatters = columns
            .iter()
            .map(|c| ArrayFormatter::try_new(c.as_ref(), &options))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| query_error(e.into()))?;
        // Logical nulls: a `NullArray` (e.g. `SELECT NULL`) has no validity buffer.
        let nulls: Vec<_> = columns.iter().map(|c| c.logical_nulls()).collect();
        for row in 0..batch.num_rows() {
            for ((((col, formatter), nulls), field), zone) in columns
                .iter()
                .zip(&formatters)
                .zip(&nulls)
                .zip(fields.iter())
                .zip(&zones)
            {
                if nulls.as_ref().is_some_and(|n| n.is_null(row)) {
                    encoder.encode_field(&None::<String>)?;
                    continue;
                }
                let binary = field.format() == FieldFormat::Binary;
                let mut put = |v: &dyn PutValue, ty: &Type| {
                    v.put(&mut encoder, ty, field.format(), &pg_options)
                };
                match (binary, field.datatype()) {
                    (_, &Type::BOOL) => put(&col.as_boolean().value(row), &Type::BOOL)?,
                    (true, &Type::INT2) => {
                        put(&col.as_primitive::<Int16Type>().value(row), &Type::INT2)?
                    }
                    (true, &Type::INT4) => {
                        put(&col.as_primitive::<Int32Type>().value(row), &Type::INT4)?
                    }
                    (true, &Type::INT8) => {
                        put(&col.as_primitive::<Int64Type>().value(row), &Type::INT8)?
                    }
                    (true, &Type::FLOAT4) => {
                        put(&col.as_primitive::<Float32Type>().value(row), &Type::FLOAT4)?
                    }
                    (true, &Type::FLOAT8) => {
                        put(&col.as_primitive::<Float64Type>().value(row), &Type::FLOAT8)?
                    }
                    // Same wire layout as int8: microseconds since 2000-01-01.
                    (true, &Type::TIMESTAMP | &Type::TIMESTAMPTZ) => {
                        let micros = col.as_primitive::<TimestampMicrosecondType>().value(row);
                        put(&(micros - PG_EPOCH_MICROS), &Type::INT8)?
                    }
                    (false, &Type::TIMESTAMP | &Type::TIMESTAMPTZ) => {
                        let micros = col.as_primitive::<TimestampMicrosecondType>().value(row);
                        match timestamp_text(micros, zone.as_ref()) {
                            Some(text) => put(&text, &Type::TEXT)?,
                            None => put(&formatter.value(row).to_string(), &Type::TEXT)?,
                        }
                    }
                    (false, &Type::FLOAT8) => {
                        let v = col.as_primitive::<Float64Type>().value(row);
                        match float_special(v) {
                            Some(text) => put(&text, &Type::TEXT)?,
                            None => put(&formatter.value(row).to_string(), &Type::TEXT)?,
                        }
                    }
                    (false, &Type::FLOAT4) => {
                        let v = col.as_primitive::<Float32Type>().value(row);
                        match float_special(v.into()) {
                            Some(text) => put(&text, &Type::TEXT)?,
                            None => put(&formatter.value(row).to_string(), &Type::TEXT)?,
                        }
                    }
                    // Same wire layout as int4: days since 2000-01-01.
                    (true, &Type::DATE) => {
                        let days = col.as_primitive::<Date32Type>().value(row);
                        put(&(days - PG_EPOCH_DAYS), &Type::INT4)?
                    }
                    _ => put(&formatter.value(row).to_string(), &Type::TEXT)?,
                }
            }
            rows.push(encoder.take_row());
        }
    }
    Ok(rows)
}

/// Postgres text for the floats Arrow prints differently (`NaN`, `inf`): `NaN`, `Infinity`,
/// `-Infinity`. `None` for finite values.
fn float_special(v: f64) -> Option<&'static str> {
    if v.is_nan() {
        Some("NaN")
    } else if v.is_infinite() {
        Some(if v > 0.0 { "Infinity" } else { "-Infinity" })
    } else {
        None
    }
}

/// Postgres text output for a timestamp (`2026-01-02 03:04:05.5`) or, given its zone, a
/// timestamptz (`2026-01-02 03:04:05.5+00`, `...+05:30`). `None` if out of chrono's range.
fn timestamp_text(micros: i64, zone: Option<&Tz>) -> Option<String> {
    let utc = DateTime::from_timestamp_micros(micros)?;
    let Some(zone) = zone else {
        return Some(naive_text(&utc.naive_utc()));
    };
    let local = zone.from_utc_datetime(&utc.naive_utc());
    let offset = local.offset().fix().local_minus_utc();
    let (sign, offset) = if offset < 0 {
        ('-', -offset)
    } else {
        ('+', offset)
    };
    let mut text = format!(
        "{}{sign}{:02}",
        naive_text(&local.naive_local()),
        offset / 3600
    );
    if offset % 3600 != 0 {
        text.push_str(&format!(":{:02}", offset / 60 % 60));
    }
    if offset % 60 != 0 {
        text.push_str(&format!(":{:02}", offset % 60));
    }
    Some(text)
}

/// `YYYY-MM-DD HH:MM:SS` plus the microseconds, trailing zeros trimmed, as Postgres prints them.
fn naive_text(t: &NaiveDateTime) -> String {
    let mut text = t.format("%Y-%m-%d %H:%M:%S").to_string();
    let micros = t.nanosecond() / 1000;
    if micros != 0 {
        text.push_str(format!(".{micros:06}").trim_end_matches('0'));
    }
    text
}

/// The Arrow type a column of this Postgres type is read from, if it must be cast.
fn wire_source_type(ty: &Type, dt: &DataType) -> Option<DataType> {
    Some(match *ty {
        Type::INT2 => DataType::Int16,
        Type::INT4 => DataType::Int32,
        Type::INT8 => DataType::Int64,
        Type::FLOAT4 => DataType::Float32,
        Type::FLOAT8 => DataType::Float64,
        Type::TIMESTAMP | Type::TIMESTAMPTZ => match dt {
            DataType::Timestamp(_, tz) => DataType::Timestamp(TimeUnit::Microsecond, tz.clone()),
            _ => return None,
        },
        Type::DATE => DataType::Date32,
        _ => return None,
    })
}

/// A value [`DataRowEncoder`] can write, with the wire type and format chosen per call.
trait PutValue {
    fn put(
        &self,
        encoder: &mut DataRowEncoder,
        ty: &Type,
        format: FieldFormat,
        options: &PgFormatOptions,
    ) -> PgWireResult<()>;
}

impl<T: postgres_types::ToSql + pgwire::types::ToSqlText> PutValue for T {
    fn put(
        &self,
        encoder: &mut DataRowEncoder,
        ty: &Type,
        format: FieldFormat,
        options: &PgFormatOptions,
    ) -> PgWireResult<()> {
        encoder.encode_field_with_type_and_format(self, ty, format, options)
    }
}

/// Maps a DataFusion error to an ErrorResponse with a SQLSTATE.
fn query_error(e: DataFusionError) -> PgWireError {
    let root = e.find_root();
    if let DataFusionError::External(inner) = root
        && let Some(e) = inner.downcast_ref::<SqlStateError>()
    {
        return user_error(e.code, e.message.clone());
    }
    let code = match root {
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
    user_error(code, e.to_string())
}

/// An ErrorResponse with severity ERROR.
fn user_error(code: &str, message: String) -> PgWireError {
    PgWireError::UserError(Box::new(ErrorInfo::new(
        "ERROR".to_string(),
        code.to_string(),
        message,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use datafusion::arrow::array::{
        BooleanArray, Int32Array, Int64Array, NullArray, StringArray, TimestampSecondArray,
    };

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

    /// Plans and runs a query in a fresh session.
    fn run(sql: &str) -> Result<(Schema, Vec<RecordBatch>), DataFusionError> {
        futures::executor::block_on(async {
            let sql_ = Sql::new();
            let settings = Settings::default();
            match sql_.plan(sql, &settings, TransactionStatus::Idle).await? {
                Action::Query(plan) => sql_.execute(plan, &settings).await,
                other => panic!("not a query: {other:?}"),
            }
        })
    }

    fn sqlstate_of(sql: &str) -> String {
        let e = run(sql).unwrap_err();
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
        let rows = encode_rows(&fields, &[batch]).unwrap();
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

    fn prepared(sql: &str, declared: &[Option<Type>]) -> Prepared {
        let sql_ = Sql::new();
        let action = futures::executor::block_on(sql_.plan(
            sql,
            &Settings::default(),
            TransactionStatus::Idle,
        ))
        .unwrap();
        let Action::Query(plan) = action else {
            panic!("not a query: {sql}")
        };
        prepare(plan, declared).unwrap()
    }

    #[test]
    fn parameter_types_come_from_declarations_then_casts_then_text() {
        let p = prepared("SELECT $1::bigint + 1 AS n, $2::text AS t", &[]);
        assert_eq!(p.param_types, [Type::INT8, Type::TEXT]);
        assert_eq!(
            p.columns,
            [("n".to_string(), Type::INT8), ("t".to_string(), Type::TEXT)]
        );
        // A client-declared type wins over the cast target.
        let p = prepared("SELECT $1::bigint * 2 AS d", &[Some(Type::INT4)]);
        assert_eq!(p.param_types, [Type::INT4]);
        assert_eq!(p.params, [DataType::Int32]);
        // Declared but unused parameters still count.
        let p = prepared("SELECT 1", &[None, Some(Type::BOOL)]);
        assert_eq!(p.param_types, [Type::TEXT, Type::BOOL]);
    }

    #[test]
    fn timestamps_use_postgres_text_style() {
        // 2026-01-02 03:04:05 UTC.
        let t = 1_767_323_045_000_000;
        let zone = |z: &str| z.parse::<Tz>().unwrap();
        assert_eq!(timestamp_text(t, None).unwrap(), "2026-01-02 03:04:05");
        assert_eq!(
            timestamp_text(t, Some(&zone("+00:00"))).unwrap(),
            "2026-01-02 03:04:05+00"
        );
        assert_eq!(
            timestamp_text(t + 500_000, Some(&zone("+05:30"))).unwrap(),
            "2026-01-02 08:34:05.5+05:30"
        );
        assert_eq!(
            timestamp_text(t + 123, Some(&zone("-08:00"))).unwrap(),
            "2026-01-01 19:04:05.000123-08"
        );
    }

    #[test]
    fn binary_parameters_decode_by_postgres_type() {
        assert_eq!(
            decode_binary(&Type::INT8, &41i64.to_be_bytes()),
            Some(ScalarValue::Int64(Some(41)))
        );
        assert_eq!(
            decode_binary(&Type::BOOL, &[1]),
            Some(ScalarValue::Boolean(Some(true)))
        );
        assert_eq!(
            decode_binary(&Type::DATE, &0i32.to_be_bytes()),
            Some(ScalarValue::Date32(Some(PG_EPOCH_DAYS)))
        );
        assert_eq!(
            decode_binary(&Type::TEXT, b"hi"),
            Some(ScalarValue::Utf8(Some("hi".to_string())))
        );
        assert_eq!(decode_binary(&Type::INT8, &[0, 1]), None);
        assert_eq!(decode_binary(&Type::TEXT, &[0xff]), None);
    }

    #[test]
    fn binary_rows_use_the_described_wire_types() {
        let cols: Vec<ArrayRef> = vec![
            // Int32 data described as int8 still goes out as 8 bytes.
            Arc::new(Int32Array::from(vec![42])),
            Arc::new(StringArray::from(vec!["hi"])),
            Arc::new(TimestampSecondArray::from(vec![946_684_801])),
        ];
        let batch = RecordBatch::try_from_iter(["n", "t", "ts"].into_iter().zip(cols)).unwrap();
        let columns = vec![
            ("n".to_string(), Type::INT8),
            ("t".to_string(), Type::TEXT),
            ("ts".to_string(), Type::TIMESTAMP),
        ];
        let fields = Arc::new(field_infos(&columns, &Format::UnifiedBinary).unwrap());
        let rows = encode_rows(&fields, &[batch]).unwrap();
        assert_eq!(
            &rows[0].data[..],
            b"\0\0\0\x08\0\0\0\0\0\0\0\x2a\0\0\0\x02hi\0\0\0\x08\0\0\0\0\0\x0f\x42\x40"
        );
        assert!(field_infos(&columns, &Format::Individual(vec![1])).is_err());
    }

    #[test]
    fn information_schema_lists_its_own_tables() {
        // The information_schema scan spawns tasks, so it needs a Tokio runtime.
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _guard = runtime.enter();
        let (_, batches) = run("SELECT table_name FROM information_schema.tables \
             WHERE table_schema = 'information_schema'")
        .unwrap();
        let names: Vec<String> = batches
            .iter()
            .flat_map(|b| {
                let col = b.column(0).as_string::<i32>();
                (0..col.len())
                    .map(|i| col.value(i).to_string())
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(names.iter().any(|n| n == "tables"), "{names:?}");
        assert!(names.iter().any(|n| n == "columns"), "{names:?}");
    }

    #[test]
    fn version_reports_postgres_16_and_the_crate_version() {
        let (_, batches) = run("SELECT version()").unwrap();
        let v = batches[0].column(0).as_string::<i32>().value(0).to_string();
        let crate_version = env!("CARGO_PKG_VERSION");
        assert_eq!(
            v,
            format!("PostgreSQL 16.0 (hrx-federation-engine {crate_version})")
        );
        assert!(v.starts_with(&format!("PostgreSQL {SERVER_VERSION} ")));
    }
}
