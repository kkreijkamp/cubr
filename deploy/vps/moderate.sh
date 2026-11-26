#!/bin/bash
# Moderation on cubr.dev (docs/SPEC.md "Moderation", decided 2026-11-26). Each command is one call to a
# service's /internal/moderation route, made from inside that service's container on the VM with the
# container's own internal token, over IAP SSH like deploy.sh. /internal is never routed publicly.
#
#   deploy/vps/moderate.sh show <username>                  the account: name, bio, picture, private, suspended
#   deploy/vps/moderate.sh suspend <username> [note]        every session ends, sign-in refused, profile private
#   deploy/vps/moderate.sh unsuspend <username>             it can sign in again (the profile stays private)
#   deploy/vps/moderate.sh rename <username> <new-username>
#   deploy/vps/moderate.sh clear-profile <username>         its display name and bio
#   deploy/vps/moderate.sh remove-picture <username>
#   deploy/vps/moderate.sh clear-chat <room-id>             a race room's chat, for everyone in it too
#
# --local first runs it on the local docker compose stack instead. Settings (env): CUBR_VM (cubr-1),
# CUBR_ZONE (australia-southeast1-a), CUBR_GCLOUD_CONFIG (cubr).
set -euo pipefail
cd "$(dirname "$0")/../.."

VM="${CUBR_VM:-cubr-1}"
ZONE="${CUBR_ZONE:-australia-southeast1-a}"
CONF="${CUBR_GCLOUD_CONFIG:-cubr}"
COMPOSE='docker compose -f docker-compose.yml -f deploy/vps/compose.prod.yml'
LOCAL=0
if [ "${1:-}" = "--local" ]; then LOCAL=1; shift; fi

usage() {
  sed -n '6,12p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# The call, as a small script for the container's own node, read from stdin (nothing to quote through
# SSH); its method, path and JSON body travel as base64 arguments.
JS='const [m, p, b] = process.argv.slice(2).map((a) => Buffer.from(a, "base64").toString());
fetch("http://127.0.0.1:8080" + p, { method: m, headers: { "x-internal-token": process.env.INTERNAL_API_TOKEN ?? "", ...(b ? { "content-type": "application/json" } : {}) }, body: b || undefined })
  .then(async (r) => { const t = await r.text(); console.log(r.status === 204 ? "done" : t || String(r.status)); process.exit(r.ok ? 0 : 1); })
  .catch((e) => { console.error(e.message); process.exit(1); });'

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

call() { # SERVICE METHOD PATH [JSON]
  local svc=$1 method=$2 path=$3 body=${4:-}
  local args
  args="$(b64 "$method") $(b64 "$path") $(b64 "$body")"
  if [ "$LOCAL" = 1 ]; then
    # shellcheck disable=SC2086
    printf '%s' "$JS" | docker compose exec -T "$svc" node - $args
  else
    printf '%s' "$JS" | gcloud compute ssh "$VM" --zone "$ZONE" --configuration "$CONF" --tunnel-through-iap --quiet \
      --command "cd /opt/cubr && $COMPOSE exec -T $svc node - $args" 2> >(grep -vE 'NumPy|increasing_the_tcp_upload_bandwidth|^$' >&2)
  fi
}

# the answer, readable (jq if it's there and the answer is JSON)
show() { if command -v jq >/dev/null; then jq . 2>/dev/null || cat; else cat; fi; }

cmd="${1:-}"
user="${2:-}"
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
  clear-chat) call race POST "/internal/moderation/rooms/$user/clear-chat" ;;
  *) usage ;;
esac
