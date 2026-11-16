# cubr production: one VM behind a Cloudflare Tunnel

https://cubr.dev runs the same Docker Compose stack as local development, on one GCP e2-small
(`cubr-1`, project `cubr-app`, australia-southeast1-a). Nothing on the VM is reachable from the
internet: cloudflared dials out to Cloudflare, Cloudflare terminates HTTPS for cubr.dev and sends
requests through the tunnel to the gateway. SSH works only through Google's IAP tunnel.

```
visitor --HTTPS--> Cloudflare edge --tunnel--> cloudflared --> gateway (nginx) --> services
                                                (VM, compose network; Postgres + Redis on the VM)
```

Files here:
- `bootstrap.sh`: host setup.
- `compose.prod.yml`: production override of `docker-compose.yml`.
- `release.sh`: build a release from its tag, then deploy it.
- `deploy.sh`: copy, pull and restart.
- `.env.example`: what `/opt/cubr/.env` holds.

## Everyday: ship a release (only `main` runs in production)

Work happens on `dev`; every commit gets a patch version and tag from the hooks. A release:

1. Bump the version on `dev`: `scripts/bump-version.sh 1.2.0`, then add the patch notes for it in
   `web/src/content/patchNotes.ts` and commit. The hooks tag it `v1.2.0`.
2. Open a pull request `dev` → `main` and merge it with a merge commit, so the tag lands on main.
3. `deploy/vps/release.sh` (~3 min).

`release.sh` refuses any version whose tag isn't on `origin/main`, builds the images on Cloud
Build from the tag itself (`git archive`, never the working tree), then runs `deploy.sh`.
`deploy.sh` makes the same main-only check, copies the compose files and gateway config from the
tag to `/opt/cubr`, pulls the images, sets `CUBR_VERSION`, restarts what changed, waits for the
health checks, then checks the gateway.

Roll back to an earlier release with `deploy/vps/deploy.sh 1.1.0`. Its images are still in
Artifact Registry; if they aren't, use `release.sh 1.1.0`.

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
  Changing `JWT_SECRET` signs everyone out. `RESEND_API_KEY` (only the auth container gets it)
  sends password-reset emails from `no-reply@cubr.dev`; without it they are only logged.
- **Email DNS** (Cloudflare): `cubr.dev` MX to Google Workspace (`hello@cubr.dev`), SPF for Google,
  `_dmarc` (report-only for now), and Resend's records (`resend._domainkey`, `send` MX/TXT,
  `rsend` CNAME).
- **Logs rotate.** Every container logs through `json-file` with at most 3 x 10 MB (`x-logging` in
  `compose.prod.yml`), so the gateway's access log, which holds visitors' IPs, is overwritten as it
  fills up. The privacy policy (`/privacy`) relies on this.
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
