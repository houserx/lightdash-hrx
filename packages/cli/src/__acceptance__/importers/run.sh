#!/usr/bin/env bash
# bash packages/cli/src/__acceptance__/importers/run.sh <file.test.ts> [vitest args...]
# Runs one importers acceptance file. Each test spawns the real CLI from source
# (node --import tsx packages/cli/src/index.ts import ...), so no CLI build is needed; init.sh
# builds @lightdash/common, which the CLI loads.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/../../.." && pwd)"
FILE="$1"; shift
case "$FILE" in /*) ;; *) FILE="$HERE/$FILE" ;; esac
cd "$PKG"
export VITEST_MAX_THREADS="${VITEST_MAX_THREADS:-2}" VITEST_MAX_FORKS="${VITEST_MAX_FORKS:-2}"
exec pnpm exec vitest run --config src/__acceptance__/importers/vitest.config.ts "$FILE" "$@"
