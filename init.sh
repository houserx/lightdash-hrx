#!/usr/bin/env bash
# ENG-1799 importers line: install and build what the importer checks need. No servers.
#
# The work is in scripts/eng-1799/init-importers.sh. The integration base's runner for every
# line's init (viz, ldq, mcp, alerting, engine) is kept as scripts/eng-1799/init-all.sh.
set -euo pipefail
cd "$(dirname "$0")"
bash scripts/eng-1799/init-importers.sh
echo "init.sh: ok"
