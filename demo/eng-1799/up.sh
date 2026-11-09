#!/usr/bin/env bash
# ENG-1799 demo: bring the local demo stack up.
#
#   bash demo/eng-1799/up.sh
#
# Scenario timeline (seconds after the scenario clock starts, the "T" of the walkthrough):
#   DEMO_INCIDENT_AT   when the fill-queue incident begins (default 90, i.e. T+90s)
#   DEMO_RECOVERY_AT   when the incident recovers           (default 300, i.e. T+5min)
# Both must be whole numbers with 0 <= DEMO_INCIDENT_AT < DEMO_RECOVERY_AT. They are validated before
# anything starts; a bad value exits non-zero naming the variable.
#
# All state lives under demo/eng-1799/.state/. Stop everything with demo/eng-1799/down.sh.
set -euo pipefail

DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$DEMO/.state"

die() {
    echo "up.sh: $*" >&2
    exit 2
}

# ---------------------------------------------------------------- configuration (validated before anything starts)

DEMO_INCIDENT_AT="${DEMO_INCIDENT_AT:-90}"
DEMO_RECOVERY_AT="${DEMO_RECOVERY_AT:-300}"

require_seconds() {
    local name="$1" value="$2"
    [[ "$value" =~ ^[0-9]+$ ]] ||
        die "$name must be a whole number of seconds >= 0 after the scenario start (got '$value')"
    # Bound the length so the arithmetic below cannot overflow.
    [ "${#value}" -le 9 ] || die "$name is too large (got '$value'; at most 999999999 seconds)"
}

require_seconds DEMO_INCIDENT_AT "$DEMO_INCIDENT_AT"
require_seconds DEMO_RECOVERY_AT "$DEMO_RECOVERY_AT"
if (( 10#$DEMO_RECOVERY_AT <= 10#$DEMO_INCIDENT_AT )); then
    die "DEMO_RECOVERY_AT ($DEMO_RECOVERY_AT) must be later than DEMO_INCIDENT_AT ($DEMO_INCIDENT_AT)"
fi
DEMO_INCIDENT_AT=$((10#$DEMO_INCIDENT_AT))
DEMO_RECOVERY_AT=$((10#$DEMO_RECOVERY_AT))
export DEMO_INCIDENT_AT DEMO_RECOVERY_AT

echo "up.sh: scenario timeline: incident at T+${DEMO_INCIDENT_AT}s, recovery at T+${DEMO_RECOVERY_AT}s"

# ---------------------------------------------------------------- stack

mkdir -p "$STATE"

# The stack's services are added by later demo features (scenario clock, Platform Database, Federation Engine,
# telemetry fakes, Lightdash, telemetry-mcp). Until they exist there is nothing to start, so up.sh refuses
# rather than reporting a stack that is not there.
echo "up.sh: no stack services are implemented yet; nothing was started" >&2
exit 1
