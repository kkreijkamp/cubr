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
health checks, then checks the gateway. A changed gateway config means recreating the gateway (a second or two), which deploy.sh
does by itself: its `nginx.conf` is a single-file mount, and a running container never sees the release's
new copy of the file (found with 1.5.0, whose gateway kept the 1.4.0 routing until recreated).

Roll back to an earlier release with `deploy/vps/deploy.sh 1.1.0`. Its images are still in
Artifact Registry; if they aren't, use `release.sh 1.1.0`.

## Operating

```sh
gcloud compute ssh cubr-1 --configuration=cubr --tunnel-through-iap      # shell on the VM
cd /opt/cubr && C="docker compose -f docker-compose.yml -f deploy/vps/compose.prod.yml"
$C ps            # health of every service
$C logs -f gateway                         # access log with real visitor IPs
$C logs auth | grep '"client error"'       # errors in visitors' browsers (SPEC 10.5; no IPs)
$C exec postgres psql -U cubr -d cubr      # database shell
$C --profile jobs run --rm wca-import      # refresh the WCA data now (~3 min)
```

The gateway is also on the VM's `127.0.0.1:8080`, so `curl http://127.0.0.1:8080/healthz`
works over SSH. Docker restarts crashed containers and starts the stack on boot
(`restart: unless-stopped`).

## Security headers and crawler files

The web container sends a Content-Security-Policy and the other security headers on every page, and
every service sends the API's set (docs/SPEC.md 10.2 and section 3). Check them after a release:

```
curl -sI https://cubr.dev/ | grep -i -E 'content-security|x-frame|nosniff|strict-transport|permissions'
curl -s -o /dev/null -w '%{http_code}\n' https://cubr.dev/no/such/page     # 404
curl -s https://cubr.dev/robots.txt; curl -s https://cubr.dev/.well-known/security.txt
```

