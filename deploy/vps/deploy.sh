#!/bin/bash
# Deploys cubr to the production VM over IAP SSH (no public SSH port needed).
#   deploy/vps/deploy.sh init        once: create /opt/cubr/.env with fresh random secrets
#   deploy/vps/deploy.sh [version]   copy the compose files + gateway config to /opt/cubr, pull
#                                    the images for that version (default: the repo's current
#                                    version, scripts/bump-version.sh --current) from Artifact
#                                    Registry, then set CUBR_VERSION and (re)start the stack
# Images for a version are built and pushed first with:
#   gcloud builds submit --config=cloudbuild.yaml --ignore-file=.dockerignore --region=australia-southeast1 .
# Settings (env): CUBR_VM (cubr-1), CUBR_ZONE (australia-southeast1-a), CUBR_GCLOUD_CONFIG (cubr).
set -euo pipefail
cd "$(dirname "$0")/../.."

VM="${CUBR_VM:-cubr-1}"
ZONE="${CUBR_ZONE:-australia-southeast1-a}"
CONF="${CUBR_GCLOUD_CONFIG:-cubr}"
REGISTRY_HOST=australia-southeast1-docker.pkg.dev
COMPOSE='docker compose -f docker-compose.yml -f deploy/vps/compose.prod.yml'

on_vm() {
  gcloud compute ssh "$VM" --zone "$ZONE" --configuration "$CONF" --tunnel-through-iap --quiet \
    --command "$1" 2> >(grep -vE 'NumPy|increasing_the_tcp_upload_bandwidth|^$' >&2)
}

if [ "${1:-}" = "init" ]; then
  # Secrets are generated on the VM and never leave it. Existing values are kept.
  on_vm 'set -e; sudo mkdir -p /opt/cubr && sudo chown "$USER": /opt/cubr; cd /opt/cubr
    if [ -f .env ]; then echo ".env exists, left unchanged"; exit 0; fi
    umask 077
    printf "CUBR_VERSION=\nPOSTGRES_PASSWORD=%s\nJWT_SECRET=%s\nINTERNAL_API_TOKEN=%s\nCLOUDFLARE_TUNNEL_TOKEN=\n" \
      "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > .env
    echo "created /opt/cubr/.env (add CLOUDFLARE_TUNNEL_TOKEN before the first deploy)"'
  exit 0
fi

VERSION="${1:-$(scripts/bump-version.sh --current)}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a version: '${VERSION}'" >&2; exit 1; }
gcloud artifacts docker images describe "${REGISTRY_HOST}/cubr-app/cubr/web:${VERSION}" --configuration "$CONF" >/dev/null 2>&1 \
  || { echo "no images for ${VERSION} in Artifact Registry: build them first (see the header)" >&2; exit 1; }
echo "deploying cubr ${VERSION} to ${VM}"

# 1. compose files, gateway config, backup script and systemd timers, laid out like the repo so
#    relative paths keep working; (re)install the timers (nightly backup, weekly WCA import)
COPYFILE_DISABLE=1 tar --no-xattrs -czf - docker-compose.yml deploy/vps/compose.prod.yml deploy/gateway/nginx.conf \
    deploy/vps/backup.sh deploy/vps/systemd \
  | on_vm 'set -e; test -f /opt/cubr/.env || { echo "no /opt/cubr/.env: run deploy.sh init first" >&2; exit 1; }
      tar -xzf - -C /opt/cubr
      sudo install -m 644 /opt/cubr/deploy/vps/systemd/cubr-* /etc/systemd/system/
      sudo systemctl daemon-reload
      sudo systemctl enable --now cubr-backup.timer cubr-wca-import.timer 2>/dev/null'

# 2. registry login (VM service account), pull the new version (a shell variable beats .env), and
#    only once that worked record it in .env and restart, then wait for health
on_vm "set -e; cd /opt/cubr
  grep -q '^CLOUDFLARE_TUNNEL_TOKEN=.\\+' .env || { echo 'CLOUDFLARE_TUNNEL_TOKEN is empty in .env' >&2; exit 1; }
  gcloud auth configure-docker ${REGISTRY_HOST} --quiet >/dev/null 2>&1
  CUBR_VERSION=${VERSION} ${COMPOSE} pull --quiet
  grep -q '^CUBR_VERSION=' .env && sed -i 's/^CUBR_VERSION=.*/CUBR_VERSION=${VERSION}/' .env || echo 'CUBR_VERSION=${VERSION}' >> .env
  ${COMPOSE} up -d --remove-orphans
  for i in \$(seq 1 60); do
    starting=\$(${COMPOSE} ps --format '{{.Status}}' | grep -cE 'starting|unhealthy' || true)
    [ \"\$starting\" = 0 ] && break; sleep 5
  done
  ${COMPOSE} ps --format 'table {{.Service}}\t{{.Status}}'
  curl -fsS -o /dev/null -w 'gateway /healthz: %{http_code}\n' http://127.0.0.1:8080/healthz"
