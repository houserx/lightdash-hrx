#!/usr/bin/env bash
# ENG-1799 demo: bring the local demo stack up.
#
#   bash demo/eng-1799/up.sh
#
# Scenario timeline (seconds after the scenario clock starts, the "T" of the walkthrough):
#   DEMO_INCIDENT_AT   when the fill-queue incident begins (default 90, i.e. T+90s)
#   DEMO_RECOVERY_AT   when the incident recovers           (default 300, i.e. T+5min)
# Both must be whole numbers with 0 <= DEMO_INCIDENT_AT < DEMO_RECOVERY_AT. They are validated before
# anything starts; a bad value exits non-zero naming the variable.
#
# All state lives under demo/eng-1799/.state/. Stop everything with demo/eng-1799/down.sh.
set -euo pipefail

DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$DEMO/.state"

die() {
    echo "up.sh: $*" >&2
    exit 2
}

# ---------------------------------------------------------------- configuration (validated before anything starts)

DEMO_INCIDENT_AT="${DEMO_INCIDENT_AT:-90}"
DEMO_RECOVERY_AT="${DEMO_RECOVERY_AT:-300}"

require_seconds() {
    local name="$1" value="$2"
    [[ "$value" =~ ^[0-9]+$ ]] ||
        die "$name must be a whole number of seconds >= 0 after the scenario start (got '$value')"
    # Bound the length so the arithmetic below cannot overflow.
    [ "${#value}" -le 9 ] || die "$name is too large (got '$value'; at most 999999999 seconds)"
}

