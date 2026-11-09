#!/usr/bin/env bash
# bash packages/common/src/__acceptance__/importers/run.sh <file.test.ts> [vitest args...]
# Runs one importers acceptance file for @lightdash/common (pure conversion logic, no network).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/../../.." && pwd)"
FILE="$1"; shift
case "$FILE" in /*) ;; *) FILE="$HERE/$FILE" ;; esac
cd "$PKG"
export VITEST_MAX_THREADS="${VITEST_MAX_THREADS:-2}" VITEST_MAX_FORKS="${VITEST_MAX_FORKS:-2}"
exec pnpm exec vitest run --config src/__acceptance__/importers/vitest.config.ts "$FILE" "$@"
