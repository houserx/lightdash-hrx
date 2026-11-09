#!/usr/bin/env bash
# Build-line init for the `demo` line (ENG-1799 end-to-end demo, demo/eng-1799/).
#
# Runs last from the root init.sh, after the other lines have installed dependencies (the mcp line's
# init runs `pnpm install --frozen-lockfile` every time, which covers the eng-1799-demo package), built
# formula/common/warehouses/visualization, the telemetry-mcp dist and the engine (debug).
#
# This script only checks prerequisites and builds what the demo stack needs. It NEVER starts a server:
# demo/eng-1799/up.sh starts the stack, and every acceptance check that brings it up also brings it down.
#
# Idempotent and fast when nothing changed: each build is skipped when no input is newer than its stamp.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
STAMPS="$ROOT/tmp/.demo-init"
mkdir -p "$STAMPS"
log() { printf '[init-demo] %s\n' "$*"; }

# changed_since <stamp> <paths...>: true when there is no stamp or any input file is newer than it.
changed_since() {
    local stamp="$1"
    shift
    [ -f "$stamp" ] || return 0
    [ -n "$(find "$@" -newer "$stamp" -type f \
        -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/build/*' \
        -not -path '*/__acceptance__/*' -not -name '*.test.ts' -not -name '*.test.tsx' \
        -print -quit 2>/dev/null)" ]
}

# 1. Machine prerequisites the stack uses (no Docker, no network at run time).
for bin in initdb pg_ctl postgres; do
    [ -x "/opt/homebrew/bin/$bin" ] || { log "missing /opt/homebrew/bin/$bin (the demo's throwaway Postgres clusters need it)"; exit 1; }
done

# 2. The demo package is installed: Playwright's browser and ffmpeg-static's binary are present.
if [ -f demo/eng-1799/package.json ]; then
    if ! (cd demo/eng-1799 && node -e 'const p=require("ffmpeg-static"); require("fs").accessSync(p, require("fs").constants.X_OK)') 2>/dev/null; then
        log "ffmpeg-static has no binary; re-running its install script"
        pnpm rebuild ffmpeg-static >"$STAMPS/ffmpeg-rebuild.log" 2>&1 || { tail -20 "$STAMPS/ffmpeg-rebuild.log"; exit 1; }
    fi
    if ! (cd demo/eng-1799 && node -e 'const fs=require("fs"); const p=require("@playwright/test").chromium.executablePath(); fs.accessSync(p)') 2>/dev/null; then
        log "installing Playwright's chromium for @playwright/test (one-time download)"
        pnpm --fail-if-no-match -F eng-1799-demo exec playwright install chromium >"$STAMPS/playwright-install.log" 2>&1 || {
            tail -20 "$STAMPS/playwright-install.log"
            exit 1
        }
    fi
    log "demo package ready (ffmpeg-static, chromium)"
fi

# 3. Frontend production build (served by the Lightdash backend from packages/frontend/build).
#    Rebuilt only when frontend or the packages it bundles changed. Cold: several minutes.
FRONTEND_INPUTS=(packages/frontend/src packages/frontend/index.html packages/frontend/package.json
    packages/frontend/vite.config.ts packages/frontend/public
    packages/common/src packages/visualization/src packages/formula/src)
if changed_since "$STAMPS/frontend-build" "${FRONTEND_INPUTS[@]}" || [ ! -f packages/frontend/build/index.html ]; then
    log "building the frontend (vite production build; log: tmp/.demo-init/frontend-build.log)"
    touch "$STAMPS/frontend-build.next"
    if NODE_OPTIONS="--max-old-space-size=8192" pnpm -F frontend build >"$STAMPS/frontend-build.log" 2>&1; then
        mv "$STAMPS/frontend-build.next" "$STAMPS/frontend-build"
    else
        rm -f "$STAMPS/frontend-build.next"
        tail -40 "$STAMPS/frontend-build.log"
        exit 1
    fi
else
    log "frontend build up to date"
fi

# 4. The Federation Engine binary the stack runs (built by init-engine.sh; debug is fine for the demo).
[ -x federation-engine/target/debug/engine ] || [ -x federation-engine/target/release/engine ] || {
    log "no federation-engine binary (init-engine.sh should have built it)"
    exit 1
}

# 5. telemetry-mcp dist (built by init-mcp.sh).
[ -f packages/telemetry-mcp/dist/main.js ] || { log "packages/telemetry-mcp/dist/main.js is missing"; exit 1; }

log "ready"
