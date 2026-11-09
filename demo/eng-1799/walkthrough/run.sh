#!/usr/bin/env bash
# ENG-1799 demo: run recorded walkthrough scenes against the RUNNING demo stack (start it with up.sh first).
#
#   bash demo/eng-1799/walkthrough/run.sh [scene-id ...]       e.g. run.sh 01-sign-in 02-incident
#
# With no scene id it runs every scene spec in this directory (<scene-id>.spec.ts), in order. Each scene writes
# demo/eng-1799/out/scenes/<scene-id>/video.webm and key-moment.png (both 1920x1080). It never restarts the
# scenario clock. It stops at the first scene that fails and exits non-zero.
#
# Each scene runs Playwright in its own process group. On TERM, INT or HUP, and when a scene runs longer than
# DEMO_SCENE_TIMEOUT seconds (default 900), the whole group (Playwright, its driver, every chromium) gets TERM,
# then KILL after a short grace, so no browser survives the run.
set -euo pipefail

WALKTHROUGH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO="$(cd "$WALKTHROUGH/.." && pwd)"
SCENE_TIMEOUT="${DEMO_SCENE_TIMEOUT:-900}"
GRACE_SECONDS=5

log() { echo "walkthrough: $*"; }
die() {
    echo "walkthrough: $*" >&2
    exit 2
}

[[ "$SCENE_TIMEOUT" =~ ^[1-9][0-9]{0,5}$ ]] || die "DEMO_SCENE_TIMEOUT must be a whole number of seconds (got '$SCENE_TIMEOUT')"
[ -f "$DEMO/.state/stack.json" ] || die "the demo stack is not running (no .state/stack.json): run bash demo/eng-1799/up.sh first"
PLAYWRIGHT="$DEMO/node_modules/.bin/playwright"
[ -x "$PLAYWRIGHT" ] || die "Playwright is not installed in the demo package: run bash ./init.sh"

scenes=()
if [ "$#" -eq 0 ]; then
    for spec in "$WALKTHROUGH"/[0-9][0-9]-*.spec.ts; do
        [ -e "$spec" ] || continue
        scenes+=("$(basename "$spec" .spec.ts)")
    done
    [ "${#scenes[@]}" -gt 0 ] || die "no scene specs in $WALKTHROUGH"
else
    for id in "$@"; do
        [[ "$id" =~ ^[0-9][0-9]-[a-z0-9-]+$ ]] || die "not a scene id: '$id' (expected e.g. 01-sign-in)"
        [ -f "$WALKTHROUGH/$id.spec.ts" ] || die "no such scene: $id (no walkthrough/$id.spec.ts)"
        scenes+=("$id")
    done
fi

PGID=""       # process group of the running scene
WATCHDOG=""   # process group of its timeout watchdog

kill_group() {
    local pgid="$1"
    [ -n "$pgid" ] || return 0
    kill -TERM -- "-$pgid" 2>/dev/null || return 0
    local i
    for ((i = 0; i < GRACE_SECONDS * 10; i++)); do
        kill -0 -- "-$pgid" 2>/dev/null || return 0
        sleep 0.1
    done
    kill -KILL -- "-$pgid" 2>/dev/null || true
}

# Kill the watchdog's group and reap it quietly (bash would otherwise report the killed job on stderr).
stop_watchdog() {
    { kill -KILL -- "-$WATCHDOG" && wait "$WATCHDOG"; } 2>/dev/null || true
    WATCHDOG=""
}

cleanup() {
    if [ -n "$WATCHDOG" ]; then
        stop_watchdog
    fi
    if [ -n "$PGID" ]; then
        kill_group "$PGID"
        PGID=""
    fi
}

on_signal() {
    log "stopped by a signal; stopping the running scene and its browsers"
    cleanup
    exit 143
}
trap cleanup EXIT
trap on_signal TERM INT HUP

cd "$DEMO"
for id in "${scenes[@]}"; do
    log "scene $id"
    # Monitor mode only while starting the scene and its watchdog: each background job then leads its own process
    # group, and bash prints no job notices when they end.
    set -m
    "$PLAYWRIGHT" test --config walkthrough/playwright.config.ts "walkthrough/$id.spec.ts" &
    PGID=$!
    # The watchdog TERMs (then KILLs) the scene's group after SCENE_TIMEOUT seconds. Its own stderr is muted (bash
    # job notices when it is stopped); its message goes to the real stderr on fd 3.
    (
        sleep "$SCENE_TIMEOUT"
        echo "walkthrough: scene $id ran longer than ${SCENE_TIMEOUT}s; stopping it" >&3
        kill -TERM -- "-$PGID" || true
        sleep "$GRACE_SECONDS"
        kill -KILL -- "-$PGID" || true
    ) 3>&2 2>/dev/null &
    WATCHDOG=$!
    set +m

    status=0
    wait "$PGID" || status=$?
    stop_watchdog
    # Playwright has exited; reap anything it left in its group (a chromium it did not close).
    kill_group "$PGID"
    PGID=""

    if [ "$status" -ne 0 ]; then
        log "scene $id FAILED (exit $status)"
        exit 1
    fi
    for f in video.webm key-moment.png; do
        [ -s "$DEMO/out/scenes/$id/$f" ] || { log "scene $id wrote no out/scenes/$id/$f"; exit 1; }
    done
    log "scene $id ok: out/scenes/$id/video.webm, key-moment.png"
done
log "done: ${scenes[*]}"
