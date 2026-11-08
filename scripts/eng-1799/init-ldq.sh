#!/usr/bin/env bash
# Line ldq: prepare the tree so any acceptance check can run. Idempotent and fast when warm.
#
# It installs dependencies and builds what the tests import. It starts no servers: every check
# starts what it needs (throwaway Postgres in tmp/, fake engine HTTP servers on 127.0.0.1:0)
# and stops it itself, because several build lines share this machine.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
STAMPS="$ROOT/tmp/.ldq-init"
mkdir -p "$STAMPS"

log() { printf '[init] %s\n' "$*"; }

# Has anything under the given paths changed since the stamp? (true when there is no stamp)
changed_since() {
    local stamp="$1"
    shift
    [ -f "$stamp" ] || return 0
    [ -n "$(find "$@" -newer "$stamp" \( -name '*.ts' -o -name '*.tsx' -o -name '*.json' \) \
        -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/generated/*' -not -path '*/__acceptance__/*' \
        -print -quit 2>/dev/null)" ]
}

# 1. Dependencies. pnpm is near-instant when the store and node_modules are current.
if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt "$STAMPS/install" ] || \
    [ -n "$(find package.json packages/*/package.json -newer "$STAMPS/install" -print -quit 2>/dev/null)" ]; then
    log "pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile --prefer-offline >"$STAMPS/install.log" 2>&1 || {
        tail -40 "$STAMPS/install.log"
        exit 1
    }
    touch "$STAMPS/install"
else
    log "dependencies up to date"
fi

# 2. Packages whose built output other packages import: the frontend tests and the CLI build
#    use common's dist, and the backend and frontend typechecks resolve formula and
#    visualization from their dist. tsc --build is incremental; we skip it entirely when no
#    source changed since the last successful build.
build_package() {
    local name="$1" built="$2"
    shift 2
    if changed_since "$STAMPS/build-$name" "$@" || [ ! -f "$built" ]; then
        log "building $name"
        touch "$STAMPS/build-$name.next"
        pnpm -F "$name" build >"$STAMPS/build-$name.log" 2>&1 || {
            tail -40 "$STAMPS/build-$name.log"
            exit 1
        }
        mv "$STAMPS/build-$name.next" "$STAMPS/build-$name"
    else
        log "$name build up to date"
    fi
}

build_package common packages/common/dist/cjs/index.js \
    packages/common/src packages/common/package.json
build_package warehouses packages/warehouses/dist/index.js \
    packages/warehouses/src packages/common/src
build_package formula packages/formula/dist/index.js \
    packages/formula/src packages/formula/package.json
build_package visualization packages/visualization/dist/cjs/index.js \
    packages/visualization/src packages/common/src

# 3. TSOA routes: the backend route checks drive src/generated/routes.ts, so it must include
#    new controllers. Regenerated (and formatted, so an unchanged API leaves no diff) whenever
#    backend or common sources change.
if changed_since "$STAMPS/generate-api" packages/backend/src packages/common/src || \
    [ ! -f packages/backend/src/generated/routes.ts ]; then
    log "generating backend API routes"
    touch "$STAMPS/generate-api.next"
    if pnpm -F backend generate-api:build >"$STAMPS/generate-api.log" 2>&1; then
        mv "$STAMPS/generate-api.next" "$STAMPS/generate-api"
    else
        # Not fatal: only the route checks need fresh routes, and they will fail on their own.
        log "WARNING: route generation failed (see tmp/.ldq-init/generate-api.log); will retry next run"
        tail -20 "$STAMPS/generate-api.log"
        rm -f "$STAMPS/generate-api.next"
    fi
else
    log "backend API routes up to date"
fi

# 4. Throwaway Postgres binaries used by the real-database checks.
for binary in initdb pg_ctl postgres; do
    if [ ! -x "${LDQ_PG_BIN:-/opt/homebrew/bin}/$binary" ]; then
        log "missing ${LDQ_PG_BIN:-/opt/homebrew/bin}/$binary (needed by the Postgres-backed checks)"
        exit 1
    fi
done

log "ready"
