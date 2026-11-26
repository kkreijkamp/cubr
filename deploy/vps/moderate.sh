#!/bin/bash
# Moderation on cubr.dev (docs/SPEC.md "Moderation", decided 2026-11-26). Each command is one call to a
# service's /internal/moderation route, made from inside that service's container on the VM with the
# container's own internal token, over IAP SSH like deploy.sh (internal-call.sh). /internal is never
# routed publicly.
#
#   deploy/vps/moderate.sh show <username>                  the account: name, bio, picture, private, suspended
#   deploy/vps/moderate.sh suspend <username> [note]        every session ends, sign-in refused, profile private
#   deploy/vps/moderate.sh unsuspend <username>             it can sign in again (the profile stays private)
#   deploy/vps/moderate.sh rename <username> <new-username>
#   deploy/vps/moderate.sh clear-profile <username>         its display name and bio
#   deploy/vps/moderate.sh remove-picture <username>
#   deploy/vps/moderate.sh clear-chat <room-id>             a race room's chat, for everyone in it too
#   deploy/vps/moderate.sh log [n]                          the last n (50) actions, newest first: kept 2 years
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
  sed -n '7,14p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

cmd="${1:-}"
user="${2:-}"
if [ "$cmd" = log ]; then
  n="${2:-50}"
  [[ "$n" =~ ^[0-9]+$ ]] || usage
  call auth GET "/internal/moderation/log?limit=$n" | show
  exit
fi
[ -n "$cmd" ] && [ -n "$user" ] || usage
users=/internal/moderation/users
case "$cmd" in
  show) call auth GET "$users/$user" | show ;;
  suspend) call auth POST "$users/$user/suspend" "$(jq -nc --arg note "${3:-}" 'if $note == "" then {} else {note: $note} end')" | show ;;
  unsuspend) call auth POST "$users/$user/unsuspend" | show ;;
  rename)
    [ -n "${3:-}" ] || usage
    call auth POST "$users/$user/rename" "$(jq -nc --arg to "$3" '{to: $to}')" | show
    ;;
  clear-profile) call auth POST "$users/$user/clear-profile" | show ;;
  remove-picture) call auth POST "$users/$user/remove-picture" | show ;;
  clear-chat)
    call race POST "/internal/moderation/rooms/$user/clear-chat"
    # the race service keeps no records: the moderation log is auth's
    call auth POST /internal/moderation/log "$(jq -nc --arg room "$user" '{action: "clear-chat", detail: ("room " + $room)}')" >/dev/null
    ;;
  *) usage ;;
esac
