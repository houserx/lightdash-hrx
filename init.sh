#!/usr/bin/env bash
# ENG-1799 integration base: run every build line's init script, in order.
#
# Each line built in parallel with its own init.sh; they are kept as scripts/eng-1799/init-<line>.sh
# and run here from the repo root. Each one installs and builds only (no servers) and skips work
# whose inputs haven't changed, so a warm run is fast.
set -euo pipefail
cd "$(dirname "$0")"
for line in viz ldq mcp alerting engine; do
    script="scripts/eng-1799/init-$line.sh"
    [ -f "$script" ] || continue
    echo "init.sh: $line"
    bash "$script"
done
echo "init.sh: ok"
