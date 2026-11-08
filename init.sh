#!/usr/bin/env bash
# init.sh — build line `engine` (ENG-1799 Federation Engine, `federation-engine/`).
#
# Installs and builds only. It never starts a long-lived server: every acceptance test starts the
# `engine` binary, its mocks and any throwaway Postgres on ephemeral 127.0.0.1 ports itself, and
# stops them. It never touches the Node packages (no pnpm install on this line).
#
# Idempotent and fast when nothing changed (a no-op cargo build). Runs before every check.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
MANIFEST="$ROOT/federation-engine/Cargo.toml"
export CARGO_TARGET_DIR="$ROOT/federation-engine/target"

# 1. Reap leftovers of checks that were killed mid-run (their Drop guards never ran): throwaway
#    Postgres clusters and engine processes under tmp/acceptance older than 20 minutes.
TMP_ACCEPTANCE="$ROOT/tmp/acceptance"
if [ -d "$TMP_ACCEPTANCE" ]; then
  while IFS= read -r -d '' dir; do
    if [ -f "$dir/data/postmaster.pid" ] && [ -x /opt/homebrew/bin/pg_ctl ]; then
      /opt/homebrew/bin/pg_ctl -D "$dir/data" -m immediate -w stop >/dev/null 2>&1 || true
    fi
    if [ -f "$dir/federation-engine.toml" ]; then
      pkill -KILL -f -- "--config $dir/federation-engine.toml" >/dev/null 2>&1 || true
    fi
    rm -rf "$dir"
  done < <(find "$TMP_ACCEPTANCE" -mindepth 1 -maxdepth 1 -type d -mmin +20 -print0)
fi
mkdir -p "$ROOT/tmp"

# 2. Toolchain and machine prerequisites.
if ! command -v cargo >/dev/null 2>&1; then
  echo "init.sh: cargo is not on PATH (expected ~/.cargo/bin/cargo)" >&2
  exit 1
fi
for bin in initdb pg_ctl postgres; do
  if [ ! -x "/opt/homebrew/bin/$bin" ]; then
    echo "init.sh: warning: /opt/homebrew/bin/$bin is missing; Platform Database checks will fail" >&2
  fi
done

# 3. Build everything the checks run: the `engine` binary and the acceptance test binary (debug).
cargo build --manifest-path "$MANIFEST" --all-targets

echo "init.sh: federation-engine built (debug) in federation-engine/target"
