#!/usr/bin/env bash
# ENG-1799 viz line: prepare the tree for the acceptance checks.
#
# Installs dependencies and builds the packages other packages consume from
# dist/ (formula, common, warehouses, visualization) when their inputs
# changed. It never starts a server: every check starts what it needs on an
# ephemeral port and stops it itself (specs/goal-common.md).
#
# Idempotent and fast when nothing changed: each step is skipped when a
# content hash of its inputs matches the stamp left by its last success
# (stamps live in tmp/init-stamps/, which is gitignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
STAMPS="$ROOT/tmp/init-stamps"
mkdir -p "$STAMPS"

log() { printf '[init] %s\n' "$*"; }

# Hash of the files under the given paths (tracked or not), ignoring build
# output and generated files. Deleted files change the hash too.
hash_inputs() {
    find "$@" -type f \
        -not -path '*/node_modules/*' \
        -not -path '*/dist/*' \
        -not -name '*.tsbuildinfo' \
        -not -path 'packages/formula/src/grammar/parser.js' \
        -print0 2>/dev/null |
        LC_ALL=C sort -z |
        xargs -0 shasum -a 256 2>/dev/null |
        shasum -a 256 | cut -d' ' -f1
}

stamp_ok() { [ -f "$STAMPS/$1" ] && [ "$(cat "$STAMPS/$1")" = "$2" ]; }
stamp_set() { printf '%s' "$2" >"$STAMPS/$1"; }

# ------------------------------------------------------------- install
manifests=(pnpm-lock.yaml pnpm-workspace.yaml package.json)
while IFS= read -r -d '' f; do manifests+=("$f"); done < <(
    find packages chart-registry -maxdepth 3 -name package.json \
        -not -path '*/node_modules/*' -print0 2>/dev/null
)
install_hash="$(hash_inputs "${manifests[@]}")"
if stamp_ok install "$install_hash" && [ -d node_modules/.pnpm ]; then
    log "dependencies up to date"
else
    log "pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile
    stamp_set install "$install_hash"
fi

# --------------------------------------------------------------- builds
# Order matters: warehouses and visualization build against common's dist,
# so a common rebuild invalidates them (their stamp includes common's).
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
    pnpm -F "$pkg" build
    stamp_set "build-$pkg" "$h"
}

build_pkg formula
build_pkg common
build_pkg warehouses common
build_pkg visualization common

log "ready"
