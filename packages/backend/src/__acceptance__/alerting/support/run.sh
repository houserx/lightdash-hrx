#!/usr/bin/env bash
# Runs one alerting backend acceptance file against a throwaway Postgres.
#
#   bash packages/backend/src/__acceptance__/alerting/support/run.sh <file.accept.ts> [vitest args...]
#
# The cluster's data directory lives in <repo>/tmp/alerting-pg (gitignored) and
# is kept between runs, so the migrated template database that
# `createMigratedDatabase` builds (keyed by a fingerprint of the migration
# files) is reused: warm runs skip migrations. The server itself is started on
# a free 127.0.0.1 port for this run only and is always stopped before exit.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCEPT_DIR="$(dirname "$HERE")"
BACKEND="$(cd "$ACCEPT_DIR/../../.." && pwd)"
ROOT="$(cd "$BACKEND/../.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/bin}"

if [ $# -lt 1 ]; then
    echo "usage: run.sh <file.accept.ts> [vitest args...]" >&2
    exit 2
fi
FILE="$1"
shift
case "$FILE" in
    /*) ;;
    */*) FILE="$ROOT/$FILE" ;;
    *) FILE="$ACCEPT_DIR/$FILE" ;;
esac

STATE="$ROOT/tmp/alerting-pg"
DATA="$STATE/data"
LOCK="$STATE/lock"
mkdir -p "$STATE"

# One run at a time per clone: the data directory is shared.
waited=0
until mkdir "$LOCK" 2>/dev/null; do
    holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
        rm -rf "$LOCK"
        continue
    fi
    if [ "$waited" -ge 600 ]; then
        echo "run.sh: timed out waiting for $LOCK" >&2
        exit 1
    fi
    sleep 1
    waited=$((waited + 1))
done
echo $$ >"$LOCK/pid"

STARTED=""
cleanup() {
    if [ -n "$STARTED" ]; then
        "$PGBIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null 2>&1 || true
    fi
    rm -rf "$LOCK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# A server left behind by a killed run would keep the data dir busy.
if [ -f "$DATA/postmaster.pid" ]; then
    "$PGBIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null 2>&1 || rm -f "$DATA/postmaster.pid"
fi

if [ ! -f "$DATA/PG_VERSION" ]; then
    rm -rf "$DATA"
    "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=C >"$STATE/initdb.log" 2>&1
fi

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
STARTED=yes
"$PGBIN/pg_ctl" -D "$DATA" -l "$STATE/server.log" -w -t 60 \
    -o "-c listen_addresses=127.0.0.1 -c port=$PORT -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200" \
    start >/dev/null

export PGHOST=127.0.0.1
export PGPORT="$PORT"
export PGUSER=postgres
export PGPASSWORD=
export PGADMINDATABASE=postgres
# Core migrations only: the enterprise ones need pgvector, which this
# Postgres doesn't ship. Alerting tables are core migrations.
export LIGHTDASH_LICENSE_KEY=

cd "$BACKEND"
set +e
pnpm exec vitest run --config src/__acceptance__/alerting/vitest.config.ts "$FILE" "$@"
status=$?
set -e
exit $status
