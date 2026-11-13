#!/usr/bin/env bash
# Build line `mcp` (ENG-1799 telemetry MCP server): install and build. Runs before every check.
#
# Line rules: this script installs and builds only. It never starts a server; acceptance tests start
# whatever they need (fake Okta, fake Lightdash, fake engine, the MCP server) on ephemeral ports and
# stop it themselves. It must pass on a tree where packages/telemetry-mcp has no package.json yet.
set -euo pipefail
cd "$(dirname "$0")"

# 1. Dependencies. Warm runs take ~1 s. A stale lockfile fails here, by design.
pnpm install --frozen-lockfile

# 2. Build the package if it exists, skipping the build when nothing it depends on has changed.
PKG=packages/telemetry-mcp
if [ -f "$PKG/package.json" ]; then
    STAMP="$PKG/dist/.init-build-stamp"
    if [ ! -f "$STAMP" ] || [ -n "$(find "$PKG/src" "$PKG/package.json" "$PKG"/tsconfig*.json pnpm-lock.yaml \
        -newer "$STAMP" -print -quit 2>/dev/null)" ]; then
        pnpm --fail-if-no-match -F @lightdash/telemetry-mcp build
        mkdir -p "$PKG/dist"
        touch "$STAMP"
    fi
fi
echo "init.sh: ok"
