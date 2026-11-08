# HouseRx Federation Engine

The Federation Engine speaks the Postgres wire protocol to Lightdash and serves HouseRx's
Telemetry Sources (Prometheus, Loki, CloudWatch, CloudWatch Logs, Tempo), the Platform Database
and the Ops Marts as SQL. It is built on Apache DataFusion. Every source is a table function, and
SQL written on top of a function (joins, aggregates, filters) runs inside the engine.

It listens on two ports:

- **pg-wire** (`listen_pg`, 5433 by convention): Lightdash and any Postgres client log in here as
  a `[[users]]` entry. TLS is available.
- **HTTP** (`listen_http`, 8088 by convention):
  - `GET /healthz` (no auth): 200 when every source is reachable, 503 naming the sources that aren't.
  - `GET /metrics` (no auth): Prometheus exposition. It has per-source query counts, latency
    histograms, errors and audit write failures.
  - `POST /v1/write`: Write Mode (Preview and commit) on the Platform Database.
  - `POST /v1/write/confirmations/verify`: only with `test_mode = true`.
  - `GET /v1/audit`: the audit browser (`?month=`, `?ticket=`, `?user=`).

## SQL functions

| Function | Source kind |
|---|---|
| `promql(query, start, end, step [, source])`, `promql_instant(...)` | `prometheus` |
| `logql(...)`, `logql_metric(...)` | `loki` |
| `cloudwatch(...)` | `cloudwatch` |
| `cloudwatch_logs(...)` | `cloudwatch_logs` |
| `traceql(...)`, `trace(...)` | `tempo` |
| `platform_query(sql)`, `platform_tables()`, `platform_columns(...)`, `platform_explain(sql)` | `platform_postgres` |
| `ops_marts.<dataset>.<table>` (tables, not functions) | `bigquery` |

Scalar helpers: `label(labels, name)`, `series_name(labels)`, `version()` and `current_setting(name)`.
A function without a `source` argument reads the default source of its kind (see `default` below).

```sql
SELECT series, avg(value)
FROM promql('rate(http_requests_total[5m])', '2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z', '1m')
GROUP BY series;
```

## Building and running it

You need Rust 1.85 or later (edition 2024). The repo pins rustc 1.99. Building `aws-lc-sys` also
needs `cmake` and `clang`.

```bash
# release build; the binary is federation-engine/target/release/engine
cargo build --release --manifest-path federation-engine/Cargo.toml --bin engine

# validate a config: parses it and resolves every *_env variable, but binds no port and contacts no source
federation-engine/target/release/engine --check-config --config federation-engine.toml

# serve
federation-engine/target/release/engine --config federation-engine.toml
```

`--check-config` prints `engine: config <path> is valid (N sources, N users, audit on|off)` and
exits 0. If the config is invalid, it lists every problem and exits 1. Problems name keys and
environment variables, never their values. With bad arguments, the engine exits 2.

When serving, the engine writes JSON log lines (`timestamp`, `level`, `message`, fields) to stderr.
They never contain query results, identity tokens or their payload, or secrets. On SIGTERM it stops
accepting connections, lets in-flight queries finish, and exits 0.

**Container.** `docker build federation-engine` builds the image from `federation-engine/Dockerfile`.
The final distroless stage runs as a non-root user, exposes 5433 and 8088, and starts
`engine --config /etc/federation-engine/federation-engine.toml`. Mount the config read-only at that
path, set `listen_pg`/`listen_http` to `0.0.0.0:…` so they are reachable from outside the container,
and pass secrets through the environment variables the config names.

**Tests.** Run `bash ./init.sh` from the repo root to build everything. Run one acceptance check
with `cargo test --manifest-path federation-engine/Cargo.toml --test acceptance -- <module>::<test> --exact`.
The acceptance tests start their own mocks and throwaway Postgres on 127.0.0.1.

## Configuration

The config is one TOML file, passed with `--config`. Unknown keys are errors, and so are keys that
belong to a different source kind. Secrets never appear in the file. Every `*_env` key names an
environment variable, and the engine reads it at startup. A variable that is unset or empty is a
config error.

