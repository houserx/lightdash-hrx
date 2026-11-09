# ENG-1799 progress notes

The build lines ran in parallel, each with its own progress notes. They are kept per line:
`PROGRESS-engine.md`, `PROGRESS-mcp.md`, `PROGRESS-ldq.md`, `PROGRESS-viz.md`, `PROGRESS-alerting.md`.
Each one has a "Contract assumptions" section that the integration line reconciles.

## Known overlaps for the integration line (found while merging, 2026-11-09)

- `formatPrometheusDuration` is exported by both `packages/common/src/utils/timeRange.ts` (ldq) and
  `packages/common/src/alerting/durations.ts` (alerting). They differ for durations of a week or more
  (`7d` vs `1w`). The package root re-exports ldq's to resolve the clash.
- Alerting's `alerting/queryParameters.ts` builds the CONTRACTS §2 reserved time parameters (`__interval`,
  `__range`, ...) separately from ldq's `utils/timeRange.ts`. The two should agree on every value the engine sees.

---

# Line `demo`: the end-to-end demonstration and promo video

This section is the hand-off between the demo line's sessions. Each session starts with an empty memory: read
this whole section first, then `CONTEXT.md` (glossary: use its terms, never its `_Avoid_` terms), `docs/adr/0001`-
`0004`, `docs/eng-1799/CONTRACTS.md`, and the `PROGRESS-<line>.md` of the piece you are wiring.

The goal: `demo/eng-1799/up.sh` brings up a complete local HouseRx-like observability stack with live synthetic
telemetry (no Docker, no network); a Playwright walkthrough drives the real UI through an incident in eight
recorded scenes; `pnpm -F eng-1799-demo video` turns the recordings into a short promo MP4; `run-all.sh` does it
all. The feature list (45 entries, ids `demo-*`) is kept by the supervisor. **Take features strictly in order.**

## How to run things

