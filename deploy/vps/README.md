# cubr production: one VM behind a Cloudflare Tunnel

https://cubr.dev runs the same Docker Compose stack as local development, on one GCP e2-small
(`cubr-1`, project `cubr-app`, australia-southeast1-a). Nothing on the VM is reachable from the
internet: cloudflared dials out to Cloudflare, Cloudflare terminates HTTPS for cubr.dev and sends
requests through the tunnel to the gateway. SSH works only through Google's IAP tunnel.

```
visitor --HTTPS--> Cloudflare edge --tunnel--> cloudflared --> gateway (nginx) --> services
                                                (VM, compose network; Postgres + Redis on the VM)
```

Files here: `bootstrap.sh` (host setup), `compose.prod.yml` (production override of
`docker-compose.yml`), `deploy.sh` (copy + pull + restart), `.env.example` (what `/opt/cubr/.env`
holds). The hosting decision and costs are in `A4/cubetype-aws-migration-2026-11-15.md` section 9.

## Everyday: ship a new version

```sh
git push                                   # commit first: hooks bump the version + tag
gcloud builds submit --configuration=cubr --config=cloudbuild.yaml \
  --ignore-file=.dockerignore --region=australia-southeast1 .     # ~2 min, pushes all images
deploy/vps/deploy.sh                       # defaults to package.json's version
```

`deploy.sh` copies the compose files and gateway config to `/opt/cubr`, sets `CUBR_VERSION`,
pulls and restarts what changed, waits for health checks, then checks the gateway. Roll back by
passing an older version: `deploy/vps/deploy.sh 1.0.82`.

## Operating

```sh
gcloud compute ssh cubr-1 --configuration=cubr --tunnel-through-iap      # shell on the VM
cd /opt/cubr && C="docker compose -f docker-compose.yml -f deploy/vps/compose.prod.yml"
$C ps            # health of every service
$C logs -f gateway                         # access log with real visitor IPs
$C exec postgres psql -U cubr -d cubr      # database shell
$C --profile jobs run --rm wca-import      # refresh the WCA data now (~3 min)
```

The gateway is also on the VM's `127.0.0.1:8080`, so `curl http://127.0.0.1:8080/healthz`
works over SSH. Docker restarts crashed containers and starts the stack on boot
(`restart: unless-stopped`).

## Backups and scheduled jobs

systemd timers on the VM (installed by `deploy.sh`):
- **`cubr-backup.timer`, nightly 02:30 Brisbane.** Runs `backup.sh`: a `pg_dump` of everything
  except the WCA schemas, checked with `pg_restore --list`, then copied to
  `gs://cubr-app-backups/postgres/` (Melbourne). Copies are deleted after 30 days. The VM can
  add and read backups but not delete them.
- **`cubr-wca-import.timer`, Mondays 04:00 Brisbane.** Refreshes the WCA export (~3 min).

```sh
systemctl list-timers 'cubr-*'                         # next runs
sudo systemctl start cubr-backup.service               # back up now
journalctl -u cubr-backup.service -n 20                # last result
gcloud storage ls -l gs://cubr-app-backups/postgres/   # what's stored
```

Restore: copy a dump to the VM, then
`$C exec -T postgres pg_restore -U cubr -d cubr --clean --if-exists < cubr-<date>.dump`,
and run the WCA import.

## How the pieces fit

- **Secrets** live only in `/opt/cubr/.env` (mode 600): `deploy.sh init` generated the Postgres
  password, JWT secret and internal token on the VM; the tunnel token comes from Cloudflare's API.
  Changing `JWT_SECRET` signs everyone out.
- **Real client IPs.** Cloudflare sends the visitor's address in `CF-Connecting-IP`; the gateway
  (`deploy/gateway/nginx.conf`) uses it only for requests from Docker networks, so the per-IP rate
  limits (login 10/min, sign-up 20/h, race rooms 20/min) count visitors, not the tunnel.
- **Memory.** About 1.3 GB of the 2 GB is in use; `bootstrap.sh` adds 2 GB of swap and the
  override caps each Node heap at 192 MB.
- **Images** are built by `cloudbuild.yaml` on Cloud Build and stored in Artifact Registry
  (`australia-southeast1-docker.pkg.dev/cubr-app/cubr`). The VM pulls with its own service
  account; no registry keys exist.

## Rebuilding the VM from scratch

1. `gcloud compute instances create cubr-1 --configuration=cubr --machine-type=e2-small
   --image-family=debian-13 --image-project=debian-cloud --boot-disk-size=20GB
   --boot-disk-type=pd-balanced --tags=cubr-vm --metadata=enable-oslogin=TRUE
   --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring`
   (the `allow-ssh-from-iap` firewall rule targets the `cubr-vm` tag).
2. `gcloud compute ssh cubr-1 --configuration=cubr --tunnel-through-iap --command 'sudo bash -s -- "$USER"' < deploy/vps/bootstrap.sh`
3. `deploy/vps/deploy.sh init`, then put the tunnel token into `/opt/cubr/.env`
   (`CLOUDFLARE_TUNNEL_TOKEN=`).
4. `deploy/vps/deploy.sh`, then restore the latest database backup and run the WCA import.