```toml
# --- listeners -----------------------------------------------------------------------------
listen_pg = "0.0.0.0:5433"            # pg-wire (Lightdash, psql). Required. host:port
listen_http = "0.0.0.0:8088"          # /healthz, /metrics, /v1/write, /v1/audit. Required; must differ from listen_pg
# Optional TLS for pg-wire (PEM files). Set both or neither.
tls_cert_file = "/etc/federation-engine/tls/server.crt"
tls_key_file = "/etc/federation-engine/tls/server.key"

# --- identity and limits -------------------------------------------------------------------
identity_secret_env = "HRX_IDENTITY_SECRET"   # Required. Env var with the HMAC key shared with Lightdash; it
                                              # verifies identity tokens and Write Mode confirmation tokens
max_rows = 100000                             # Optional (default 100000). Most rows one table-function call may return
test_mode = false                             # Optional (default false). true enables POST /v1/write/confirmations/verify.
                                              # Never true in production

# --- pg-wire logins (one block per login) --------------------------------------------------
[[users]]
name = "lightdash-operations"                 # pg-wire user name
password_env = "HRX_PG_PASSWORD_OPERATIONS"   # env var holding its password (cleartext, MD5 and SCRAM accepted)

# --- sources -------------------------------------------------------------------------------
# Every source has: name (unique; the optional last argument of its functions), kind,
# default (bool; at most one per kind; a lone source of a kind is always its default),
# restricted (bool; marks it Restricted Telemetry, so reading it is an Audited Query and needs [audit]),
# and max_rows (optional per-source override of the top-level max_rows).

[[sources]]
name = "prometheus"
kind = "prometheus"                   # prometheus | loki | cloudwatch | cloudwatch_logs | tempo | platform_postgres | bigquery
default = true
url = "http://prometheus.monitoring:9090"     # base URL (prometheus, loki, tempo)

[[sources]]
name = "prometheus-restricted"
kind = "prometheus"
restricted = true                     # the whole source is Restricted Telemetry
max_rows = 50000                      # per-source override
url = "http://prometheus-restricted.monitoring:9090"

[[sources]]
name = "loki"
kind = "loki"
url = "http://loki.monitoring:3100"
# Streams these selectors might match are Restricted Telemetry. A query selector is open only
# when it provably excludes each of them (label="v" where the restricted selector has label="w").
restricted_selectors = ['{namespace="platform"}']

[[sources]]
name = "cloudwatch"
kind = "cloudwatch"
region = "us-east-2"                  # required for cloudwatch and cloudwatch_logs
role_arn = "arn:aws:iam::123456789012:role/federation-engine-read"   # optional: assumed through STS on top of the default AWS credential chain
endpoint_url = "http://localhost:4566"          # optional: service endpoint override (tests, VPC endpoints)
sts_endpoint_url = "http://localhost:4566"      # optional: STS endpoint override for role_arn

[[sources]]
name = "cloudwatch-logs"
kind = "cloudwatch_logs"
region = "us-east-2"                  # role_arn, endpoint_url and sts_endpoint_url work as for cloudwatch
restricted_log_groups = ["/aws/rds/platform"]   # exact log group names that are Restricted Telemetry
poll_interval_ms = 1000               # optional (default 1000): Logs Insights GetQueryResults poll interval

[[sources]]
name = "tempo"
kind = "tempo"
url = "http://tempo.monitoring:3200"

[[sources]]
name = "platform"
kind = "platform_postgres"            # the Platform Database; always audited, so it needs [audit]
read_url_env = "PLATFORM_READ_URL"    # required: env var with a postgres:// URL for a read-only role
write_url_env = "PLATFORM_WRITE_URL"  # optional: env var with the Write Mode role's URL; unset turns Write Mode off (503)

[[sources]]
name = "ops-marts"
kind = "bigquery"                     # Ops Marts: read with a login only, not audited
project = "houserx-ops-marts"         # GCP project that runs the BigQuery jobs
allow = ["marts.daily_orders"]        # dataset.table entries exposed as ops_marts.<dataset>.<table>; anything else is invisible
api_base_url = "https://bigquery.googleapis.com"   # optional (this is the default)
# Token source: set EITHER access_token_env (a static bearer, for tests) OR workload identity federation:
# access_token_env = "BIGQUERY_ACCESS_TOKEN"
workload_identity_audience = "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/aws/providers/aws"
service_account = "federation-engine@houserx-ops-marts.iam.gserviceaccount.com"   # impersonated after the STS exchange
gcp_sts_url = "https://sts.googleapis.com/v1/token"                    # optional (default shown)
gcp_iam_credentials_url = "https://iamcredentials.googleapis.com"      # optional (default shown)

# --- audit (required when any source is audited) -------------------------------------------
[audit]
dynamodb_table = "lightdash-sql-executions"     # required: the portal's executions table (with its GSIs)
s3_bucket = "houserx-sql-executions"            # required: Object Lock bucket for the immutable copy
integrity_key_env = "AUDIT_INTEGRITY_KEY"       # optional: env var with the HMAC key for integrityHash; without it the hash is plain sha256:
region = "us-east-2"                            # optional: AWS region for DynamoDB and S3 (default: the AWS chain's region)
dynamodb_endpoint_url = "http://localhost:4566" # optional endpoint override
s3_endpoint_url = "http://localhost:4566"       # optional endpoint override; switches S3 to path-style
s3_retention_days = 2555                        # optional (default 2555): COMPLIANCE retain-until, in days from the write
```

The example sets every key so that each one is documented. A real config leaves out what it
doesn't need, such as the endpoint overrides, `test_mode` and one of the two BigQuery token sources.
AWS credentials come from the standard AWS chain (environment, web identity, instance role), never
from this file.

