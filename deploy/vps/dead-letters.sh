#!/bin/bash
# Dead letters on cubr.dev (docs/SPEC.md section 8): the events a service still couldn't handle a day
# after the first failure. List them, fix the cause, then put them back for that service alone. Each
# command is one call to the service's /internal/events route from inside its container (internal-call.sh).
#
#   deploy/vps/dead-letters.sh list <service>               its dead letters: leaderboard, stats or solve
#   deploy/vps/dead-letters.sh replay <service> [id...]     back on the event stream for it alone: all, or those
#
# --local first runs it on the local docker compose stack instead. Settings (env): CUBR_VM (cubr-1),
# CUBR_ZONE (australia-southeast1-a), CUBR_GCLOUD_CONFIG (cubr).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOCAL=0
if [ "${1:-}" = "--local" ]; then LOCAL=1; shift; fi
# shellcheck source-path=SCRIPTDIR source=internal-call.sh
. "$HERE/internal-call.sh"
cd "$HERE/../.."

usage() {
  sed -n '6,7p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

cmd="${1:-}"
svc="${2:-}"
case "$svc" in leaderboard | stats | solve) ;; *) usage ;; esac
case "$cmd" in
  list) call "$svc" GET /internal/events/dead-letters | show ;;
  replay)
    shift 2
    body='{}'
    if [ $# -gt 0 ]; then body="$(jq -nc '{ids: $ARGS.positional}' --args "$@")"; fi
    call "$svc" POST /internal/events/dead-letters/replay "$body" | show
    ;;
  *) usage ;;
esac
