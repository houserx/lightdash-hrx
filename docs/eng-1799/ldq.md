# ENG-1799 in Lightdash: Operations Project, Investigate, Write Mode and audit

This page is for Lightdash admins. It explains what the `ldq` line added to Lightdash, how to set up
the Operations Project on the Federation Engine, and which user attributes to create.

Terms follow `CONTEXT.md`. The interface contracts are in `docs/eng-1799/CONTRACTS.md` (§2, §3, §4.1
and §4.2 cover this part), and the decisions are in `docs/adr/0001`–`0004`.

## What was built

| Area | What users see |
|---|---|
| Federation Engine flavour | The Postgres connection form has a "Federation Engine" switch. A project with that switch on is the Operations Project. |
| Dashboard Time Range | One relative or absolute window per dashboard. It applies to every Tile mapped to a time dimension, and auto-refreshes. |
| Investigate | A second mode of the SQL Runner for live queries against Telemetry Sources and the Platform Database. |
| Audited Query | Platform Database SQL and Restricted Telemetry need a description, and may cite a Linear ticket. |
| Platform Database schema browser, Explain and saved SQL | Browse tables and columns, read an estimate-only plan, and open shared saved SQL. |
| Write Mode | Single-statement data changes on the Platform Database, with a Preview that always rolls back, and a typed confirmation to commit. |
| Audit browser | Lists the audit records the Federation Engine keeps, filtered by ticket, user and month. |
| `lightdash import portal-scripts` | A CLI command that turns db-query-portal saved scripts into SQL charts as code. |

### Federation Engine flavour

The Federation Engine speaks the Postgres wire protocol, so Lightdash treats it as a **flavour of the
Postgres warehouse type**, not as a new warehouse type. A project's credentials are
`type: 'postgres'` with `flavor: 'federation'`. When that is set:

- Lightdash uses `FederationWarehouseClient`, a `PostgresWarehouseClient` that reads tables and
  columns from `information_schema` only, because the engine exposes no `pg_catalog`.
- Before every query, on the connection that runs it, Lightdash sends
  `SET hrx.identity = '<identity token>'`. The token is a short-lived (at most 300 s) HMAC-signed
  statement of who is asking. It holds the user's uuid and email, whether the request comes from an
  AI agent, the four user attributes below, and, for an Audited Query, its description and ticket. The
  engine enforces access from this token. Lightdash never logs the token or the signing secret, and
  removes the token from any engine error text it passes on.
- SQL compilation, the dialect and everything else stay Postgres's.
- The Operations Project works with the "none" and native-git (Lightdash semantic layer) project
  types. dbt projects are refused with "dbt is not supported for the Federation Engine".

### Dashboard Time Range

A dashboard can carry a Dashboard Time Range: `from` and `to` (relative, like `now-6h` and `now`,
or absolute ISO timestamps), an optional refresh interval (10s, 30s, 1m, 5m, 15m, 30m or 1h), and a
map from each Tile to the time dimension it filters on.

- **Viewing.** The dashboard header shows the range (for example "Last 6 hours") with quick ranges,
  "From" and "To" fields, and a "Refresh" select. The chosen range and refresh live in the URL, so a
  link reproduces the view. With a refresh interval set, the dashboard reruns its Tiles on that
  interval.
- **Tiles.** In edit mode, "Time range settings" maps each chart Tile to one of its time dimensions,
  or to None. A mapped chart Tile gets an `inBetween` filter on that dimension. SQL Tiles follow the
  range through the reserved parameters below. A Tile the range doesn't reach says "Not affected by
  the time range".
- **Reserved parameters.** Before a query is compiled, and before its cache key is computed, the
  range is resolved to absolute values in these parameters:

  | Parameter | Value |
  |---|---|
  | `${ld.parameters.__from}` | start, ISO-8601 UTC |
  | `${ld.parameters.__to}` | end, ISO-8601 UTC |
  | `${ld.parameters.__interval}` | a step for the range: (to − from) / 1000 rounded up to a nice step, at least `15s` |
  | `${ld.parameters.__range}` | the range's length as a duration, like `1h30m` |

  Relative bounds are rounded down to the refresh interval, or to 10 s without one, so cached
  results are reused until the data should change.
- **As code.** Dashboards as code carry `timeRange`, with `tileTimeDimensions` keyed by tile slug.
  The UI has no control to add a range to a dashboard that has none, so add it as code or through
  the API.

### Investigate

On a new query in the SQL Runner of an Operations Project, a "SQL" / "Investigate" switch appears.
Investigate offers one editor per Telemetry Source kind: Prometheus (PromQL), Loki (LogQL, with a
"Metric query" option), CloudWatch metrics, CloudWatch Logs (Logs Insights), Tempo (TraceQL) and
the Platform Database.

- Each editor writes the Federation Engine SQL for its query, using `__from`, `__to` and `__interval`
  from Investigate's own time range (default the last 6 hours). The SQL stays editable.
- Results render as a time series chart, a log list, a trace table (open a trace to see its spans),
  or a plain table, depending on the columns that come back.
