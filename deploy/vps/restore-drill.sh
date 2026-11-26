#!/bin/bash
# The restore drill (runbook "Backups and scheduled jobs"), every three months: last night's backup restored
# into a throwaway Postgres with no network, timed, and its row counts set beside the live ones.
# Production is only read. Run from the Mac: gcloud compute ssh cubr-1 --zone australia-southeast1-a
#   --configuration=cubr --tunnel-through-iap --command 'bash -s' < deploy/vps/restore-drill.sh
set -uo pipefail
cd /opt/cubr || exit 1
C="sudo docker compose -f docker-compose.yml -f deploy/vps/compose.prod.yml"
dump=/var/tmp/cubr-restore-drill.dump
cleanup() { sudo docker rm -f cubr-restore-drill >/dev/null 2>&1 || true; sudo rm -f "$dump"; }
trap cleanup EXIT
latest=$(sudo gcloud storage ls -l gs://cubr-app-backups/postgres/ 2>/dev/null | grep -v TOTAL | sort -k2 | tail -1 | awk '{print $3}')
echo "latest backup: $latest"
t0=$(date +%s); sudo gcloud storage cp "$latest" "$dump" --quiet 2>/dev/null; t1=$(date +%s)
sudo docker run -d --name cubr-restore-drill -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=cubr --network none postgres:17-alpine >/dev/null
for _ in $(seq 1 90); do
  [ "$(sudo docker logs cubr-restore-drill 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break; sleep 1
done
t2=$(date +%s)
sudo cat "$dump" | sudo docker exec -i cubr-restore-drill pg_restore -U postgres -d cubr --no-owner --no-acl 2> /var/tmp/drill.err; rc=$?
t3=$(date +%s)
echo "dump $(sudo stat -c %s "$dump") bytes | download $((t1-t0)) s | postgres up $((t2-t1)) s | restore $((t3-t2)) s | pg_restore exit $rc, $(wc -l < /var/tmp/drill.err) error lines"
rm -f /var/tmp/drill.err
cat > /var/tmp/drill.sql <<'SQL'
select 'auth.users ' || (select count(*) from auth.users)
union all select 'auth.user_identities ' || (select count(*) from auth.user_identities)
union all select 'solve.sessions ' || (select count(*) from solve.sessions)
union all select 'solve.solves ' || (select count(*) from solve.solves)
union all select 'solve.daily_attempts ' || (select count(*) from solve.daily_attempts)
union all select 'newest solve ' || (select max(created_at)::text from solve.solves)
union all select 'schemas ' || (select string_agg(nspname, ',' order by nspname) from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' and nspname <> 'public');
SQL
echo "--- restored:"
# shellcheck disable=SC2024 # /var/tmp/drill.sql is the caller's own file, so no sudo is needed to read it
sudo docker exec -i cubr-restore-drill psql -U postgres -d cubr -At < /var/tmp/drill.sql
echo "--- live now:"; $C exec -T postgres psql -U cubr -d cubr -At < /var/tmp/drill.sql
rm -f /var/tmp/drill.sql
