#!/usr/bin/env bash
# ENG-1799 demo line: run ONE acceptance spec. PROTECTED (demo/eng-1799/acceptance/**).
#
#   bash demo/eng-1799/acceptance/run.sh [--stack] <spec-file> [extra playwright args, e.g. --grep "<test title>"]
#
# --stack   bring the demo stack up first (demo/eng-1799/down.sh, then demo/eng-1799/up.sh) and
#           ALWAYS bring it down again afterwards (trap), even when the spec fails or is killed.
#
# Environment that reaches up.sh unchanged: DEMO_INCIDENT_AT, DEMO_RECOVERY_AT and any other DEMO_*.
# up.sh's output is kept in tmp/demo-acceptance/up.log (repo root) for the specs and for debugging.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEMO="$ROOT/demo/eng-1799"
cd "$ROOT"

WITH_STACK=""
if [ "${1:-}" = "--stack" ]; then
    WITH_STACK=yes
    shift
fi
SPEC="${1:?usage: run.sh [--stack] <spec-file> [playwright args, e.g. --grep <title>]}"
shift
[ -f "$DEMO/acceptance/$SPEC" ] || { echo "run.sh: no such spec: $SPEC" >&2; exit 2; }

LOGDIR="$ROOT/tmp/demo-acceptance"
mkdir -p "$LOGDIR"
export DEMO_ACCEPTANCE_LOGDIR="$LOGDIR"
export DEMO_ACCEPTANCE_DEMO_DIR="$DEMO"

stack_down() {
    if [ -f "$DEMO/down.sh" ]; then
        bash "$DEMO/down.sh" >>"$LOGDIR/down.log" 2>&1 || echo "run.sh: down.sh failed (see $LOGDIR/down.log)" >&2
    fi
}

if [ -n "$WITH_STACK" ]; then
    trap stack_down EXIT
    trap 'exit 130' INT TERM
    [ -f "$DEMO/up.sh" ] || { echo "run.sh: demo/eng-1799/up.sh does not exist yet" >&2; exit 1; }
    stack_down
    : >"$LOGDIR/up.log"
    echo "run.sh: starting the demo stack (log: tmp/demo-acceptance/up.log)"
    if ! bash "$DEMO/up.sh" >"$LOGDIR/up.log" 2>&1; then
        echo "run.sh: up.sh failed; last lines:" >&2
        tail -40 "$LOGDIR/up.log" >&2
        exit 1
    fi
    [ -f "$DEMO/.state/stack.json" ] || { echo "run.sh: up.sh wrote no .state/stack.json" >&2; exit 1; }
fi

# The demo package must exist and carry @playwright/test; --fail-if-no-match makes a missing package fail.
pnpm --silent --fail-if-no-match -F eng-1799-demo exec \
    playwright test --config acceptance/playwright.config.ts "acceptance/$SPEC" "$@"
