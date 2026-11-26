# shellcheck shell=bash
# Sourced by moderate.sh and dead-letters.sh, not run on its own.
#
# call SERVICE METHOD PATH [JSON]: one call to a service's /internal route, made from inside that
# service's container with the container's own internal token: on the VM over IAP SSH like deploy.sh,
# or on the local docker compose stack when LOCAL=1. /internal is never routed publicly.
# Settings (env): CUBR_VM (cubr-1), CUBR_ZONE (australia-southeast1-a), CUBR_GCLOUD_CONFIG (cubr).
VM="${CUBR_VM:-cubr-1}"
ZONE="${CUBR_ZONE:-australia-southeast1-a}"
CONF="${CUBR_GCLOUD_CONFIG:-cubr}"
COMPOSE='docker compose -f docker-compose.yml -f deploy/vps/compose.prod.yml'
LOCAL="${LOCAL:-0}"

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