require_seconds DEMO_INCIDENT_AT "$DEMO_INCIDENT_AT"
require_seconds DEMO_RECOVERY_AT "$DEMO_RECOVERY_AT"
if (( 10#$DEMO_RECOVERY_AT <= 10#$DEMO_INCIDENT_AT )); then
    die "DEMO_RECOVERY_AT ($DEMO_RECOVERY_AT) must be later than DEMO_INCIDENT_AT ($DEMO_INCIDENT_AT)"
fi
DEMO_INCIDENT_AT=$((10#$DEMO_INCIDENT_AT))
DEMO_RECOVERY_AT=$((10#$DEMO_RECOVERY_AT))
export DEMO_INCIDENT_AT DEMO_RECOVERY_AT

echo "up.sh: scenario timeline: incident at T+${DEMO_INCIDENT_AT}s, recovery at T+${DEMO_RECOVERY_AT}s"

# ---------------------------------------------------------------- stack

STACK_JSON="$STATE/stack.json"
RUN="$STATE/run"
LOGS="$STATE/logs"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "up.sh: node is not on PATH" >&2; exit 1; }
[ -d "$DEMO/node_modules/tsx" ] || { echo "up.sh: demo dependencies missing; run bash ./init.sh at the repo root" >&2; exit 1; }
[ -f "$DEMO/../../packages/frontend/build/index.html" ] ||
    { echo "up.sh: no frontend production build at packages/frontend/build; run bash ./init.sh at the repo root" >&2; exit 1; }
[ -f "$DEMO/../../packages/telemetry-mcp/dist/main.js" ] ||
    { echo "up.sh: telemetry-mcp is not built (packages/telemetry-mcp/dist); run bash ./init.sh at the repo root" >&2; exit 1; }

# Pids recorded in stack.json.
recorded_pids() {
    [ -f "$STACK_JSON" ] || return 0
    grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$STACK_JSON" | grep -oE '[0-9]+$' || true
}

# Prints a top-level "<key>": {"url": ...} value from a JSON file.
json_url() {
    "$NODE" -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (!v || !v.url) process.exit(1); console.log(v.url)' "$1" "$2"
}

report() {
    local scenario_url
    scenario_url="$(json_url "$STACK_JSON" scenario)"
    echo "up.sh: scenario clock: $scenario_url/scenario (restart: POST $scenario_url/scenario/restart)"
    echo "up.sh: Prometheus (fake): $(json_url "$STACK_JSON" prometheus)"
    echo "up.sh: Loki (fake): $(json_url "$STACK_JSON" loki)"
    echo "up.sh: Tempo (fake): $(json_url "$STACK_JSON" tempo)"
    echo "up.sh: CloudWatch metrics (fake): $(json_url "$STACK_JSON" cloudwatch)"
    echo "up.sh: CloudWatch Logs Insights (fake): $(json_url "$STACK_JSON" cloudwatchLogs)"
    echo "up.sh: audit store (fake): DynamoDB $(json_url "$STACK_JSON" auditDynamodb), S3 Object Lock $(json_url "$STACK_JSON" auditS3)"
    echo "up.sh: incident.io receiver (fake): $(json_url "$STACK_JSON" incidentIo) (webhook: POST /webhook, received: GET /api/received)"
    "$NODE" -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).platformDb; console.log(`up.sh: Platform Database: postgres://${p.user}@${p.host}:${p.port}/${p.database} (password in .state/stack.json platformDb)`)' "$STACK_JSON"
    "$NODE" -e 'const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).engine; console.log(`up.sh: Federation Engine: postgres://${e.user}@${e.host}:${e.pgPort}/${e.database} (password in .state/stack.json engine), health ${e.httpUrl}/healthz`)' "$STACK_JSON"
    echo "up.sh: Lightdash: $(json_url "$STACK_JSON" lightdash) (backend with the scheduler and alert worker in-process; results S3 (fake) $(json_url "$STACK_JSON" lightdashS3))"
    "$NODE" -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(`up.sh: telemetry-mcp: ${s.mcp.url}/mcp (health ${s.mcp.url}/healthz); fake Okta issuer ${s.okta.issuer} (a token: POST ${s.okta.issuer}/v1/token {"email": ...})`)' "$STACK_JSON"
    "$NODE" -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(`up.sh: sign in as ${s.demoUser.email} (password in .state/stack.json demoUser); Operations Project: ${s.lightdash.url}/projects/${s.lightdash.projectUuid}/home`)' "$STACK_JSON"
}

# A live stack (every recorded pid running, the scenario clock answering) is kept as it is.
if [ -f "$STACK_JSON" ]; then
    live=yes
    pids="$(recorded_pids)"
    [ -n "$pids" ] || live=""
    for pid in $pids; do kill -0 "$pid" 2>/dev/null || live=""; done
    if [ -n "$live" ] && curl -fsS -m 5 "$(json_url "$STACK_JSON" scenario)/scenario" >/dev/null 2>&1; then
        echo "up.sh: the demo stack is already running; nothing changed (the scenario clock keeps its current timeline; POST /scenario/restart to change it)"
        report
        exit 0
    fi
    echo "up.sh: stack.json describes a stack that is not fully running; stopping what is left"
    bash "$DEMO/down.sh"
fi

mkdir -p "$STATE" "$RUN" "$LOGS"
STARTED_PIDS=""

# On any failure, stop what this run started (each service leads its own process group).
on_exit() {
    local status=$?
    if [ "$status" -ne 0 ] && [ ! -f "$STACK_JSON" ]; then
        for pid in $STARTED_PIDS; do
            kill -TERM -- "-$pid" 2>/dev/null || true
            kill -TERM "$pid" 2>/dev/null || true
        done
    fi
}
trap on_exit EXIT

# start <name> <command...>: runs the command in its own process group (perl setpgrp + exec keeps the pid),
# detached from up.sh's stdio, logging to .state/logs/<name>.log. Sets STARTED_PID.
# With DEMO_START_ENV_FILE=<file> set for the call, the command gets exactly the KEY=value lines of that file
# as its environment (nothing of up.sh's environment leaks in, and no secret appears on a command line).
# With DEMO_START_DIR=<dir> set for the call, the command runs in <dir> instead of demo/eng-1799.
EXEC_WITH_ENV_FILE='
    if (defined(my $file = delete $ENV{DEMO_START_ENV_FILE})) {
        open(my $fh, "<", $file) or die "open $file: $!\n";
        %ENV = ();
        while (my $line = <$fh>) {
            chomp $line;
            $ENV{$1} = $2 if $line =~ /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
        }
        close($fh);
    }
    exec @ARGV or die "exec $ARGV[0]: $!\n";'
start() {
    local name="$1"
    shift
    (cd "${DEMO_START_DIR:-$DEMO}" && exec perl -e "setpgrp(0, 0); $EXEC_WITH_ENV_FILE" "$@") \
        </dev/null >"$LOGS/$name.log" 2>&1 &
    STARTED_PID=$!
    STARTED_PIDS="$STARTED_PIDS $STARTED_PID"
}

# wait_ready <name> <pid> <file> <seconds>: waits until the service wrote its ready file.
wait_ready() {
    local name="$1" pid="$2" file="$3" deadline=$((SECONDS + $4))
    while [ ! -s "$file" ]; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "up.sh: $name exited during start-up; last lines of ${LOGS#"$DEMO"/}/$name.log:" >&2
            tail -20 "$LOGS/$name.log" >&2
            exit 1
        fi
        if [ "$SECONDS" -ge "$deadline" ]; then
            echo "up.sh: $name did not become ready within $4 s (see ${LOGS#"$DEMO"/}/$name.log)" >&2
            exit 1
        fi
        sleep 0.2
    done
}

# Platform Database: a fresh throwaway cluster under .state/platform-db (synthetic pharmacy operations data).
PG_BIN="${DEMO_PG_BIN:-}"
[ -n "$PG_BIN" ] || PG_BIN="$(dirname "$(command -v postgres || echo /opt/homebrew/bin/postgres)")"
[ -x "$PG_BIN/postgres" ] && [ -x "$PG_BIN/initdb" ] ||
    { echo "up.sh: postgres/initdb not found (looked in $PG_BIN; set DEMO_PG_BIN)" >&2; exit 1; }
export DEMO_PG_BIN="$PG_BIN"
PLATFORM_DIR="$STATE/platform-db"
rm -f "$RUN/platform-db.json"
PLATFORM_PORT="$(cd "$DEMO" && "$NODE" --import tsx "$DEMO/stack/platform-db.ts" prepare --dir "$PLATFORM_DIR" 2>>"$LOGS/platform-db-init.log")" ||
    { echo "up.sh: creating the Platform Database cluster failed (see ${LOGS#"$DEMO"/}/platform-db-init.log)" >&2; exit 1; }
[[ "$PLATFORM_PORT" =~ ^[0-9]+$ ]] ||
    { echo "up.sh: stack/platform-db.ts prepare printed no port (got '$PLATFORM_PORT')" >&2; exit 1; }
start platform-db "$PG_BIN/postgres" -D "$PLATFORM_DIR/pgdata"
PLATFORM_PID=$STARTED_PID
(cd "$DEMO" && "$NODE" --import tsx "$DEMO/stack/platform-db.ts" seed --port "$PLATFORM_PORT" --pid "$PLATFORM_PID" \
    --ready-file "$RUN/platform-db.json") >>"$LOGS/platform-db-init.log" 2>&1 || {
    echo "up.sh: seeding the Platform Database failed; last lines of ${LOGS#"$DEMO"/}/platform-db-init.log and platform-db.log:" >&2
    tail -10 "$LOGS/platform-db-init.log" "$LOGS/platform-db.log" >&2
    exit 1
}
echo "up.sh: Platform Database seeded (synthetic orders, fills, queues, shipments)"

# Federation Engine: this repo's federation-engine binary with a config under .state/engine listing every demo
# Telemetry Source and the Platform Database. The root init.sh builds the binary into tmp/cargo-target (one build
# for the e2e and demo lines); it is run as federation-engine/target/debug/engine, a symlink to that build, unless
# the engine line's own build is there. DEMO_ENGINE_BIN overrides the binary.
ROOT="$(cd "$DEMO/../.." && pwd)"
ENGINE_BIN="${DEMO_ENGINE_BIN:-}"
if [ -z "$ENGINE_BIN" ]; then
    ENGINE_BIN="$ROOT/federation-engine/target/debug/engine"
    ENGINE_BUILD="$ROOT/tmp/cargo-target/debug/engine"
    if [ ! -f "$ENGINE_BIN" ] || [ -L "$ENGINE_BIN" ]; then
        [ -x "$ENGINE_BUILD" ] ||
            { echo "up.sh: no Federation Engine binary at ${ENGINE_BUILD#"$ROOT"/}; run bash ./init.sh at the repo root" >&2; exit 1; }
        mkdir -p "$(dirname "$ENGINE_BIN")"
        ln -sfn "$ENGINE_BUILD" "$ENGINE_BIN"
    fi
fi
[ -x "$ENGINE_BIN" ] || { echo "up.sh: the Federation Engine binary $ENGINE_BIN is not executable" >&2; exit 1; }
ENGINE_DIR="$STATE/engine"
ENGINE_CONFIG="$ENGINE_DIR/federation-engine.toml"
rm -f "$RUN/engine-config.json"
(cd "$DEMO" && "$NODE" --import tsx "$DEMO/stack/engine-config.ts" --dir "$ENGINE_DIR" \
    --platform-file "$RUN/platform-db.json" --ready-file "$RUN/engine-config.json") ||
    { echo "up.sh: writing the Federation Engine config failed" >&2; exit 1; }
DEMO_START_ENV_FILE="$ENGINE_DIR/engine.env" perl -e "$EXEC_WITH_ENV_FILE" "$ENGINE_BIN" --check-config --config "$ENGINE_CONFIG" >"$LOGS/engine-check.log" 2>&1 || {
    echo "up.sh: the Federation Engine refused its config (${ENGINE_CONFIG#"$DEMO"/}):" >&2
    tail -20 "$LOGS/engine-check.log" >&2
    exit 1
}
# Scenario clock + telemetry fakes (one process sharing one clock). They listen on the endpoints the engine
# config just reserved, so they start before the engine. The clock starts now: T = this moment.
rm -f "$RUN/telemetry-fakes.json"
start telemetry-fakes "$NODE" --import tsx "$DEMO/stack/telemetry-fakes.ts" --endpoints-file "$RUN/engine-config.json" \
    --ready-file "$RUN/telemetry-fakes.json"
TELEMETRY_PID=$STARTED_PID
wait_ready telemetry-fakes "$TELEMETRY_PID" "$RUN/telemetry-fakes.json" 30
SCENARIO_URL="$(json_url "$RUN/telemetry-fakes.json" scenario)"
curl -fsS -m 5 "$SCENARIO_URL/scenario" >/dev/null ||
    { echo "up.sh: the scenario clock at $SCENARIO_URL does not answer" >&2; exit 1; }
PROMETHEUS_URL="$(json_url "$RUN/telemetry-fakes.json" prometheus)"
curl -fsS -m 5 "$PROMETHEUS_URL/-/ready" >/dev/null ||
    { echo "up.sh: the fake Prometheus at $PROMETHEUS_URL does not answer" >&2; exit 1; }
LOKI_URL="$(json_url "$RUN/telemetry-fakes.json" loki)"
curl -fsS -m 5 "$LOKI_URL/ready" >/dev/null ||
    { echo "up.sh: the fake Loki at $LOKI_URL does not answer" >&2; exit 1; }
TEMPO_URL="$(json_url "$RUN/telemetry-fakes.json" tempo)"
curl -fsS -m 5 "$TEMPO_URL/ready" >/dev/null ||
    { echo "up.sh: the fake Tempo at $TEMPO_URL does not answer" >&2; exit 1; }
CLOUDWATCH_URL="$(json_url "$RUN/telemetry-fakes.json" cloudwatch)"
curl -fsS -m 5 "$CLOUDWATCH_URL/ready" >/dev/null ||
    { echo "up.sh: the fake CloudWatch at $CLOUDWATCH_URL does not answer" >&2; exit 1; }
CLOUDWATCH_LOGS_URL="$(json_url "$RUN/telemetry-fakes.json" cloudwatchLogs)"
curl -fsS -m 5 "$CLOUDWATCH_LOGS_URL/ready" >/dev/null ||
    { echo "up.sh: the fake CloudWatch Logs at $CLOUDWATCH_LOGS_URL does not answer" >&2; exit 1; }
for store in auditDynamodb auditS3; do
    AUDIT_URL="$(json_url "$RUN/telemetry-fakes.json" "$store")"
    curl -fsS -m 5 "$AUDIT_URL/ready" >/dev/null ||
        { echo "up.sh: the fake audit store ($store) at $AUDIT_URL does not answer" >&2; exit 1; }
done
INCIDENT_IO_URL="$(json_url "$RUN/telemetry-fakes.json" incidentIo)"
curl -fsS -m 5 "$INCIDENT_IO_URL/ready" >/dev/null ||
    { echo "up.sh: the fake incident.io receiver at $INCIDENT_IO_URL does not answer" >&2; exit 1; }

DEMO_START_ENV_FILE="$ENGINE_DIR/engine.env" start engine "$ENGINE_BIN" --config "$ENGINE_CONFIG"
ENGINE_PID=$STARTED_PID
ENGINE_HTTP_URL="$("$NODE" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).engine.httpUrl)' "$RUN/engine-config.json")"
# Ready when the HTTP side port answers /healthz at all (503 is fine: fakes that later features add may be absent).
deadline=$((SECONDS + 60))
until [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$ENGINE_HTTP_URL/healthz" || true)" != "000" ]; do
    if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
        echo "up.sh: the Federation Engine exited during start-up; last lines of ${LOGS#"$DEMO"/}/engine.log:" >&2
        tail -20 "$LOGS/engine.log" >&2
        exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
        echo "up.sh: the Federation Engine did not answer within 60 s (see ${LOGS#"$DEMO"/}/engine.log)" >&2
        exit 1
    fi
    sleep 0.2
done
echo "up.sh: Federation Engine running (${ENGINE_BIN#"$ROOT"/}, config ${ENGINE_CONFIG#"$DEMO"/})"

# Lightdash backend: its own throwaway Postgres under .state/lightdash (fresh and migrated every up.sh), results
# and exports in the fake S3 of the telemetry-fakes process, the scheduler worker (and with it the alert worker)
# in-process, on an ephemeral port (served as http://127.0.0.1:<port>; Lightdash's App has no listen-address
# setting and binds every interface). Its whole environment is .state/lightdash/lightdash.env (written by
# stack/lightdash.ts; phone-home features off).
LIGHTDASH_S3_URL="$(json_url "$RUN/telemetry-fakes.json" lightdashS3)"
curl -fsS -m 5 "$LIGHTDASH_S3_URL/ready" >/dev/null ||
    { echo "up.sh: the fake results S3 at $LIGHTDASH_S3_URL does not answer" >&2; exit 1; }
LIGHTDASH_DIR="$STATE/lightdash"
rm -f "$RUN/lightdash.json"
# The backend runs on the Node the workspace pins for pnpm (package.json devEngines; the backend's native addons,
# such as Sentry's profiler, have no build for newer Node majors). DEMO_LIGHTDASH_NODE overrides it.
LIGHTDASH_NODE="${DEMO_LIGHTDASH_NODE:-}"
[ -n "$LIGHTDASH_NODE" ] ||
    LIGHTDASH_NODE="$(cd "$ROOT" && pnpm --silent exec node -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)"
[ -x "$LIGHTDASH_NODE" ] ||
    { echo "up.sh: cannot find the workspace's pinned Node for Lightdash (pnpm exec node); run bash ./init.sh or set DEMO_LIGHTDASH_NODE" >&2; exit 1; }
(cd "$DEMO" && "$NODE" --import tsx "$DEMO/stack/lightdash.ts" prepare --dir "$LIGHTDASH_DIR" --s3-url "$LIGHTDASH_S3_URL" \
    --ready-file "$RUN/lightdash.json") >>"$LOGS/lightdash-init.log" 2>&1 || {
    echo "up.sh: creating the Lightdash database cluster failed; last lines of ${LOGS#"$DEMO"/}/lightdash-init.log:" >&2
    tail -20 "$LOGS/lightdash-init.log" >&2
    exit 1
}
start lightdash-db "$PG_BIN/postgres" -D "$LIGHTDASH_DIR/pgdata"
LIGHTDASH_DB_PID=$STARTED_PID
(cd "$DEMO" && "$LIGHTDASH_NODE" --import tsx "$DEMO/stack/lightdash.ts" migrate --env-file "$LIGHTDASH_DIR/lightdash.env" \
    --pid "$LIGHTDASH_DB_PID") >>"$LOGS/lightdash-init.log" 2>&1 || {
    echo "up.sh: migrating the Lightdash database failed; last lines of ${LOGS#"$DEMO"/}/lightdash-init.log and lightdash-db.log:" >&2
    tail -20 "$LOGS/lightdash-init.log" "$LOGS/lightdash-db.log" >&2
    exit 1
}
echo "up.sh: Lightdash database migrated"
# stack/lightdash-server.ts boots the backend's App (as src/index.ts does, without its Sentry bootstrap). It runs
# from packages/backend so tsx compiles the backend with its own tsconfig, as `pnpm -F backend dev` does. The
# trailing argument is ignored; it puts .state on the command line so down.sh finds the process even without
# stack.json.
DEMO_START_DIR="$ROOT/packages/backend" DEMO_START_ENV_FILE="$LIGHTDASH_DIR/lightdash.env" \
    start lightdash "$LIGHTDASH_NODE" --import tsx "$DEMO/stack/lightdash-server.ts" --demo-env-file "$LIGHTDASH_DIR/lightdash.env"
LIGHTDASH_PID=$STARTED_PID
LIGHTDASH_URL="$(json_url "$RUN/lightdash.json" lightdash)"
deadline=$((SECONDS + ${DEMO_LIGHTDASH_START_SECONDS:-240}))
until curl -fsS -m 5 "$LIGHTDASH_URL/api/v1/health" >/dev/null 2>&1; do
    if ! kill -0 "$LIGHTDASH_PID" 2>/dev/null; then
        echo "up.sh: the Lightdash backend exited during start-up; last lines of ${LOGS#"$DEMO"/}/lightdash.log:" >&2
        tail -30 "$LOGS/lightdash.log" >&2
        exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
        echo "up.sh: the Lightdash backend did not answer /api/v1/health within ${DEMO_LIGHTDASH_START_SECONDS:-240} s (see ${LOGS#"$DEMO"/}/lightdash.log)" >&2
        exit 1
    fi
    sleep 1
done
echo "up.sh: Lightdash backend running ($LIGHTDASH_URL)"
# The UI is the frontend's production build, served by the backend itself (docs/eng-1799/demo.md, "Frontend mode").
LIGHTDASH_UI_HTML="$(curl -fsS -m 10 "$LIGHTDASH_URL/login" 2>/dev/null || true)"
[[ "$LIGHTDASH_UI_HTML" == *'<div id="root"'* ]] ||
    { echo "up.sh: the Lightdash backend does not serve the UI at $LIGHTDASH_URL/login (frontend build missing? run bash ./init.sh)" >&2; exit 1; }

# Seed (through Lightdash's HTTP API; the database is new on every fresh up.sh): the demo user and its organization,
# the Operations Project on the Federation Engine flavour, the user attributes platform_read/platform_write, then
# the dashboards in content/ and the imported portal scripts through `lightdash upload` (the CLI from source; see
# stack/seed.ts). Then the alerting code in alerting/ (two Alert Rules, the incident.io Contact Point on the fake
# receiver, the Notification Route tree) through `lightdash upload --alerting-only`, from a copy under
# .state/run/alerting with the receiver's URL filled in.
# The upload reads a copy of content/ under .state/run/content, to which `lightdash import portal-scripts` adds one SQL
# chart per saved script of the synthetic db-query-portal export seed/portal-scripts.json (SQL kept verbatim, in the
# space platform-saved-sql). The CLI runs from source on the pinned Node, with HOME under .state and no network.
CLI_DIR="$ROOT/packages/cli"
SEED_CONTENT="$RUN/content"
rm -rf "$SEED_CONTENT"
cp -R "$DEMO/content" "$SEED_CONTENT"
mkdir -p "$STATE/cli-home"
chmod 700 "$STATE/cli-home"
(cd "$CLI_DIR" && HOME="$STATE/cli-home" CI=true NODE_OPTIONS="--import $DEMO/stack/no-network.mjs" \
    "$LIGHTDASH_NODE" "$CLI_DIR/node_modules/tsx/dist/cli.mjs" src/index.ts \
    import portal-scripts "$DEMO/seed/portal-scripts.json" --path "$SEED_CONTENT" --space platform-saved-sql) \
    >>"$LOGS/seed.log" 2>&1 || {
    echo "up.sh: lightdash import portal-scripts failed; last lines of ${LOGS#"$DEMO"/}/seed.log:" >&2
    tail -20 "$LOGS/seed.log" >&2
    exit 1
}
rm -f "$RUN/seed.json"
(cd "$DEMO" && "$NODE" --import tsx "$DEMO/stack/seed.ts" --lightdash-url "$LIGHTDASH_URL" \
    --engine-file "$RUN/engine-config.json" --content-dir "$SEED_CONTENT" --cli-home "$STATE/cli-home" \
    --cli-node "$LIGHTDASH_NODE" \
    --alerting-dir "$DEMO/alerting" --alerting-out "$RUN/alerting" --incident-io-url "$INCIDENT_IO_URL" \
    --ready-file "$RUN/seed.json") >>"$LOGS/seed.log" 2>&1 || {
    echo "up.sh: seeding Lightdash failed; last lines of ${LOGS#"$DEMO"/}/seed.log:" >&2
    tail -20 "$LOGS/seed.log" >&2
    exit 1
}
echo "up.sh: Lightdash seeded (demo user, Operations Project on the Federation Engine flavour, dashboards and alerting uploaded)"

# telemetry-mcp (packages/telemetry-mcp, built by init.sh) on an ephemeral port, against the engine (its own pg-wire
# login), Lightdash (the seed's personal access token as its service account) and the fake Okta in the
# telemetry-fakes process. Its whole environment is .state/mcp/mcp.env (written by stack/mcp.ts). The trailing
# argument is ignored; it puts .state on the command line so down.sh finds the process even without stack.json.
MCP_DIR="$STATE/mcp"
rm -f "$RUN/mcp.json"
(cd "$DEMO" && "$NODE" --import tsx "$DEMO/stack/mcp.ts" --dir "$MCP_DIR" --engine-file "$RUN/engine-config.json" \
    --fakes-file "$RUN/telemetry-fakes.json" --seed-file "$RUN/seed.json" --lightdash-url "$LIGHTDASH_URL" \
    --ready-file "$RUN/mcp.json") ||
    { echo "up.sh: writing the telemetry-mcp environment failed" >&2; exit 1; }
DEMO_START_ENV_FILE="$MCP_DIR/mcp.env" \
    start telemetry-mcp "$NODE" "$ROOT/packages/telemetry-mcp/dist/main.js" --demo-env-file "$MCP_DIR/mcp.env"
MCP_PID=$STARTED_PID
MCP_URL="$(json_url "$RUN/mcp.json" mcp)"
deadline=$((SECONDS + 30))
until curl -fsS -m 5 "$MCP_URL/healthz" >/dev/null 2>&1; do
    if ! kill -0 "$MCP_PID" 2>/dev/null; then
        echo "up.sh: telemetry-mcp exited during start-up; last lines of ${LOGS#"$DEMO"/}/telemetry-mcp.log:" >&2
        tail -20 "$LOGS/telemetry-mcp.log" >&2
        exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
        echo "up.sh: telemetry-mcp did not answer /healthz within 30 s (see ${LOGS#"$DEMO"/}/telemetry-mcp.log)" >&2
        exit 1
    fi
    sleep 0.2
done
echo "up.sh: telemetry-mcp running ($MCP_URL)"

"$NODE" -e '
const [file, telemetryFile, telemetryPid, platformFile, platformPid, engineFile, enginePid, lightdashFile, lightdashDbPid, lightdashPid,
    seedFile, mcpFile, mcpPid] = process.argv.slice(1);
const fs = require("fs");
const telemetry = JSON.parse(fs.readFileSync(telemetryFile, "utf8"));
const lightdash = JSON.parse(fs.readFileSync(lightdashFile, "utf8"));
const seeded = JSON.parse(fs.readFileSync(seedFile, "utf8"));
const stack = {
    scenario: telemetry.scenario,
    prometheus: telemetry.prometheus,
    loki: telemetry.loki,
    tempo: telemetry.tempo,
    cloudwatch: telemetry.cloudwatch,
    cloudwatchLogs: telemetry.cloudwatchLogs,
    auditDynamodb: telemetry.auditDynamodb,
    auditS3: telemetry.auditS3,
    incidentIo: telemetry.incidentIo,
    platformDb: JSON.parse(fs.readFileSync(platformFile, "utf8")).platformDb,
    engine: JSON.parse(fs.readFileSync(engineFile, "utf8")).engine,
    lightdash: { ...lightdash.lightdash, projectUuid: seeded.lightdash.projectUuid },
    demoUser: seeded.demoUser,
    lightdashDb: lightdash.lightdashDb,
    lightdashS3: telemetry.lightdashS3,
    mcp: JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcp,
    okta: { issuer: telemetry.okta.issuer },
    processes: [
        { name: "telemetry-fakes", pid: Number(telemetryPid) },
        { name: "platform-db", pid: Number(platformPid) },
        { name: "engine", pid: Number(enginePid) },
        { name: "lightdash-db", pid: Number(lightdashDbPid) },
        { name: "lightdash", pid: Number(lightdashPid) },
        { name: "telemetry-mcp", pid: Number(mcpPid) },
    ],
};
fs.writeFileSync(file + ".tmp", JSON.stringify(stack, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(file + ".tmp", file);
' "$STACK_JSON" "$RUN/telemetry-fakes.json" "$TELEMETRY_PID" "$RUN/platform-db.json" "$PLATFORM_PID" "$RUN/engine-config.json" "$ENGINE_PID" \
    "$RUN/lightdash.json" "$LIGHTDASH_DB_PID" "$LIGHTDASH_PID" "$RUN/seed.json" "$RUN/mcp.json" "$MCP_PID"

echo "up.sh: demo stack is up (state: ${STATE#"$DEMO"/}, stop with demo/eng-1799/down.sh)"
report