## Security model

**Identity tokens.** Before each query, Lightdash (or the MCP server) sends
`SET hrx.identity = '<token>'` on its pg-wire session. The token is
`base64url(payload).base64url(HMAC-SHA256(identity_secret, base64url(payload)))`, unpadded. The
engine checks it every time a statement runs. It must have a valid signature, `v = 1`, an
unexpired `exp`, an `iat` no more than 60 s in the future, a lifetime (`exp − iat`) of at most
300 s, and string `sub` and `email`. A token that fails any check counts as no identity at all,
never as a partial one. The identity lasts until the next `SET`. The claims the engine acts on
are `attrs.telemetry_restricted`, `attrs.platform_read`, `attrs.platform_explain`,
`attrs.platform_write`, `agent`, `sys`, `project`, and `audit.description` / `audit.ticket`. If
`agent` is anything other than an explicit `false`, or `iss` is `telemetry-mcp`, the token is
treated as an AI agent. Unclear tokens get less access. The pg-wire password only lets the client
connect. The token decides what the session may read.

**Restricted Telemetry.** These sources are Restricted Telemetry: a source with
`restricted = true`, Loki streams that may match `restricted_selectors`, and CloudWatch log groups
in `restricted_log_groups`. Reading one needs `attrs.telemetry_restricted` and a non-empty
`audit.description`. AI agent identities may never read Restricted Telemetry, whatever their attrs
say. The system identity (`sys = true`, `agent = false`) is checked like a person. Access is
checked for every table-function call when the statement is planned, so joins and subqueries
can't get around it. Unrestricted Telemetry Sources and Ops Marts need only a login.

**Platform Database.** `platform_query`, `platform_tables` and `platform_columns` need
`attrs.platform_read`. `platform_explain` needs `platform_read` or `platform_explain`. Each needs
a description too. Statements pass the portal's read-mode guard and then run on the read-only
role from `read_url_env`. Agents with `platform_read` may read the Platform Database (audited as
`ai_ask`).

**42501.** Every refusal is SQLSTATE `42501` (insufficient_privilege), and its message names what
is missing: the claim (`telemetry_restricted`, `platform_read`, `platform_explain`), `agent` for
an AI agent identity, `audited query requires a description`, or the portal guard's message for
a rejected statement. Tables outside the Ops Mart allowlist are `42P01`, and BigQuery is never
asked about them.

**Audit.** Every read of Restricted Telemetry or the Platform Database, and every Write Mode
request that passes its checks, is an Audited Query. The engine writes the portal's record format to the DynamoDB table
(`[audit] dynamodb_table`). It also writes an immutable copy to S3 at
`executions/<createdAt>/<id>.json` under Object Lock COMPLIANCE retention. Both carry an
`integrityHash` (an HMAC under `integrity_key_env`). The record holds who ran it (`sub`, email),
the SQL, the source, the description and ticket, the status, the row count and the duration. Its
`action` is `query`, `ai_ask` (agents) or `assertion` (system). Failed statements are recorded too,
with `status: error`. Statements the guard rejects never run and are not recorded.
`GET /v1/audit` browses these records with a bearer identity holding `platform_read`. Without a
valid bearer it returns 401, and without that claim it returns 403.

**58000: audit fails closed.** If the DynamoDB write or the S3 write fails, the query fails with
SQLSTATE `58000 "audit write failed"` and returns no rows. Results are never sent before their
audit record is written. Write Mode answers `500` with the same `58000` (see below). Each failure increments
`federation_engine_audit_write_failures_total` on `/metrics`.

**Write Mode.** `POST /v1/write` takes a bearer identity token holding `attrs.platform_write`. Its
body is `{statement, mode: "preview" | "commit", confirmation_token, description, ticket}`. The
engine runs the portal guard in write mode, then runs the statement on the role from
`write_url_env`. Without `write_url_env`, Write Mode is off (503). Each request, Preview or
commit, needs a confirmation token minted by Lightdash. The token is HMAC-signed with the
identity secret and bound to the statement's SHA-256, the user (`sub`), the project and an expiry
of at most 120 s. Any mismatch returns 403. A token is spent before its statement runs, so reusing
one returns 409, and it works exactly once. A Preview runs the statement inside
`BEGIN … ROLLBACK`. A commit runs it inside `BEGIN … COMMIT`. Both return the rows affected and
up to 100 `RETURNING` rows. AI agents may Preview but never commit (403 naming `agent`). The
system identity may commit. Every request that passes these checks is audited with `mode: write`,
including ones whose statement fails. The audit record is written after the statement ends, so a
commit whose audit write fails (500, `58000`) has still changed the table.

**Secrets and logs.** The identity secret, pg passwords, database URLs, the integrity key and the
BigQuery token are read from environment variables only. Config errors name the variable, never
its value. Logs never contain query results, identity tokens or their payload fields, passwords
or keys.
