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
start() {
    local name="$1"
    shift
    (cd "$DEMO" && exec perl -e 'setpgrp(0, 0); exec @ARGV or die "exec $ARGV[0]: $!\n"' "$@") \
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

# Scenario clock (+ the telemetry fakes that will share it). The clock starts now: T = this moment.
rm -f "$RUN/telemetry-fakes.json"
start telemetry-fakes "$NODE" --import tsx "$DEMO/stack/telemetry-fakes.ts" --ready-file "$RUN/telemetry-fakes.json"
TELEMETRY_PID=$STARTED_PID
wait_ready telemetry-fakes "$TELEMETRY_PID" "$RUN/telemetry-fakes.json" 30
SCENARIO_URL="$(json_url "$RUN/telemetry-fakes.json" scenario)"
curl -fsS -m 5 "$SCENARIO_URL/scenario" >/dev/null ||
    { echo "up.sh: the scenario clock at $SCENARIO_URL does not answer" >&2; exit 1; }

# Later demo features start the Platform Database, Federation Engine, remaining fakes, Lightdash and telemetry-mcp here
# and add them to stack.json below.

"$NODE" -e '
const [file, scenarioUrl, telemetryPid] = process.argv.slice(1);
const stack = {
    scenario: { url: scenarioUrl },
    processes: [{ name: "telemetry-fakes", pid: Number(telemetryPid) }],
};
const fs = require("fs");
fs.writeFileSync(file + ".tmp", JSON.stringify(stack, null, 2) + "\n");
fs.renameSync(file + ".tmp", file);
' "$STACK_JSON" "$SCENARIO_URL" "$TELEMETRY_PID"

echo "up.sh: demo stack is up (state: ${STATE#"$DEMO"/}, stop with demo/eng-1799/down.sh)"
report
