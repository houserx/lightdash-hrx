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
    "$NODE" -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).platformDb; console.log(`up.sh: Platform Database: postgres://${p.user}@${p.host}:${p.port}/${p.database} (password in .state/stack.json platformDb)`)' "$STACK_JSON"
    "$NODE" -e 'const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).engine; console.log(`up.sh: Federation Engine: postgres://${e.user}@${e.host}:${e.pgPort}/${e.database} (password in .state/stack.json engine), health ${e.httpUrl}/healthz`)' "$STACK_JSON"
    # The Lightdash feature adds the "Lightdash: <lightdash.url>" line here.
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
    (cd "$DEMO" && exec perl -e "setpgrp(0, 0); $EXEC_WITH_ENV_FILE" "$@") \
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

# Later demo features add the remaining fakes to the telemetry-fakes process (on the endpoints in
# .state/run/engine-config.json), start Lightdash and telemetry-mcp here and add them to stack.json below.

"$NODE" -e '
const [file, telemetryFile, telemetryPid, platformFile, platformPid, engineFile, enginePid] = process.argv.slice(1);
const fs = require("fs");
const telemetry = JSON.parse(fs.readFileSync(telemetryFile, "utf8"));
const stack = {
    scenario: telemetry.scenario,
    prometheus: telemetry.prometheus,
    loki: telemetry.loki,
    tempo: telemetry.tempo,
    cloudwatch: telemetry.cloudwatch,
    platformDb: JSON.parse(fs.readFileSync(platformFile, "utf8")).platformDb,
    engine: JSON.parse(fs.readFileSync(engineFile, "utf8")).engine,
    processes: [
        { name: "telemetry-fakes", pid: Number(telemetryPid) },
        { name: "platform-db", pid: Number(platformPid) },
        { name: "engine", pid: Number(enginePid) },
    ],
};
fs.writeFileSync(file + ".tmp", JSON.stringify(stack, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(file + ".tmp", file);
' "$STACK_JSON" "$RUN/telemetry-fakes.json" "$TELEMETRY_PID" "$RUN/platform-db.json" "$PLATFORM_PID" "$RUN/engine-config.json" "$ENGINE_PID"

echo "up.sh: demo stack is up (state: ${STATE#"$DEMO"/}, stop with demo/eng-1799/down.sh)"
report
