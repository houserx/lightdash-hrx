#!/usr/bin/env bash
# ENG-1799 demo: the whole demo in one command.
#
#   demo/eng-1799/run-all.sh [--keep]
#
# Steps, in order:
#   1. up.sh                 start and seed the stack (demo/eng-1799/up.sh)
#   2. scenario restart      POST <scenario.url>/scenario/restart with DEMO_INCIDENT_AT / DEMO_RECOVERY_AT, so the
#                            walkthrough starts at T=0 whether or not the stack was already running
#   3. walkthrough/run.sh    record all eight scenes
#   4. video build           pnpm -F eng-1799-demo video (out/eng-1799-demo.mp4)
#   5. down.sh               stop everything (skipped with --keep when every step passed)
#
# DEMO_INCIDENT_AT (default 90) and DEMO_RECOVERY_AT (default 300) are seconds after the scenario start, whole
# numbers with DEMO_INCIDENT_AT < DEMO_RECOVERY_AT. They are checked before anything starts; a bad value exits 2
# naming the variable. Any other DEMO_* variable reaches the steps unchanged.
#
# It stops at the first step that fails and exits non-zero. On failure, and on TERM, INT or HUP, it stops the
# running step and runs down.sh (even with --keep), so no demo process is left behind.
set -euo pipefail

DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DEMO/../.." && pwd)"

log() { echo "run-all: $*"; }
die() {
    echo "run-all: $*" >&2
    exit 2
}

KEEP=""
for arg in "$@"; do
    case "$arg" in
    --keep) KEEP=yes ;;
    -h | --help)
        sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    *) die "unknown argument '$arg' (usage: run-all.sh [--keep])" ;;
    esac
done

# ---------------------------------------------------------------- configuration (checked before anything starts)

DEMO_INCIDENT_AT="${DEMO_INCIDENT_AT:-90}"
DEMO_RECOVERY_AT="${DEMO_RECOVERY_AT:-300}"

require_seconds() {
    local name="$1" value="$2"
    [[ "$value" =~ ^[0-9]+$ ]] ||
        die "$name must be a whole number of seconds >= 0 after the scenario start (got '$value')"
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

command -v node >/dev/null || die "node is not on PATH"
command -v pnpm >/dev/null || die "pnpm is not on PATH"
command -v curl >/dev/null || die "curl is not on PATH"

# ---------------------------------------------------------------- step runner and clean-up

STEP_PID=""   # the running step (a background job, so a signal reaches this script at once)
STARTED=""    # set once up.sh has been run; down.sh is only needed from then on
OK=""         # set when every step passed

# Runs one step as a background job and waits for it; a failing step stops the run.
step() {
    local name="$1"
    shift
    log "step: $name"
    "$@" &
    STEP_PID=$!
    local status=0
    wait "$STEP_PID" || status=$?
    STEP_PID=""
    if [ "$status" -ne 0 ]; then
        echo "run-all: step '$name' FAILED (exit $status); stopping" >&2
        exit 1
    fi
}

stop_step() {
    [ -n "$STEP_PID" ] || return 0
    kill -TERM "$STEP_PID" 2>/dev/null || true
    wait "$STEP_PID" 2>/dev/null || true
    STEP_PID=""
}

on_exit() {
    local status=$?
    trap - EXIT INT TERM HUP
    stop_step
    if [ -n "$STARTED" ]; then
        if [ -n "$OK" ] && [ -n "$KEEP" ]; then
            log "--keep: the stack is still running; stop it with demo/eng-1799/down.sh"
        else
            log "step: down.sh"
            if ! bash "$DEMO/down.sh"; then
                echo "run-all: down.sh failed" >&2
                [ "$status" -ne 0 ] || status=1
            fi
        fi
    fi
    exit "$status"
}

on_signal() {
    echo "run-all: stopped by a signal" >&2
    exit 143
}

trap on_exit EXIT
trap on_signal TERM INT HUP

# ---------------------------------------------------------------- the demo

cd "$ROOT"
log "scenario timeline: incident at T+${DEMO_INCIDENT_AT}s, recovery at T+${DEMO_RECOVERY_AT}s"

STARTED=yes
step "up.sh" bash "$DEMO/up.sh"

restart_scenario() {
    local url
    url="$(node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!s.scenario || !s.scenario.url) process.exit(1); console.log(s.scenario.url)' "$DEMO/.state/stack.json")" ||
        { echo "run-all: no scenario.url in .state/stack.json" >&2; return 1; }
    curl -fsS -m 10 -X POST "$url/scenario/restart" -H 'content-type: application/json' \
        -d "{\"incidentAfterSeconds\": $DEMO_INCIDENT_AT, \"recoveryAfterSeconds\": $DEMO_RECOVERY_AT}" >/dev/null ||
        { echo "run-all: POST $url/scenario/restart failed" >&2; return 1; }
    echo "run-all: scenario clock restarted at $url (incident at T+${DEMO_INCIDENT_AT}s, recovery at T+${DEMO_RECOVERY_AT}s)"
}
step "scenario restart" restart_scenario
step "walkthrough" bash "$DEMO/walkthrough/run.sh"
step "video build" pnpm --silent -F eng-1799-demo video

OK=yes
log "done: out/eng-1799-demo.mp4, out/CHAPTERS.md, out/thumbnail.png, out/scenes/"