- "Save as chart" saves the current SQL as a SQL chart.
- **Audited Query.** Platform Database SQL (`platform_query`, `platform_explain`, `platform_tables`,
  `platform_columns`) needs a "Description" and accepts an optional "Linear ticket". Restricted
  Telemetry is enforced by the engine alone. When the engine answers that an Audited Query needs a
  description, Investigate asks for one and reruns.
- **Platform Database tools.** A schema browser lists tables and columns and inserts them into the
  editor. "Explain" runs an estimate-only `EXPLAIN (FORMAT JSON)` and shows the plan as text, with
  "Download JSON" and "Download text". A "Saved SQL" picker opens shared saved SQL, which is the
  SQL charts in the Operations Project's spaces.

### Write Mode and Preview

On the Platform Database source, users with `platform_write` see a "Write Mode" switch. Write Mode
never goes through Lightdash's async query path:

1. Lightdash asks for a confirmation token bound to the exact statement, the user and the project.
   The token is single-use and lasts at most 120 s.
2. **Preview** sends the statement with a description (and optional Linear ticket). The engine runs
   it inside a transaction that always rolls back, and returns the rows affected and up to 100
   `RETURNING` rows.
3. **Commit** needs the description and `COMMIT` typed into "Type COMMIT to confirm". The result
   shows the rows affected and the audit id.

The engine's guard allows a single `SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`INSERT`/`UPDATE`/`DELETE`
statement and blocks DDL. An AI agent context may Preview but is refused a commit, by Lightdash and
by the engine. Routes: `POST /api/v2/projects/{projectUuid}/write/confirmations` and
`POST /api/v2/projects/{projectUuid}/write`.

### Audit browser

`/projects/{projectUuid}/audit` (linked as "Audit browser" from Investigate) lists the engine's audit
records for every Audited Query and Write Mode request: time, user, description, ticket, mode, status
and rows. Filter by "Ticket", "User" and "Month" (`YYYY-MM`), then page with "Next page". It needs
`platform_read`. The API is `GET /api/v2/projects/{projectUuid}/federation/audit`.

### `lightdash import portal-scripts`

```bash
lightdash import portal-scripts saved-scripts.json --path ./lightdash --space platform-saved-sql
```

This command reads the db-query-portal's saved-scripts export, which is a JSON array. It writes one
SQL chart file per script to `<path>/charts/<slug>.yml`, in the given space, and leaves out the
portal's user fields. Deploy the files to the Operations Project with `lightdash upload`, and they
become shared saved SQL in Investigate.

## Configure the Operations Project

1. Create a project and choose **PostgreSQL** as its warehouse.
2. Turn on **Federation Engine**. The port default changes to `5433` and the DB name default to
   `operations`.
3. Fill in the connection fields:

   | Field | Credential key | Value |
   |---|---|---|
   | Federation Engine | `flavor: 'federation'` | on |
   | Host | `host` | the engine's host, e.g. `federation-engine` |
   | Port (advanced) | `port` | `5433`, the engine's `listen_pg` port |
   | User | `user` | a `[[users]]` login from the engine config, e.g. `lightdash-operations` |
   | Password | `password` | that login's password |
   | DB name | `dbname` | `operations` |
   | Identity signing secret | `identitySigningSecret` | the same HMAC key as the engine's `identity_secret_env` |
   | Engine HTTP URL | `httpBaseUrl` | the engine's HTTP base URL, e.g. `http://federation-engine:8088` |

   As code or through the API, the credentials look like this:

   ```yaml
   type: postgres
   flavor: 'federation'
   host: federation-engine
   port: 5433
   user: lightdash-operations
   password: <from your secret store>
   dbname: operations
   schema: public
   identitySigningSecret: <from your secret store>
   httpBaseUrl: http://federation-engine:8088
   ```

   `identitySigningSecret` is a secret like `password`. Lightdash never returns it from its API, and
   it keeps the saved value when you edit the project without retyping it. Without it, Lightdash
   sends no identity, and the engine allows only ordinary telemetry and Ops Marts. Without
   `httpBaseUrl`, Write Mode and the audit browser can't reach the engine.
4. Use the "none" or native-git project type. dbt is refused.
5. Create the user attributes below and give them to groups.

## User attributes

Create these on the **User attributes** settings page (the `/userAttributes` settings route), and
assign them through groups. A user
has the grant only when one of their values is exactly `true`. Any other value, or no value, means no
grant. The values go into every identity token, and the Federation Engine enforces them. The UI only
hides what the user can't use.

| Attribute | Grants |
|---|---|
| `telemetry_restricted` | Reading Restricted Telemetry in Investigate, as an Audited Query. AI agents never get this, whatever the attribute says. |
| `platform_read` | Running Platform Database SQL, the schema browser, Explain, and the audit browser. |
| `platform_write` | Write Mode: Preview and Commit against the Platform Database. |
| `platform_explain` | Explain only: users with this but not `platform_read` can Explain and download the plan, but not run Platform Database SQL. |

Operations Project membership alone gives ordinary telemetry and Ops Marts.
