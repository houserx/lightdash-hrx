#!/usr/bin/env bash
# ENG-1799 integration line: install and build everything the e2e checks need. Starts no server.
#
#   1. Reap leftovers of e2e checks that were killed mid-run (engine processes and throwaway
#      Postgres clusters under tmp/e2e older than 30 minutes).
#   2. Node: `pnpm install --frozen-lockfile`, then build the TypeScript packages other packages
#      import from dist (formula, common, warehouses, visualization), regenerate the backend TSOA
#      routes, and build @lightdash/telemetry-mcp. These steps reuse the build lines' own scripts
#      (scripts/eng-1799/init-ldq.sh and init-mcp.sh); each skips work whose inputs are unchanged.
#   3. Rust: `cargo build` of the Federation Engine `engine` binary (incremental) into
#      tmp/cargo-target, with debug info off to keep it small.
#   4. Demo: scripts/eng-1799/init-demo.sh (frontend production build, ffmpeg-static and chromium
#      present, engine and telemetry-mcp built).
#
# Idempotent; a warm run takes a few seconds. Every check starts what it needs on ephemeral
# ports (see e2e/eng-1799/acceptance/run.sh) and stops it itself.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
mkdir -p "$ROOT/tmp"
export HUSKY=0

# 1. Leftovers of killed checks.
E2E_TMP="$ROOT/tmp/e2e"
if [ -d "$E2E_TMP" ]; then
    while IFS= read -r -d '' dir; do
        if [ -f "$dir/pgdata/postmaster.pid" ] && [ -x /opt/homebrew/bin/pg_ctl ]; then
            /opt/homebrew/bin/pg_ctl -D "$dir/pgdata" -m immediate -w stop >/dev/null 2>&1 || true
        fi
        if [ -f "$dir/federation-engine.toml" ]; then
            pkill -KILL -f -- "--config $dir/federation-engine.toml" >/dev/null 2>&1 || true
        fi
        rm -rf "$dir"
    done < <(find "$E2E_TMP" -mindepth 1 -maxdepth 1 -type d -mmin +30 -print0)
fi

# 2. Node packages.
echo "init.sh: node packages"
bash scripts/eng-1799/init-ldq.sh
bash scripts/eng-1799/init-mcp.sh

# 3. The Federation Engine binary.
if ! command -v cargo >/dev/null 2>&1; then
    echo "init.sh: cargo is not on PATH (expected ~/.cargo/bin/cargo)" >&2
    exit 1
fi
export CARGO_TARGET_DIR="$ROOT/tmp/cargo-target"
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
echo "init.sh: cargo build (engine) into tmp/cargo-target"
cargo build --quiet --manifest-path federation-engine/Cargo.toml --bin engine

for bin in initdb pg_ctl postgres; do
    if [ ! -x "/opt/homebrew/bin/$bin" ]; then
        echo "init.sh: missing /opt/homebrew/bin/$bin (the Platform Database and Lightdash checks need it)" >&2
        exit 1
    fi
done

# 4. The demo line.
echo "init.sh: demo"
bash scripts/eng-1799/init-demo.sh

echo "init.sh: ok"
