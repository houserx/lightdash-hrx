#!/usr/bin/env bash
# Build-line init for the `alerting` line (ENG-1799).
#
# Installs dependencies and builds the workspace packages that other packages
# import from `dist/` (formula -> common -> warehouses, visualization). It never starts a
# server: every acceptance check starts what it needs (throwaway Postgres,
# mock HTTP servers on 127.0.0.1:0) and stops it itself.
#
# Idempotent and fast when nothing changed: the install is skipped when the
# lockfile and package manifests are unchanged, and each build is skipped
# when no source file is newer than its last successful build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
mkdir -p tmp

export CI=true
export HUSKY=0

manifest_hash() {
    cat pnpm-lock.yaml package.json pnpm-workspace.yaml packages/*/package.json 2>/dev/null |
        shasum -a 256 | cut -c1-40
}

HASH_FILE=tmp/.init-install-hash
want="$(manifest_hash)"
have="$(cat "$HASH_FILE" 2>/dev/null || true)"
if [ ! -d node_modules ] || [ ! -d packages/backend/node_modules ] || [ "$want" != "$have" ]; then
    echo "init: pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile
    echo "$want" >"$HASH_FILE"
else
    echo "init: dependencies up to date"
fi

# build <package> <stamp> <source dirs...>
build_if_changed() {
    local pkg="$1" stamp="tmp/.init-build-$1" changed=""
    shift
    if [ ! -f "$stamp" ]; then
        changed=yes
    else
        for dir in "$@"; do
            if [ -e "$dir" ] && [ -n "$(find "$dir" -newer "$stamp" -type f \
                -not -path '*/node_modules/*' -not -path '*/dist/*' -print -quit)" ]; then
                changed=yes
                break
            fi
        done
    fi
    if [ -n "$changed" ]; then
        echo "init: building $pkg"
        pnpm -F "$pkg" build
        touch "$stamp"
    else
        echo "init: $pkg build up to date"
    fi
}

build_if_changed formula packages/formula/src packages/formula/package.json
build_if_changed common packages/common/src packages/common/package.json packages/common/tsconfig.json
build_if_changed warehouses packages/warehouses/src packages/warehouses/package.json
# The frontend imports @lightdash/visualization from its build output.
build_if_changed visualization packages/visualization/src packages/visualization/package.json

echo "init: ok"
