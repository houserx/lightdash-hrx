# ENG-1799 end-to-end demo

The demo stack lives in `demo/eng-1799/`: `demo/eng-1799/up.sh` starts it on ephemeral local ports and prints
every URL, `demo/eng-1799/down.sh` stops it. Later sections (prerequisites, the one command, presenting live, the
scenario timeline, the scenes and music) are added as the demo is built.

## Frontend mode

The demo serves the Lightdash UI as the **production build served by the backend**, not the Vite dev server.

- `bash ./init.sh` (through `scripts/eng-1799/init-demo.sh`) runs `pnpm -F frontend build` into
  `packages/frontend/build`, and only again when the frontend or a package it bundles (common, visualization,
  formula) changed. A cold build takes several minutes; a warm `init.sh` skips it.
- The backend's `App` serves that directory itself (`/assets/*` and the `index.html` catch-all), so the UI is at
  the same URL `up.sh` prints as `up.sh: Lightdash: http://127.0.0.1:<port>`. There is no second process and no
  second port.
- `up.sh` refuses to start when `packages/frontend/build/index.html` is missing, and after the backend is healthy
  it checks that `/login` returns the UI.

Why not the dev server:

- One process and one port: the stack, the acceptance checks and the recorded scenes all use the URL in
  `.state/stack.json`, and the backend's session cookie and API calls share that origin with no proxy.
- No file watchers or on-demand compilation while presenting or recording: pages load at production speed
  and the bundle is the one that ships.
- The dev server is for working on the frontend. To use it against the demo backend, run
  `PORT=<printed Lightdash port> pnpm -F frontend dev` yourself (its proxy sends `/api` to `PORT`, default
  8080); the demo does not.

What you see: on a fresh stack without a demo user the UI opens the first-run sign-up page (`/register`); once the
seed has created the demo user it opens the sign-in page (`/login`). Expect 401 responses from `/api/v1/user/account`
and `/api/v1/org` in the browser console before signing in; that is Lightdash checking for a session. The UI loads
the Inter font from Google Fonts; offline it falls back to a system font and works the same.

If you change frontend code, re-run `bash ./init.sh` to rebuild, then `demo/eng-1799/down.sh` and
`demo/eng-1799/up.sh`.

## Dashboards as code

The demo's dashboards live in `demo/eng-1799/content/` as Lightdash content as code (`virtual-views/`, `charts/`,
`dashboards/`). On every fresh stack, `up.sh`'s seed (`demo/eng-1799/stack/seed.ts`) creates a personal access
token for the demo user and runs `lightdash upload` from the CLI's source, then checks that the dashboards and
their Tiles are there. The CLI runs with `HOME` under `.state/cli-home` (it writes `~/.config/lightdash`) and with
`demo/eng-1799/stack/no-network.mjs` preloaded, because it would otherwise send usage analytics and check for
upgrades over the internet. To change a dashboard, edit the YAML and restart the stack. Alternatively, upload by
hand with the token in `.state/run/seed.json` (`lightdash.apiToken`).

**Pharmacy Ops overview** has a Dashboard Time Range (default the last 30 minutes, refresh 30 s) mapped to every
Tile. Its Tiles are all built-in Lightdash charts, so no chart registry or licence is needed:

| Tile | Chart | What it shows |
|---|---|---|
| Current fill queue backlog | big number | the latest `hrx_fill_queue_backlog{queue="fill"}` sample, red at 100 and above (conditional formatting) |
| Fill queue backlog | cartesian line | the fill queue's backlog over time, with a dashed threshold line at 100, the Alert Rule threshold |
| Peak backlog by queue | horizontal bar, 0 to 200 | the bar gauge: each queue's highest backlog in the range |
| Queue status | table | each queue's peak backlog, plus a Status column whose value mappings (Grafana's shape) read OK, Elevated or Backlogged |

The charts query the virtual view `hrx_fill_queue_backlog`: `promql('hrx_fill_queue_backlog', now() - 6 hours,
now(), '15s')` on the Federation Engine. Explore charts don't receive the reserved `__from`/`__to` parameters,
which only reach SQL charts, so the view's window is fixed at 6 hours. The Dashboard Time Range filters each Tile
on `ts` inside that window, so ranges longer than 6 hours show only the last 6 hours.

