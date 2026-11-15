#!/bin/bash
# Nightly Postgres backup (run by cubr-backup.timer as root on the VM).
# pg_dump in custom format of everything except the WCA schemas, which the weekly import rebuilds,
# checked with pg_restore --list, then copied to gs://cubr-app-backups/postgres/. The bucket deletes
# copies after 30 days; the VM's service account may add and read backups but not delete them.
# Restore: gcloud storage cp gs://cubr-app-backups/postgres/<file> /var/tmp/r.dump, then
#   docker compose ... exec -T postgres pg_restore -U cubr -d cubr --clean --if-exists < /var/tmp/r.dump
set -euo pipefail
cd /opt/cubr
BUCKET="${CUBR_BACKUP_BUCKET:-gs://cubr-app-backups}"
C="docker compose -f docker-compose.yml -f deploy/vps/compose.prod.yml"
name="postgres/cubr-$(date -u +%Y-%m-%dT%H%MZ).dump"
tmp=$(mktemp /var/tmp/cubr-backup.XXXXXX)
trap 'rm -f "$tmp"' EXIT

$C exec -T postgres pg_dump -U cubr -d cubr --format=custom --compress=9 --exclude-schema='wca*' > "$tmp"
$C exec -T postgres pg_restore --list < "$tmp" > /dev/null      # a truncated dump fails here
gcloud storage cp "$tmp" "$BUCKET/$name" --quiet
echo "backup ok: $BUCKET/$name ($(stat -c %s "$tmp") bytes)"
