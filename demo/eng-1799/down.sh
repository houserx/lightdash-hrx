#!/usr/bin/env bash
# ENG-1799 demo: stop everything demo/eng-1799/up.sh started.
#
#   bash demo/eng-1799/down.sh
#
# Idempotent: exits 0 when nothing is running. It stops
#   1. every Postgres cluster under .state/ (pg_ctl stop -m fast),
#   2. every process (and its process group) listed in .state/stack.json "processes",
#   3. any leftover process whose command line mentions the .state directory,
# TERM first, KILL after a grace period. It keeps .state/ itself (logs, configs) for debugging;
# stack.json is removed so a later up.sh never mistakes a dead stack for a live one.
set -euo pipefail

DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$DEMO/.state"
STACK_JSON="$STATE/stack.json"
GRACE_SECONDS="${DEMO_DOWN_GRACE_SECONDS:-10}"

log() { echo "down.sh: $*"; }

if [ ! -d "$STATE" ]; then
    log "nothing to stop (no $STATE)"
    exit 0
fi

# ---------------------------------------------------------------- Postgres clusters

PG_CTL="$(command -v pg_ctl || true)"
[ -n "$PG_CTL" ] || [ ! -x /opt/homebrew/bin/pg_ctl ] || PG_CTL=/opt/homebrew/bin/pg_ctl
while IFS= read -r pidfile; do
    datadir="$(dirname "$pidfile")"
    if [ -n "$PG_CTL" ]; then
        log "stopping Postgres in ${datadir#"$DEMO"/}"
        "$PG_CTL" -D "$datadir" -m fast -w -t "$GRACE_SECONDS" stop >/dev/null 2>&1 || true
    fi
done < <(find "$STATE" -name postmaster.pid -type f 2>/dev/null)

# ---------------------------------------------------------------- recorded processes and leftovers

alive() { kill -0 "$1" 2>/dev/null; }

# Pids recorded in stack.json ("pid": <n>), without needing jq or node.
recorded_pids() {
    [ -f "$STACK_JSON" ] || return 0
    grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$STACK_JSON" | grep -oE '[0-9]+$' || true
}

# Pids whose command line mentions the state directory.
state_pids() {
    pgrep -f "$STATE" 2>/dev/null | grep -vx "$$" || true
}

signal_all() {
    local sig="$1" pid
    for pid in $(recorded_pids); do
        # Each service runs in its own process group led by the recorded pid; signal the group, then the pid.
        kill "-$sig" -- "-$pid" 2>/dev/null || true
        kill "-$sig" "$pid" 2>/dev/null || true
    done
    for pid in $(state_pids); do
        kill "-$sig" "$pid" 2>/dev/null || true
    done
}

any_alive() {
    local pid
    for pid in $(recorded_pids) $(state_pids); do
        if alive "$pid"; then return 0; fi
    done
    return 1
}

if any_alive; then
    log "stopping demo processes"
    signal_all TERM
    deadline=$((SECONDS + GRACE_SECONDS))
    while any_alive && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.5; done
    if any_alive; then
        log "killing processes still running after ${GRACE_SECONDS}s"
        signal_all KILL
        sleep 1
    fi
fi

if any_alive; then
    log "some demo processes are still running:" >&2
    pgrep -lf "$STATE" >&2 || true
    exit 1
fi

rm -f "$STACK_JSON"
log "stopped"
