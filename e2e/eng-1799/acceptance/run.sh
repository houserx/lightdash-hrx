#!/usr/bin/env bash
# ENG-1799 integration line: run ONE e2e acceptance file.
#
#   bash e2e/eng-1799/acceptance/run.sh <file.test.ts> [extra vitest args]
#
# Run from the repo root after `bash ./init.sh`. It makes sure the Federation Engine binary is
# current (an incremental `cargo build`, a no-op when nothing changed: the build is cached in
# tmp/cargo-target), then runs the file with vitest under acceptance/vitest.config.ts. The test
# starts everything it needs (engine, fakes, throwaway Postgres, Lightdash) on ephemeral ports
# and stops it. Exits non-zero unless every test in the file passes.
set -euo pipefail

if [ $# -lt 1 ]; then
    echo "usage: $0 <file.test.ts> [vitest args]" >&2
    exit 2
fi
FILE="$1"
shift

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
case "$FILE" in
    */*) ;;
    *) FILE="e2e/eng-1799/acceptance/$FILE" ;;
esac
if [ ! -f "$FILE" ]; then
    echo "run.sh: no such acceptance file: $FILE" >&2
    exit 2
fi
REL="${FILE#e2e/eng-1799/}"

export CARGO_TARGET_DIR="$ROOT/tmp/cargo-target"
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
cargo build --quiet --manifest-path federation-engine/Cargo.toml --bin engine
export E2E_ENGINE_BINARY="$CARGO_TARGET_DIR/debug/engine"
export E2E_REPO_ROOT="$ROOT"
export TZ=UTC

mkdir -p "$ROOT/tmp/e2e"
export VITEST_MAX_THREADS=2
export VITEST_MAX_FORKS=2
exec pnpm --fail-if-no-match -F @lightdash/e2e-eng-1799 exec \
    vitest run --config acceptance/vitest.config.ts "$REL" "$@"