- **A page that breaks after a change** (something doesn't load or run): the browser console says
  which directive refused what. The inline theme script in `web/index.html` is allowed by its hash;
  `web/src/__tests__/site.test.ts` fails until the hash in `web/nginx/default.conf.template` matches.
- **security.txt expires** (its `Expires`, now 2027-11-16): the same test fails 30 days before. Move
  the date up to a year ahead and release.
- **Outside checks** (paste the site into them): MDN HTTP Observatory, securityheaders.com and
  Google Search Console (the sitemap, and the 404s it finds).

## The offline app (service worker)

cubr installs as an app and works offline: a service worker (`web/src/sw/`, docs/SPEC.md 10.1)
caches the web app in each visitor's browser. What that means for releases:

- **Browsers check `/sw.js` on every page load.** The web container sends it with
  `Cache-Control: no-cache`, which Cloudflare respects. Check it with
  `curl -sI https://cubr.dev/sw.js`.
- **After a release that changes the web app,** open pages show "update ready". The new version
  applies when the notice is clicked or on the next link click inside the app, never by itself.
  A tab that's never reloaded keeps running the previous version, so **keep API changes backward
  compatible for one release.**
- **A release that doesn't change the web app** builds the same `sw.js`, so nobody sees a notice.
- **Kill switch** (if the worker itself misbehaves): in `web/Dockerfile`, change
  `ARG VITE_SW=on` to `off` and release. Each browser removes the worker and its caches on its
  next visit and reloads from the network. Switch it back on in a later release.

## Sign-in providers (Google, Apple, GitHub)

"Continue with Google / Apple / GitHub" (services/auth/README.md) needs an app registered with each
provider. A provider stays off, with no button on the site, until all of its values are in
`/opt/cubr/.env`. After changing them, recreate the auth container and check:

```sh
$C up -d auth                                        # on the VM: picks up the new .env values
curl -s https://cubr.dev/api/auth/oauth/providers    # {"providers":["google",...]}
```

The redirect (callback) URLs to register, exactly:
`https://cubr.dev/api/auth/oauth/google/callback`, `.../apple/callback`, `.../github/callback`.

- **Google** (free). In the Google Cloud console (project `cubr-app`), open Google Auth Platform.
  1. Branding: app name `cubr`, support email `hello@cubr.dev`, home page `https://cubr.dev`,
     privacy policy `https://cubr.dev/privacy`, terms `https://cubr.dev/terms`, authorised
     domain `cubr.dev`. Skip the logo: adding one needs Google's brand review first.
  2. Audience: External, then publish the app. While it is in testing, only listed test users
     can sign in.
  3. Data access: only `openid`, `email` and `profile`. These need no Google verification.
  4. Clients: create a "Web application" client with the Google redirect URL above. No
     JavaScript origins are needed: the server runs the flow. Copy the client secret right away,
     because newer clients don't show it again. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- **GitHub** (free). Go to Settings, Developer settings, OAuth Apps, New OAuth App. Use name
  `cubr`, home page `https://cubr.dev` and the GitHub callback URL above. Leave device flow off.
  Generate a client secret, then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
- **Apple** needs a paid Apple Developer Program membership (US$99 a year). In Certificates,
  Identifiers & Profiles:
  1. An App ID (an explicit bundle id such as `dev.cubr.app`) with Sign in with Apple enabled.
  2. A Services ID (for example `dev.cubr.signin`) with the description `cubr`, which people see
     when they sign in. This is `APPLE_CLIENT_ID`. Enable Sign in with Apple on it and configure
     it with the App ID above as primary, domain `cubr.dev` and the Apple return URL above. If
     Apple asks to verify the domain, it gives a file to serve at
     `/.well-known/apple-developer-domain-association.txt` (add it to `web/public/.well-known/`).
  3. A key with Sign in with Apple enabled, linked to the App ID. Download the `.p8`: Apple
     allows one download only. Its id is `APPLE_KEY_ID`. The team id at the top right is
     `APPLE_TEAM_ID`. `APPLE_PRIVATE_KEY` is the `.p8` on one line, with line breaks written
     as `\n`: `awk 'NF {printf "%s\\n", $0}' AuthKey_XXXXXXXXXX.p8`.
  4. People who pick "Hide My Email" get an `@privaterelay.appleid.com` address, and Apple
     forwards only mail from registered senders. Under Services, "Sign in with Apple for Email
     Communication", register `cubr.dev` and `no-reply@cubr.dev`. Without that, their
     password-reset emails don't arrive; signing in with Apple still works.

Accounts made with a provider have no password until they use "forgot password?". The site never
connects a provider to an existing account by matching emails. People connect providers
themselves on the account page.

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
  The sign-in providers' client secrets and Apple's key are there too ("Sign-in providers").
- **Email DNS** (Cloudflare): `cubr.dev` MX to iCloud+ (`hello@cubr.dev`, a custom-domain address),
  SPF for iCloud, Apple's domain TXT and DKIM CNAME (`sig1._domainkey`), `_dmarc` (report-only for
  now), and Resend's records (`resend._domainkey`, `send` MX/TXT, `rsend` CNAME).
- **www.cubr.dev** redirects to `https://cubr.dev` at Cloudflare's edge, with the same path and query
  (301): a proxied `AAAA www 100::` record (no origin) and a Redirect Rule (Rules > Redirect Rules,
  `http.host eq "www.cubr.dev"`). Its requests never reach the VM; the HTTPS certificate covers it as
  `*.cubr.dev`.
- **Login flood guard** at Cloudflare's edge (Security > WAF > Rate limiting rules, the free plan's
  one rule): more than 5 requests to `/api/auth/login` in 10 s from one IP (per Cloudflare data
  centre) are blocked for 10 s with a JSON 429 in the app's error format ("Too many login attempts,
  try again in a few seconds"). It stops bursts before they reach the VM; the auth service's own
  limit (10 a minute per IP) still applies behind it.
- **Zone settings** (Cloudflare, SSL/TLS and Security > Settings): Always Use HTTPS, minimum TLS 1.2,
  TLS 1.3, Automatic HTTPS Rewrites and Browser Integrity Check are on. Check the TLS floor with
  `curl -sSI --tlsv1.1 --tls-max 1.1 https://cubr.dev/`, which must fail with "alert protocol version".
- **Bot Fight Mode stays off.** The free plan can't exempt anything from it, so it may challenge
  Google Cloud's uptime check (`/healthz`), Ko-fi's webhook (`/api/supporters/kofi`) and
  `scripts/smoke.mjs`, none of which can answer a challenge. It also forces Cloudflare's JavaScript
  detections on: an inline script in every page, which the CSP refuses unless its header carries a
  nonce.
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
