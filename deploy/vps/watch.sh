#!/bin/bash
# What needs a human (run every 15 minutes by cubr-watch.timer, as root on the VM). A problem goes to
# Cloud Logging as an error in the log "cubr-watch", where an alert policy emails the owner (runbook
# "Alerts"); the same problems are written again only after 6 hours. It checks:
# - the disk is 80 % full or more;
# - a service's container isn't running or is unhealthy, or restarted since the last check;
# - 20 or more 5xx answers from the gateway in the last 15 minutes;
# - the nightly backup hasn't succeeded in 26 hours, or the weekly WCA import in 8 days.
set -uo pipefail
cd /opt/cubr || exit 1
STATE=/var/lib/cubr-watch
mkdir -p "$STATE"
problems=()

use=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "${use:-0}" -ge 80 ] && problems+=("disk ${use}% full")

# the services' containers (not one-off jobs): running, healthy, and no new restarts
while read -r name state health restarts; do
  [ -n "$name" ] || continue
  [ "$state" = running ] || problems+=("container $name is $state")
  [ "$health" = unhealthy ] && problems+=("container $name is unhealthy")
  prev=$(cat "$STATE/restarts-$name" 2>/dev/null || echo "$restarts")
  [ "$restarts" -gt "$prev" ] && problems+=("container $name restarted $((restarts - prev)) time(s)")
  echo "$restarts" > "$STATE/restarts-$name"
done < <(docker ps -aq --filter label=com.docker.compose.project=cubr --filter label=com.docker.compose.oneoff=False |
  xargs -r docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' | sed 's#^/##')

# the gateway's access log: $remote_addr "$request" $status ...
fives=$(docker logs --since 15m cubr-gateway-1 2>/dev/null | grep -cE '" 5[0-9]{2} ')
[ "${fives:-0}" -ge 20 ] && problems+=("${fives} server errors (5xx) in the last 15 minutes")

journalctl -u cubr-backup.service --since -26h -q 2>/dev/null | grep -q 'backup ok' || problems+=("no successful backup in 26 hours")
journalctl -u cubr-wca-import.service --since -8d -q 2>/dev/null | grep -q 'imported export' || problems+=("no successful WCA import in 8 days")

if [ ${#problems[@]} -eq 0 ]; then
  rm -f "$STATE/last"
  exit 0
fi
msg="cubr-1: $(IFS='; '; echo "${problems[*]}")"
# the same problems again only every 6 hours (the alert itself also waits an hour between emails)
if [ -f "$STATE/last" ] && [ "$(cat "$STATE/last")" = "$msg" ] && [ -n "$(find "$STATE/last" -mmin -360)" ]; then
  exit 0
fi
echo "$msg" > "$STATE/last"
echo "$msg" >&2
gcloud logging write cubr-watch "$msg" --severity=ERROR --quiet
