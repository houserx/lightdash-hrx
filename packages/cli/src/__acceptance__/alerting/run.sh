#!/usr/bin/env bash
# bash packages/cli/src/__acceptance__/alerting/run.sh <file.accept.ts> [vitest args...]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/../../.." && pwd)"
FILE="$1"; shift
case "$FILE" in /*) ;; *) FILE="$HERE/$FILE" ;; esac
cd "$PKG"
exec pnpm exec vitest run --config src/__acceptance__/alerting/vitest.config.ts "$FILE" "$@"
