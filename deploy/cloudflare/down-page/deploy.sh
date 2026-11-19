#!/bin/bash
# Puts cubr.dev's down page live, or takes it off: a Cloudflare Worker (worker.ts says what it does).
#   deploy/cloudflare/down-page/deploy.sh up       build and upload the Worker, then route cubr.dev through it
#   deploy/cloudflare/down-page/deploy.sh status   the Worker and the zone's Worker routes
#   deploy/cloudflare/down-page/deploy.sh down     delete its routes, so cubr.dev is served as before (the
#                                                  Worker stays uploaded, unused); `up` brings it back
# Uses the Cloudflare API token in the keychain (service cubr-cloudflare-api), which is never printed.
#
# Once, after the first `up`: in the dashboard (cubr.dev > Workers Routes), set the cubr.dev/* route's
# "Request limit failure mode" to "Fail open" (done 2026-11-19). The API shows it as the route's
# request_limit_fail_open, and `status` prints it, but the routes API doesn't document setting it.
# The free plan runs a Worker 100,000 times a day. Past that, a route that fails closed shows
# Cloudflare's error 1027 instead of the site, so a flood of page loads could take cubr.dev down until
# midnight UTC. Failing open, the requests skip the Worker and the site carries on. `up` never saves a
# route that's already right, so a redeploy keeps the setting.
set -euo pipefail
cd "$(dirname "$0")"

ZONE_NAME=cubr.dev
SCRIPT=cubr-down-page
COMPAT_DATE=2026-10-01
# cubr.dev/* runs the Worker. These skip it, as the most specific route wins: the API and the race
# sockets (nothing stands between the app and its data, and the server sees the visitor's own
# address), the hashed build files (Cloudflare's cache serves them) and the health check (the uptime
# check sees the server itself).
MAIN="$ZONE_NAME/*"
SKIP=("$ZONE_NAME/api/*" "$ZONE_NAME/socket.io/*" "$ZONE_NAME/assets/*" "$ZONE_NAME/healthz")

api() { # METHOD PATH [curl options]: Cloudflare's API, with the keychain token on stdin
  local method=$1 path=$2
  shift 2
  printf 'Authorization: Bearer %s\n' "$(security find-generic-password -s cubr-cloudflare-api -w)" |
    curl -sS -X "$method" -H @- "$@" "https://api.cloudflare.com/client/v4$path"
}
check() { # passes the API's answer on, or stops when it says no
  local res
  res=$(cat)
  if ! jq -e '.success' >/dev/null 2>&1 <<<"$res"; then
    echo "Cloudflare refused: $(jq -c '.errors' <<<"$res" 2>/dev/null || echo "$res")" >&2
    exit 1
  fi
  printf '%s' "$res"
}

zone=$(api GET "/zones?name=$ZONE_NAME" | check)
ZONE=$(jq -r '.result[0].id' <<<"$zone")
ACCOUNT=$(jq -r '.result[0].account.id' <<<"$zone")

route() { # PATTERN: the zone's route with exactly that pattern, as JSON, or nothing
  api GET "/zones/$ZONE/workers/routes" | check | jq -c --arg p "$1" '.result[] | select(.pattern == $p)'
}
route_id() { route "$1" | jq -r '.id // empty'; }

set_route() { # PATTERN [SCRIPT]: creates the route, or fixes its Worker; without a script, Workers skip the pattern
  local pattern=$1 script=${2:-} current body
  current=$(route "$pattern")
  # already right: left alone, so settings made in the dashboard (Fail open) stay
  if [ -n "$current" ] && [ "$(jq -r '.script // ""' <<<"$current")" = "$script" ]; then
    echo "route $pattern -> ${script:-(no Worker)} (unchanged)"
    return
  fi
  body=$(jq -nc --arg p "$pattern" --arg s "$script" '{pattern: $p} + (if $s == "" then {} else {script: $s} end)')
  if [ -n "$current" ]; then
    api PUT "/zones/$ZONE/workers/routes/$(jq -r '.id' <<<"$current")" -H 'Content-Type: application/json' --data "$body" | check >/dev/null
  else
    api POST "/zones/$ZONE/workers/routes" -H 'Content-Type: application/json' --data "$body" | check >/dev/null
  fi
  echo "route $pattern -> ${script:-(no Worker)}"
}

fail_open() { route "$MAIN" | jq -r '.request_limit_fail_open // false'; }

tmp=''
trap 'if [ -n "$tmp" ]; then rm -rf "$tmp"; fi' EXIT # at exit, when up() has returned: so not a local

up() {
  tmp=$(mktemp -d)
  (cd ../../.. && npx esbuild deploy/cloudflare/down-page/worker.ts --bundle --format=esm --platform=neutral \
    --target=es2022 --log-level=warning --outfile="$tmp/worker.js")
  jq -nc --arg d "$COMPAT_DATE" '{main_module: "worker.js", compatibility_date: $d}' >"$tmp/metadata.json"
  api PUT "/accounts/$ACCOUNT/workers/scripts/$SCRIPT" \
    -F "metadata=@$tmp/metadata.json;type=application/json" \
    -F "worker.js=@$tmp/worker.js;type=application/javascript+module" | check >/dev/null
  echo "uploaded $SCRIPT ($(wc -c <"$tmp/worker.js" | tr -d ' ') bytes)"
  # Only cubr.dev's routes may run it: no address on workers.dev (the account gets that subdomain
  # the first time its Workers page is opened in the dashboard)
  if api GET "/accounts/$ACCOUNT/workers/subdomain" | jq -e '.success' >/dev/null; then
    api POST "/accounts/$ACCOUNT/workers/scripts/$SCRIPT/subdomain" -H 'Content-Type: application/json' \
      --data '{"enabled":false,"previews_enabled":false}' | check >/dev/null
    echo "workers.dev address off"
  fi
  # the skips first, so the API never runs through the Worker, not even for a moment
  for p in "${SKIP[@]}"; do set_route "$p"; done
  set_route "$MAIN" "$SCRIPT"
  if [ "$(fail_open)" = true ]; then
    echo "live; the $MAIN route fails open"
  else
    echo "live. Now set the $MAIN route's request limit failure mode to Fail open in the dashboard (see the top of this file)."
  fi
}

down() {
  local p id
  # the Worker's own route first, so that no moment has it on the API
  for p in "$MAIN" "${SKIP[@]}"; do
    id=$(route_id "$p")
    [ -z "$id" ] && continue
    api DELETE "/zones/$ZONE/workers/routes/$id" | check >/dev/null
    echo "deleted route $p"
  done
}

status() {
  api GET "/zones/$ZONE/workers/routes" | check |
    jq -r '.result[] | "route \(.pattern) -> \(.script // "(no Worker)")\(if .script then (if .request_limit_fail_open then ", fails open" else ", FAILS CLOSED: set Fail open in the dashboard" end) else "" end)"'
  api GET "/accounts/$ACCOUNT/workers/scripts" | check |
    jq -r --arg s "$SCRIPT" 'if any(.result[]; .id == $s) then "worker \($s): uploaded" else "worker \($s): not uploaded" end'
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *)
    echo "usage: $0 up|status|down" >&2
    exit 2
    ;;
esac
