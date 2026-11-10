#!/usr/bin/env bash
# ENG-1799 importers line: prepare the tree so any acceptance check can run.
#
# 1. pnpm install --frozen-lockfile (skipped when no manifest changed);
# 2. build formula, common, warehouses and visualization when their sources changed;
# 3. smoke-check that the CLI's dependencies load (the CLI itself runs from source under tsx).
#
# It never starts a server: the importers are CLI commands and every check spawns the CLI itself.
# Idempotent and fast when nothing changed: each step compares a content hash of its inputs with
# the stamp its last success left in tmp/init-stamps-importers/ (tmp/ is gitignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
STAMPS="$ROOT/tmp/init-stamps-importers"
mkdir -p "$STAMPS"
export CI=true
export HUSKY=0

log() { printf '[init] %s\n' "$*"; }

# Content hash of the files under the given paths, ignoring build output and acceptance tests
# (tests are not part of any package build). Deleted files change the hash too.
hash_inputs() {
    find "$@" -type f \
        -not -path '*/node_modules/*' \
        -not -path '*/dist/*' \
        -not -path '*/__acceptance__/*' \
        -not -name '*.tsbuildinfo' \
        -not -path 'packages/formula/src/grammar/parser.js' \
        -print0 2>/dev/null |
        LC_ALL=C sort -z |
        xargs -0 shasum -a 256 2>/dev/null |
        shasum -a 256 | cut -d' ' -f1
}

stamp_ok() { [ -f "$STAMPS/$1" ] && [ "$(cat "$STAMPS/$1")" = "$2" ]; }
stamp_set() { printf '%s' "$2" >"$STAMPS/$1"; }

# ------------------------------------------------------------------ install
manifests=(pnpm-lock.yaml pnpm-workspace.yaml package.json)
while IFS= read -r -d '' f; do manifests+=("$f"); done < <(
    find packages chart-registry -maxdepth 3 -name package.json -not -path '*/node_modules/*' -print0 2>/dev/null
)
install_hash="$(hash_inputs "${manifests[@]}")"
if stamp_ok install "$install_hash" && [ -d node_modules/.pnpm ]; then
    log "dependencies up to date"
else
    log "pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile >"$STAMPS/install.log" 2>&1 || {
        tail -60 "$STAMPS/install.log"
        exit 1
    }
    stamp_set install "$install_hash"
fi

# ------------------------------------------------------------------- builds
# Order matters: warehouses and visualization build against common's dist, so a common rebuild
# invalidates them (their stamp includes common's).
build_pkg() {
    local pkg="$1" upstream="${2:-}"
    local dir="packages/$pkg"
    local h
    h="$(hash_inputs "$dir/src" "$dir/package.json" "$dir"/tsconfig*.json)"
    if [ -n "$upstream" ]; then
        h="$h-$(cat "$STAMPS/build-$upstream" 2>/dev/null || echo none)"
    fi
    if stamp_ok "build-$pkg" "$h" && [ -d "$dir/dist" ]; then
        log "$pkg up to date"
        return
    fi
    log "building $pkg"
    pnpm -F "$pkg" build >"$STAMPS/build-$pkg.log" 2>&1 || {
        tail -60 "$STAMPS/build-$pkg.log"
        exit 1
    }
    stamp_set "build-$pkg" "$h"
}

build_pkg formula
build_pkg common formula
build_pkg warehouses common
build_pkg visualization common

# -------------------------------------------------------------- smoke check
# The checks spawn `node --import tsx packages/cli/src/index.ts ...`; that needs tsx and the
# built @lightdash/common to load.
(cd packages/cli && node -e "require('@lightdash/common'); require.resolve('tsx')") || {
    log "the CLI's dependencies do not load (see above)"
    exit 1
}

log "ready"