| What | Command (repo root) |
|---|---|
| Prepare the tree | `bash ./init.sh` (warm: about 5 s; it runs every line's `scripts/eng-1799/init-<line>.sh`, `demo` last) |
| One feature's check | its `check`, e.g. `bash demo/eng-1799/acceptance/run.sh --stack platform-db.spec.ts` |
| A check with a grep | `bash demo/eng-1799/acceptance/run.sh --stack alert-lifecycle.spec.ts --grep "demo-alert-fires:"` |
| Bring the stack up / down by hand | `bash demo/eng-1799/up.sh` / `bash demo/eng-1799/down.sh` |
| Regression gate (the supervisor sets it later) | `pnpm -F common typecheck && pnpm -F backend typecheck && pnpm -F frontend typecheck && pnpm -F @lightdash/cli typecheck && pnpm -F eng-1799-demo typecheck` |

- **`init.sh` starts no server.** The goal and `specs/goal-common.md` say init only installs and builds; that
  overrides the generic "init starts the app" step. `scripts/eng-1799/init-demo.sh` checks the Postgres binaries,
  makes sure ffmpeg-static's binary and Playwright's chromium exist, rebuilds the **frontend production build**
  (`pnpm -F frontend build`, about 15 s, into `packages/frontend/build`) when its inputs changed, and checks the
  engine binary and `packages/telemetry-mcp/dist`. Stamps and logs: `tmp/.demo-init/`. Add demo build steps there.
- **`acceptance/run.sh [--stack] <spec> [playwright args]`** (protected) runs ONE spec with
  `pnpm -F eng-1799-demo exec playwright test --config acceptance/playwright.config.ts`. With `--stack` it runs
  `down.sh`, then `up.sh` (output in `tmp/demo-acceptance/up.log`), then the spec, and **always** `down.sh` on exit
  (trap). `DEMO_*` env passes through to `up.sh`. Playwright output: `tmp/demo-acceptance/test-results/`.
- **`ps` is blocked in the factory sandbox** (`operation not permitted`). Use `pgrep -lf <regex>` (works) or pid
  files. The checks use `pgrep -lf <path of .state>` to prove nothing is left running.
- `/tmp` may not be writable; use the repo's `tmp/` (gitignored) for scratch, and `demo/eng-1799/.state/` for stack state.
- Postgres: `/opt/homebrew/bin/{initdb,pg_ctl,postgres}`; `psql` is blocked. Listen on `127.0.0.1`, a free port,
  `unix_socket_directories=''` (socket paths are longer than macOS allows). Use the `pg` package (in the demo
  package) to run SQL.
- Machine etiquette: one check at a time; `CARGO_BUILD_JOBS=2`; `-threads 2` for ffmpeg; stop what you start.

## State at hand-off (init session, 2026-11-08)

- `demo/eng-1799/package.json`: the workspace package `eng-1799-demo` (in `pnpm-workspace.yaml`, lockfile
  updated) with devDependencies only: `@playwright/test` 1.63.0 (chromium-1243 is installed in the user cache),
  `ffmpeg-static` 5.3.0 (binary downloaded at **install** time; allowed in `allowBuilds`), `pg` 8.13.1, `@types/pg`,
  `@types/node`, `tsx`, `typescript` 7.0.2. **`scripts` is empty**: `typecheck`, `walkthrough`, `video` and `ask`
  are features. No source, no `up.sh` yet. Every check fails today.
- `demo/eng-1799/acceptance/**` (**protected**): `run.sh`, `playwright.config.ts`, `helpers/stack.ts`,
  `helpers/scenarioWindows.ts` and 40 spec files covering the 45 features.
- `.gitignore`: `/demo/eng-1799/.state/`, `/out/`, `/test-results/`, `/playwright-report/`, and every audio
  extension under `/demo/`.
- `init.sh` loops over `viz ldq mcp alerting engine demo`; `scripts/eng-1799/init-demo.sh` is new.
- Measured on this machine (feasibility smoke, not committed): a fresh Lightdash Postgres migrates in **16 s**
  (`pnpm -F backend migrate`, core migrations only with `LIGHTDASH_LICENSE_KEY` empty); the backend started with
  `tsx src/index.ts` answers `/api/v1/health` after **22 s**, serves the production frontend at `/` (200), and its
  in-process scheduler made `GET /api/v1/alerting/health` report `ok`. It **refuses to start without S3**
  (`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`): the demo needs a local S3-compatible fake (see below).
- `tmp/demo-smoke/` may hold that smoke's stopped Postgres data dir; it is scratch, delete it freely.

## Pinned interfaces (the protected tests use exactly these; build to them)

### Files and commands

| Path / command | Contract |
|---|---|
| `demo/eng-1799/up.sh` | Validates `DEMO_INCIDENT_AT` / `DEMO_RECOVERY_AT` (integers, seconds, `0 <= incident < recovery`; default 90 and 300) **before starting anything**, naming the bad variable on failure. Starts everything in the background on free `127.0.0.1` ports, seeds (itself or via `seed.sh`), writes `.state/stack.json`, prints `Lightdash: <lightdash.url>` and exits 0 once everything answers. Idempotent: if the stack is already up it prints the same line and changes nothing (same pids). All state under `demo/eng-1799/.state/`. |
| `demo/eng-1799/down.sh` | Stops every process it started (process groups), so that no process's command line mentions `.state`, every pid in `stack.json` is gone and every port is closed. Exit 0 also when nothing runs. |
| `demo/eng-1799/run-all.sh [--keep]` | up, seed, `scenario/restart` with the `DEMO_*` offsets, `walkthrough/run.sh` (all scenes), the video build, then down (skipped with `--keep`). Non-zero on the first failure, and still down (trap). |
| `demo/eng-1799/walkthrough/run.sh [scene-id ...]` | Runs the given scenes (default: all eight, in order) against the RUNNING stack; never restarts the scenario clock; writes `demo/eng-1799/out/scenes/<scene-id>/video.webm` (1920x1080) and `key-moment.png` (1920x1080). Exit non-zero if a scene's assertions fail. |
| `demo/eng-1799/walkthrough/<scene-id>.spec.ts` | One Playwright spec per scene, ids `01-sign-in 02-incident 03-alert-fires 04-service-health 05-investigate 06-ai-question 07-write-mode 08-recovery`. Each asserts what it shows (the checks require at least 3, or 4 for scenes 04 and 07, `expect(` calls). Wait on the scenario clock and on UI state with deterministic waits; no long sleeps. Standalone runs must work: the checks restart the scenario, then run one scene. |
| `out/scenes/06-ai-question/answer.json` | The scripted client's output for scene 6 (same shape as `ask --json`). |
| `pnpm -F eng-1799-demo ask --json "<question>"` | Scripted MCP client, no real model: gets a token from the fake Okta for the demo user, calls telemetry-mcp (`query_promql` or `ask_data`), prints ONE JSON line `{question, tool, arguments, query, result: {columns: string[], rows: unknown[][]}, answer}`. "fill queue backlog" questions query `hrx_fill_queue_backlog`; numeric cells are numbers or numeric strings. |
| `pnpm -F eng-1799-demo video [--scenes-dir D] [--out O] [--music F]` | `demo/eng-1799/video/build.ts` (or `.sh`). Default D = `out/scenes`, O = `out`. Writes `O/eng-1799-demo.mp4` (H.264, 1920x1080, exactly 30 fps, AAC only with `--music`), `O/thumbnail.png` (or `.jpg`, 1920x1080 or 1280x720), `O/CHAPTERS.md`. Title card: a distinct card (not drawn over scene 1), 2-7 s, "Lightdash for HouseRx operations". Every scene in full, in order, with a lower-third caption. Crossfades (a real mix, `xfade=fade`), at most 1.5 s. End card: distinct from the last scene. `--music`: faded in and out (the check wants the first 0.4 s and last 0.5 s at least 10 dB under the middle); a missing file exits non-zero naming it. Uses `ffmpeg-static` only. |
| `CHAPTERS.md` | Exactly ten chapter lines `- mm:ss Title` (title card at `00:00`, the eight scenes, the end card), increasing times, distinct titles. |
| `pnpm -F eng-1799-demo typecheck` | `tsc` over the demo's TypeScript, **acceptance folder included** (it typechecks with `--strict --module nodenext --moduleResolution nodenext --lib es2022,dom --types node --skipLibCheck --esModuleInterop`; mirror that in `demo/eng-1799/tsconfig.json`). |
| `docs/eng-1799/demo.md` | See the `demo-docs` check: headings for prerequisites, one command, presenting live, timeline, scenes, music; mentions `run-all.sh`, `--keep`, `up.sh`, `down.sh`, `pnpm -F eng-1799-demo video`, `--music`, licensing, `DEMO_INCIDENT_AT`, `DEMO_RECOVERY_AT`, `T+90s`, `T+5min`, every scene id, the frontend mode (production build) and why. |
| `demo/eng-1799/seed/grafana/*.json` | A synthetic Grafana dashboard JSON (no HouseRx hosts) whose every non-row panel title is a Tile title of one seeded dashboard. |
| `demo/eng-1799/seed/portal-scripts.json` | A synthetic portal saved-scripts export (`[{id, title, sql, ...}]`); `seed.sh`/`up.sh` must call `lightdash import portal-scripts`. The SQL is Platform Database SQL, kept verbatim. |

### `.state/stack.json`

```jsonc
{
  "lightdash":  { "url": "http://127.0.0.1:<port>", "projectUuid": "<Operations Project uuid>" },
  "demoUser":   { "email": "<something>@example.com", "password": "<fake>" },
  "scenario":   { "url": "http://127.0.0.1:<port>" },
  "prometheus": { "url": "..." }, "loki": { "url": "..." }, "tempo": { "url": "..." }, "cloudwatch": { "url": "..." },
  "engine":     { "host": "127.0.0.1", "pgPort": 0, "httpUrl": "...", "user": "lightdash-operations",
                  "password": "<fake>", "database": "operations", "identitySecret": "<fake, shared with Lightdash and MCP>" },
  "platformDb": { "host": "127.0.0.1", "port": 0, "user": "<cluster superuser>", "password": "<fake>", "database": "<db>" },
  "incidentIo": { "url": "..." },
  "mcp":        { "url": "..." },
  "okta":       { "issuer": "..." },
  "processes":  [ { "name": "engine", "pid": 123 }, ... ]   // every process up.sh started
}
```

- Every `*.url` / `*Port` is on 127.0.0.1 and never a well-known port (5432, 5433, 8080, 8088, 3000, 9090, 3100, 3200).
- `platformDb` is the cluster superuser (checks read `data_directory` and `pg_roles`). The engine uses its own
  read and write roles. Names of processes: the engine's contains `engine`, telemetry-mcp's `mcp`, Lightdash's
  `lightdash` or `backend`.
- Fake secret values look like `test-...-not-real`; the demo user email ends in `@example.com`.

### Scenario clock and data

- `GET {scenario.url}/scenario` → `{startedAt, incidentAt, recoveryAt, now, phase: 'baseline'|'incident'|'recovered'}` (ISO strings).
- `POST {scenario.url}/scenario/restart` with `{incidentAfterSeconds, recoveryAfterSeconds}` (may be negative)
  restarts the timeline at now and returns the same shape. Data at time t is a pure function of t and the current
  timeline, so a timeline shifted into the past fills look-back windows at once (`helpers/scenarioWindows.ts`).
- **Prometheus** `hrx_fill_queue_backlog` (label `queue`, at least `queue="fill"`; also with `{queue="fill"}`, and
  `promql_instant`): baseline values in `[0, 60]` and not constant; from `incidentAt+30s` to `recoveryAt`, at least
  120; from `recoveryAt+60s`, at most 60. The Alert Rule threshold is 100.
- **Loki** `{app="fill-service"}`: lines contain `level=info` / `level=error` (logfmt). `|= "level=error"` gives at
  most 2 lines/min in the baseline and at least 10/min from `incidentAt+30s` to `recoveryAt`, and incident error
  lines mention `shipping-label-api`. `sum(count_over_time({app="fill-service"} |= "level=error" [1m]))` agrees.
- **Tempo**: `{ resource.service.name = "fill-service" }` returns at least 2 traces/min (root service
  `fill-service`, at least 3 spans, one child span of service `shipping-label-api`); adding `&& duration > 2s`
  returns only incident traces (at least 1/min), whose `shipping-label-api` span is at least 2000 ms; baseline
  downstream spans are under 500 ms.
- **CloudWatch** `GetMetricData`: Grafana target `{namespace: AWS/SQS, metricName: ApproximateNumberOfMessagesVisible,
  dimensions: {QueueName: hrx-demo-fill-queue}, statistic: Maximum, period: 60}` follows the backlog numbers.
  The engine's `aws-sdk-cloudwatch` speaks **Smithy RPC v2 CBOR**; see `federation-engine/tests/acceptance/harness/aws.rs`
  for the wire details your Node fake must answer (also JSON 1.1 for Logs, JSON 1.0 for DynamoDB, REST for S3).
- **CloudWatch Logs Insights** on `/hrx/demo/fill-service`: messages containing `ERROR` follow the error-log numbers;
  support `fields ... | filter @message like /X/ | sort ... | limit N` and plain `fields ... | limit N`.
- **incident.io fake**: `POST {incidentIo.url}/webhook` (Alertmanager v4 JSON, any bearer) records it;
  `GET {incidentIo.url}/api/received` → `{notifications: [{receivedAt, payload}]}` in arrival order;
  `GET {incidentIo.url}/` is an HTML page titled with "incident.io" with one table row per received alert
  (alertname and status `firing`/`resolved`).
- **Okta fake**: `POST {okta.issuer}/v1/token` with `{"email": "..."}` → `{access_token}` (RS256 JWT, iss = issuer,
  aud = the MCP's `OKTA_AUDIENCE`); JWKS at `{okta.issuer}/v1/keys`. Demo only.

### Names the seed must use

Project name contains `Operations` (flavor `federation`). Dashboards `Pharmacy Ops overview` (with a Dashboard
Time Range; Tiles `Fill queue backlog` (time series, `thresholds` with a step at 100), `Current fill queue backlog`
(stat), a bar gauge titled `... by queue`, a Tile with `valueMappings`), `Service health` (a `log_stream` Tile, a
`trace_waterfall` Tile, a Tile titled with "heatmap" or "state timeline"), `Platform DB` (at least two `sql_chart`
Tiles calling `platform_query`). Alert Rules `Fill queue backlog high` and `Fill service error log rate`, neither
paused nor shadow, routed to an `incident_io` Contact Point whose URL starts with `incidentIo.url` and whose token is
a `secretRef`. The demo user has user attributes `platform_read` and `platform_write` = `true`.

## Suggested architecture (nothing is built yet; change it if you must, keep the pins)

- `demo/eng-1799/stack/*.ts`: small Node servers run with `tsx` (or plain node), no new runtime deps unless needed:
  one **scenario + telemetry fakes** process (scenario API, Prometheus, Loki, Tempo, CloudWatch + Logs on separate
  ports, sharing one clock), one **AWS fakes** process (DynamoDB `PutItem`/`Query` over the portal GSIs, and an
  S3-compatible store for both the engine's audit objects and **Lightdash's results**: path-style
  Put/Get/Head/List/Delete, multipart if Lightdash uses it), the **incident.io** fake, the **Okta** fake.
  Deterministic data: seeded hash of (series, time bucket), never `Math.random()`.
- `up.sh`: pick free ports (node `net.listen(0)`), write configs into `.state/`, start each server in its own
  process group with logs in `.state/logs/`, record pids, wait for each to answer, then seed. `down.sh`: TERM each
  group, wait, KILL leftovers, `pg_ctl stop` both clusters. Make `up.sh` detect a live stack via `stack.json` pids.
- **Engine**: `federation-engine/target/debug/engine --config .state/engine/federation-engine.toml`. Keys are in
  `PROGRESS-engine.md` ("Config"). Give AWS clients `endpoint_url`/`dynamodb_endpoint_url`/`s3_endpoint_url`, set fake
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`, `AWS_EC2_METADATA_DISABLED=true`; leave `role_arn` out
  unless you also fake STS. `platform_postgres` needs `read_url_env`/`write_url_env` and `[audit]` (fail-closed:
  without a working audit store every Audited Query fails with 58000).
- **Lightdash backend**: `pnpm -F backend migrate`, then `tsx packages/backend/src/index.ts` (production
  `node dist/index.js` needs `pnpm -F backend build`; tsx boots in about 22 s). Env seen to work: `PGHOST/PGPORT/
  PGUSER/PGPASSWORD/PGDATABASE`, `LIGHTDASH_SECRET`, `SITE_URL`, `PORT`, `LIGHTDASH_LICENSE_KEY=` (empty: core
  migrations only, pgvector is absent), `S3_ENDPOINT/S3_BUCKET/S3_REGION/S3_ACCESS_KEY/S3_SECRET_KEY` (→ the S3
  fake; check whether Lightdash needs path-style/force-path env). Also set `TZ=UTC`,
  `RUDDERSTACK_ANALYTICS_DISABLED=true` and anything else that phones home (no network: grep parseConfig for
  `https://`), `ALERTING_SECRET_<NAME>` for the incident.io token (`ALERTING_SECRET_INCIDENT_IO_DEMO` for
  `secretRef: incident-io-demo`). The scheduler ran in-process in the smoke (alerting health `ok`); check
  `SCHEDULER_ENABLED` and the scheduler's task list if you split it out. The frontend is the production build in
  `packages/frontend/build`, served by the backend (say so in `docs/eng-1799/demo.md`).
- **Seeding**: first user/org through the API (`/api/v1/register` or the org-registration flow the health
  endpoint asks for: `requiresOrgRegistration: true`), a personal access token, then the CLI from source
  (`pnpm -F @lightdash/cli exec tsx src/index.ts ...` with `LIGHTDASH_URL`, `LIGHTDASH_API_KEY`) for `upload`,
  `upload --alerting-only` and `import portal-scripts`; user attributes and groups through the API. The project is
  `type: postgres, flavor: federation` with `identitySigningSecret` = the engine's identity secret and `httpBaseUrl`
  = the engine's HTTP URL. The alert evaluator's system identity needs `platform_read` only if a rule reads the
  Platform Database.
- **telemetry-mcp**: `node packages/telemetry-mcp/dist/main.js` with the env in `PROGRESS-mcp.md` ("Env vars"):
  `OKTA_ISSUER`/`OKTA_AUDIENCE`/`OKTA_JWKS_URI` → the Okta fake, `LIGHTDASH_URL` + a service account/PAT for
  `LIGHTDASH_API_TOKEN`, `LIGHTDASH_PROJECT_UUID`, `ENGINE_PG_*`, `ENGINE_HTTP_URL`, `HRX_IDENTITY_SECRET`,
  `MCP_SOURCES` (JSON list matching the engine config).
- **Walkthrough**: `demo/eng-1799/walkthrough/playwright.config.ts` with `use.video: {mode: 'on', size: {width:
  1920, height: 1080}}` and `viewport` 1920x1080, one worker, scenes in file order; `run.sh` copies each scene's
  video and screenshot to `out/scenes/<id>/`. Read the URLs from `.state/stack.json`. The dashboard grid is
  react-grid-layout (`.react-grid-item`); the log stream and trace waterfall expose `data-testid`s
  (`log-stream-row` with `data-level`, `trace-span-row`, a Drawer on span click: see `PROGRESS-viz.md`).
- **Video**: build with one ffmpeg `filter_complex`: per input `fps=30,scale=1920:1080,drawbox+drawtext` (font e.g.
  `/System/Library/Fonts/Supplemental/Arial.ttf`; ffmpeg-static has `drawtext`, `xfade`, `afade`, `libx264`, `aac`),
  `xfade=transition=fade` chained with offsets = running length − fade, `-threads 2`. A throwaway prototype of
  exactly this passed all four video checks in the init session (about 25 s per build of 2.5 min of video).

## Risks and open questions for the feature sessions

1. **The integration branch.** Decision 2026-11-09: before the demo build run, the controls engineer merges the
   promoted `eng-1799-integration` branch into this one. After it lands, look for `e2e/eng-1799/` (fakes and boot
   code to reuse) and re-read `PROGRESS.md`/`PROGRESS-*.md` for changes. Prefer reusing over rewriting.
2. **Registry charts (stat, bar gauge, heatmap, state timeline)** are data-app visualizations under `ee/`; without
   a licence they may not render. The checks do not require registry charts: the stat may be a built-in big number
   with conditional formatting (the check looks for a red text/background/fill/stroke or a red `data-color` inside
   the `Current fill queue backlog` grid item, including same-origin iframes), the bar gauge a built-in chart, the
   heatmap a custom (Vega-Lite) chart. Record the choice in the docs.
3. **Explore-backed chart types.** `log_stream`, `trace_waterfall` and cartesian `thresholds` are saved-chart
   (explore) configs. A `none` project has no explores: use the native-git Lightdash semantic layer
   (`semanticLayer: 'lightdash'`) or virtual views over the engine's table functions, with the reserved
   `${ld.parameters.__from}` / `__to` / `__interval` parameters. Prove one Tile end to end before seeding all.
4. **Platform DB Tiles are Audited Queries** and need `audit.description`. If ldq's tile path sends none, the
   smallest fix (a description from the saved chart's description) is a small upstream edit outside `ee/`; record it.
5. **Alert timing.** Rule `interval` minimum is 30 s; the tick runs every 15 s. Seed the rules with `interval: 30s`,
   `for: 0s` (or short), and a route with short `groupWait`/`groupInterval` (about 5-10 s) so the alert checks fit.
6. **Check budget.** Most `--stack` checks should stay under 3 minutes warm, which means `up.sh` (boot + seed)
   must stay well under a minute and a half. `demo-stack-lifecycle` (two ups) and `demo-run-all` are allowed longer.

## Conventions

- New code in `demo/eng-1799/**` and `docs/eng-1799/demo.md`. Edits to upstream files only when unavoidable and
  small (a registration line). **Never touch any `ee/` directory** (the `demo-hygiene` check diffs against `f85d1ce60`).
- Never edit `demo/eng-1799/acceptance/**`. If a test is truly wrong, stop and say why in your result.
- Synthetic data only, obviously fake (names with Demo/Example/Fake, emails `@example.com`); no PHI; fake secrets
  `test-...-not-real`. No network at run time (no URLs other than localhost/example in demo code).
- **Music:** the video takes optional music only from `--music <file>` supplied by the person running it. The repo
  never contains, downloads or references any commercial or copyrighted audio (decision 2026-11-09: a request for a
  specific commercial track was declined). No audio files are committed (`.gitignore` enforces it).
- Glossary in UI copy, captions and docs: Telemetry Source, Federation Engine, Operations Project, Tile, Dashboard
  Time Range, Investigate, Alert Rule, Contact Point, Notification Route, Audited Query, Write Mode, Preview,
  Platform Database. Never: datasource, panel (for a Tile), dry run, notification policy, prod DB.
- `pnpm install --frozen-lockfile` must pass: whoever adds a dependency runs `pnpm install` and keeps the lockfile.
- Stop every server you start; leave no process running at the end of a session.

## Contract assumptions (demo line)

1. `up.sh` seeds by default; the goal allows `seed.sh` too, so `up.sh` may call it. The scenario clock starts when
   its server starts; `run-all.sh` restarts it right before the walkthrough so scene 1 begins at T.
2. "Ephemeral or configurable ports": ephemeral; the checks reject well-known ports.
3. The scripted AI client may call `query_promql` directly (the "model" is a script); `ask_data` is optional.
4. Alert Rules in the demo are ordinary (not Shadow Run), so notifications leave the process (to the local fake only).

## Feature order

package-workspace, config-validation, scenario-clock, platform-db, engine-boot, fake-prometheus, fake-loki,
fake-tempo, fake-cloudwatch-metrics, fake-cloudwatch-logs, audit-store, engine-healthy, fake-incident-io,
lightdash-backend, lightdash-frontend, stack-lifecycle, seed-project, lightdash-engine-query,
dashboard-pharmacy-ops, dashboard-pharmacy-ops-ui, dashboard-service-health, dashboard-platform-db, grafana-fixture,
portal-script, alerting-seed, alert-fires, alert-resolves, mcp-server, mcp-ask, scene-01 … scene-08, video-build,
video-cards-captions, video-thumbnail-chapters, video-music, docs, run-all-fails-cleanly, hygiene, run-all
(all prefixed `demo-`).

## Status

- 2026-11-08 init session: package skeleton, protected acceptance harness (40 specs, 45 features), `init-demo.sh`,
  this section. `bash ./init.sh` exits 0 (warm about 5 s). Checks run and failing for the intended reason:
  package (no `typecheck` script), config-validation (no `up.sh`), scenario-clock and pharmacy-ops-ui (`--stack`:
  "up.sh does not exist yet"), lifecycle, docs (no `demo.md`), hygiene (no `up.sh`), run-all-failure, video-build
  (no `video` script). The four video checks were also shown passable against a throwaway prototype build.
- 2026-11-09T01:56:50Z supervisor: initialized: 45 features, run 20261108-201404
