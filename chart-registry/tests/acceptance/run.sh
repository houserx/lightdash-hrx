#!/usr/bin/env bash
# Runs one chart-registry acceptance test file against a fresh build.
#   bash chart-registry/tests/acceptance/run.sh <file>.test.ts
#
# 1. builds the registry with `pnpm -F chart-registry build` (the package's
#    own build script; it must write the deployable site to chart-registry/dist/)
# 2. runs the test with the backend's vitest, so the tests can use the real
#    ChartRegistryClient, the real dist.tar validator and @lightdash/common.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
if [ ! -f chart-registry/package.json ]; then
  echo "chart-registry/package.json is missing: the registry package does not exist yet" >&2
  exit 1
fi
rm -rf chart-registry/dist
pnpm -F chart-registry build
if [ ! -f chart-registry/dist/index.json ]; then
  echo "pnpm -F chart-registry build did not write chart-registry/dist/index.json" >&2
  exit 1
fi
VITEST="$ROOT/packages/backend/node_modules/.bin/vitest"
exec "$VITEST" run --config "$ROOT/chart-registry/tests/acceptance/vitest.config.mjs" "$@"