Pharmacy Ops overview is the demo's **converted Grafana dashboard**. Its source is the synthetic Grafana export
`demo/eng-1799/seed/grafana/pharmacy-ops-overview.json` (a Prometheus datasource input, no real hosts). The base has
no Grafana importer CLI, so the YAML was converted by hand: one Tile per panel with the same title (`timeseries` →
cartesian line with the dashed threshold, `table` with range value mappings → table with the same mappings, as in
`docs/eng-1799/grafana-panel-mapping.md`; `stat` → big number and `bargauge` → horizontal bar, built-in charts
instead of the mapping's `stat-sparkline` and `bar-gauge` registry entries, so the demo needs no chart registry), x
and w scaled from Grafana's 24 columns to Lightdash's 36, and the time picker (`now-30m`, refresh `30s`) as the
Dashboard Time Range. If you change a panel title in one, change it in the other.

**Platform DB** has three SQL chart Tiles over the synthetic Platform Database. Each one wraps an aggregate in
`platform_query('...')`, so it is an Audited Query that runs as the signed-in user, who needs `platform_read`. No
Tile selects a row-level column:

| Tile | Chart | Inner SQL (Platform Database) |
|---|---|---|
| Orders by status | vertical bar | `count(*)` of `orders` per `status` |
| Open fills by queue | vertical bar | `fills` with no `completed_at`, joined to `queues`, counted per queue name |
| Shipments by carrier | table | `count(*)` of `shipments` per `carrier` and `status` |

The engine refuses an Audited Query that has no description, and saved SQL charts don't carry an audit block of
their own. Lightdash therefore sends the **saved chart's description** as the Audited Query description, for a
saved SQL chart and for a dashboard SQL chart Tile (the Tile's uuid goes in as the resource). That is why every
chart here has a description. Each Tile run leaves two audit records, one for the column-discovery probe and one
for the run.

**Service health** shows the fill-service's logs and traces from the fake Loki and Tempo. Every Tile is a built-in
or native Lightdash chart over a virtual view, with no chart registry:

| Tile | Chart | Virtual view (Federation Engine) |
|---|---|---|
| Log level heatmap | custom (Vega-Lite `rect`), minute × level, coloured by lines per minute | `hrx_fill_service_log_rate`: `logql_metric('sum by (level) (count_over_time({app="fill-service"}[1m]))', now() - 30 minutes, now(), '1m')` |
| Fill service logs | native `log_stream`, newest first | `hrx_fill_service_logs`: `logql('{app="fill-service"}', now() - 30 minutes, now(), 500)`, the level taken from the line's `level=` key |
| Slow trace waterfall | native `trace_waterfall` | `hrx_fill_service_trace`: `trace(${ld.parameters.trace_id})` |

During the incident the heatmap's error row turns hot, error lines lead the log stream, and the waterfall shows the
slow `shipping-label-api` span (over 2 s). The log windows are fixed at 30 minutes because explore charts get no
reserved time parameters.

The waterfall shows the trace in the project parameter **`trace_id`** ("Trace ID" on the dashboard). The seed
defines that parameter (`PUT /api/v2/projects/<uuid>/parameters`) before the upload, because a virtual view may only
reference defined parameters. Its default is the fake Tempo's **pinned example trace**
`de300000000000000000000000000001` (`PINNED_TRACE_ID` in `demo/eng-1799/stack/tempo.ts`, the one place the id is
written; the seed reads it from there). That trace is a slow, successful "ship fill" request that starts 1 s after
the incident begins and looks like the incident's other slow traces. `trace(<id>)` returns it at any time, and
`traceql()` search lists it once the incident is running. The id never changes with the scenario clock or a
restart. To look at another trace, open the Trace ID parameter, paste the id (for example one from
`traceql('{ duration > 2s }', ...)`) and pick "Add ...". The waterfall then reruns with that trace, like a Grafana
trace-id variable.

### Portal saved script

`demo/eng-1799/seed/portal-scripts.json` is a synthetic db-query-portal saved-scripts export with one script, **Open
fills past target by queue**. Its SQL is Platform Database SQL. On every fresh start, `up.sh` copies `content/` to
`.state/run/content` and runs the CLI from source:
`lightdash import portal-scripts seed/portal-scripts.json --path .state/run/content --space platform-saved-sql`.
This adds one SQL chart, with the SQL kept verbatim, in the space "Platform saved sql". The seed then uploads that
folder with `lightdash upload`. The importer leaves out the export's author and execution fields.

To run it: in the SQL Runner, switch to **Investigate**. **Saved SQL** lists the chart. Choose **Platform
Database**, paste the script's SQL into **Platform SQL**, add a Description, and press **Run**. Investigate wraps the
SQL in `platform_query(...)`, so it runs on the Platform Database as an Audited Query, and the audit browser lists it.

## Alerting as code

`demo/eng-1799/alerting/` holds the demo's alerting, in the layout `lightdash download --alerting-only` writes:

| File | What it is |
| --- | --- |
| `alert-rules/fill-queue-backlog-high.yml` | **Fill queue backlog high**: PromQL `hrx_fill_queue_backlog{queue="fill"}`, last value `> 100` (the dashboard's threshold line), every 30s over 5m |
| `alert-rules/fill-service-error-log-rate.yml` | **Fill service error log rate**: LogQL `sum(count_over_time({app="fill-service"} \|= "level=error" [1m]))`, last value `> 10`, every 30s over 5m |
| `contact-points/incident-io.yml` | **incident.io (demo receiver)**: an `incident_io` integration on the fake receiver's `/webhook` |
| `notification-routes/notification-routes.yml` | The route tree: `team=pharmacy-ops` (both rules) and the default route both go to the incident.io Contact Point |

Both rules are unpaused and not in Shadow Run, so they notify for real. Their annotations render the value, for
example "Fill queue backlog is 173 (threshold 100)". On every fresh start, the seed copies the folder to
`.state/run/alerting`. It replaces `__DEMO_INCIDENT_IO_URL__` with the receiver's URL, because the port is ephemeral,
and uploads the copy with `lightdash upload --alerting-only`. The Contact Point's token is only a reference,
`secretRef: demo-incident-io-token`. The backend reads it from `ALERTING_SECRET_DEMO_INCIDENT_IO_TOKEN`, a fixed
non-secret value in `.state/lightdash/lightdash.env`. Everything uploaded is **Managed in git**, so it's read-only
in the UI. To change it, edit the files and run `up.sh` again on a stopped stack.

Open it at `/projects/<Operations Project uuid>/alerting/rules`. The navbar has no Alerting entry yet. The page
has the tabs Alert Rules, Contact Points and Notification Routes.

## Telemetry MCP server

`up.sh` also starts telemetry-mcp (`packages/telemetry-mcp/dist/main.js`, built by `init.sh`) on an ephemeral port.
It runs against the demo's Federation Engine with its own pg-wire login, `telemetry-mcp`, and against Lightdash
with the seed's personal access token as its service account. It trusts a **fake Okta** that runs inside the
telemetry-fakes process. `stack.json` has `mcp.url` and `okta.issuer`. The server's whole environment is in
`.state/mcp/mcp.env` (written by `stack/mcp.ts`). It has no `ANTHROPIC_API_KEY`, so `ask_data` reports that AI is
not configured.

- `GET <mcp.url>/healthz` answers `{"status":"ok"}`.
- `POST <mcp.url>/mcp` without a bearer token gets `401` with a `WWW-Authenticate` challenge whose
  `resource_metadata` points to `/.well-known/oauth-protected-resource/mcp`. That metadata names the fake Okta
  issuer.
- The fake Okta has no sign-in page. `POST <okta.issuer>/v1/token` with `{"email": "<email>"}` returns an RS256
  access token for that email (audience `api://telemetry-mcp-demo`, valid for an hour). The server checks the token
  against the fake Okta's JWKS (`<okta.issuer>/v1/keys`), the same way it checks a real Okta token.
- A token for the demo user lists every tool: `platform_read` and `platform_write` are set by the seed. A token
  for an email with no Lightdash user lists no tools.

The fake Okta's key is generated when telemetry-fakes starts, so tokens stop working after `down.sh`.

### Asking a question (scripted MCP client)

`pnpm -F eng-1799-demo ask "<question>"` (`demo/eng-1799/ask/`) is an MCP client with no model behind it. It
matches the question against a short scripted list (`ask --list` prints it), signs in at the fake Okta as the demo
user, calls the matching telemetry-mcp tool and prints the tool, its arguments, the live query, the result table and
a one-sentence answer. With `--json` it prints one JSON object instead:
`{question, tool, arguments, query, result: {columns, rows}, answer}`. A question it doesn't know exits 1 with the
list. Today both scripted questions are about the fill queue backlog and run `query_promql` on
`hrx_fill_queue_backlog{queue="fill"}`: "What is the fill queue backlog right now?" (an instant query at `now`) and
"How has the fill queue backlog changed over the last 15 minutes?" (a 1-minute range query).

## Known limits

- **ENG-1799 follow-up: imported portal scripts don't run from the chart itself.** The importer keeps the portal's
  SQL verbatim, and portal SQL reads Platform Database tables directly. The Operations Project only reaches those
  tables through `platform_query()`. So opening the SQL chart, or opening it from Investigate's Saved SQL into the
  SQL box, fails with "table 'datafusion.public.fills' not found". Run it as Platform SQL instead (see above). To
  fix this, the importer could wrap the SQL, or the SQL Runner could mark a chart as Platform SQL. Either change has
  to keep the portal text unchanged.

- **ENG-1799 follow-up: no "latest slow trace" waterfall.** Table-function arguments must be constants in the
  Federation Engine, so `trace((SELECT trace_id FROM traceql(...) LIMIT 1))` is refused. A Tile can't follow the
  newest slow trace by itself. Service health uses a pinned example trace with a `trace_id` parameter instead (see
  above). Lifting this needs an engine change: evaluate a scalar subquery argument, or add a lateral `trace()` join.
