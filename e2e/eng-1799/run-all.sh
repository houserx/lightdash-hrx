#!/usr/bin/env bash
# ENG-1799 integration line: run the whole e2e suite, one acceptance file at a time.
#
#   bash e2e/eng-1799/run-all.sh                 # every e2e/eng-1799/acceptance/*.test.ts
#   bash e2e/eng-1799/run-all.sh int-write-      # only the files whose name starts with a prefix
#
# Run from anywhere after `bash ./init.sh`. Each file goes through the protected runner
# e2e/eng-1799/acceptance/run.sh, which starts everything the check needs on ephemeral ports and
# stops it again, so files never share a server. The suite keeps going after a failure, prints a
# summary and exits non-zero if any file failed. See docs/eng-1799/integration.md.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
RUNNER="e2e/eng-1799/acceptance/run.sh"
PREFIX="${1:-}"

files=()
for f in e2e/eng-1799/acceptance/*.test.ts; do
    name="$(basename "$f")"
    case "$name" in
        "$PREFIX"*) files+=("$name") ;;
    esac
done
if [ ${#files[@]} -eq 0 ]; then
    echo "run-all.sh: no acceptance file matches '${PREFIX}'" >&2
    exit 2
fi

passed=()
failed=()
started=$SECONDS
for name in "${files[@]}"; do
    echo "=== ${name%.test.ts}"
    if bash "$RUNNER" "$name"; then
        passed+=("${name%.test.ts}")
    else
        failed+=("${name%.test.ts}")
    fi
done

echo
echo "run-all.sh: ${#passed[@]} passed, ${#failed[@]} failed, $((SECONDS - started)) s"
for id in ${failed[@]+"${failed[@]}"}; do
    echo "  FAILED $id"
done
[ ${#failed[@]} -eq 0 ]
