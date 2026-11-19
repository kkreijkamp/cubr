# cubr deployment

This folder holds everything needed to run cubr outside a developer's editor:

- a **docker compose** stack for local development;
- **production on one VM** behind a Cloudflare Tunnel: see [`vps/README.md`](vps/README.md);
- **GKE Standard** (project `cubr-app`, `australia-southeast1-a`) for when one VM is no longer enough.

All three use the same container images and the same routing table.

| Path | What it is |
|---|---|
| `../docker-compose.yml` | Full local stack: Postgres, Redis, 7 services, web and the nginx gateway (+ `jobs` profile) |
| `gateway/nginx.conf` | Compose gateway that mimics the GKE Ingress routes |
| `k8s/base/` | Environment-neutral manifests (kustomize): namespace, ConfigMap, CloudNativePG `Cluster`, Redis StatefulSet, 8 Deployments + Services + PDBs, 4 HPAs, wca-import CronJob |
| `k8s/overlays/gke/` | Artifact Registry images, Ingress, BackendConfigs, NEG annotations, `standard-rwo` storage, 3 Postgres instances, `TRUST_PROXY_HOPS=2` |
| `k8s/jobs/seed` | On-demand Job: synthetic demo data. Not part of the base. Apply it via `overlays/gke/seed` so the image is rewritten. |
| `../cloudbuild.yaml` | Cloud Build for all 10 images in parallel |
| `vps/` | Production: host bootstrap, compose override, release and deploy scripts, backups |
| `../scripts/commands.sh` | **Every GKE command, numbered sections 0-11, each one commented** |
| `../scripts/smoke.mjs` | End-to-end check through any entry point: `node scripts/smoke.mjs <baseUrl>` |

---

## 1. Architecture of the deployment

```
                    Internet
                       |  http://<cubr-ip>/
         +-------------v-------------+   GKE Ingress (class gce) = Google external Application LB
         |  URL map: path prefixes   |   static global IP "cubr-ip", health checks on /readyz
         +--+---+---+---+---+---+--+-+   container-native LB: traffic goes straight to pod IPs (NEGs)
            |   |   |   |   |   |  +------------- default -> web (nginx, SPA)         HPA 2-6
   /api/auth|   |   |   |   |   +- /api/race, /socket.io -> race (WebSockets)       HPA 2-6
  /api/users|   |   |   |   +---- /api/wca -> wca                                   2
            |   |   |   +-------- /api/leaderboards -> leaderboard                  2
            |   |   +------------ /api/stats -> stats                               2
            |   +---------------- /api/sessions, /api/solves -> solve               HPA 2-6
            +---- auth  2         /api/scrambles -> scramble (CPU-heavy)            HPA 2-8
                       |
     internal (ClusterIP Services, http://<svc>:8080, /internal/* never exposed)
                       |
   +-------------------v--------------------+     +-------------------------------+
   | CloudNativePG Cluster "pg"             |     | Redis StatefulSet (PVC 1Gi)   |
   | pg-1 primary + pg-2, pg-3 replicas     |     | streams (event bus), cache,   |
   | Service pg-rw -> primary, auto-failover|     | leaderboards, race state      |
   +----------------------------------------+     +-------------------------------+
   CronJob wca-import (weekly) - Job seed (on demand)
```

**Why it is built this way**

- **Kubernetes-native building blocks.** Each microservice is a Deployment with a ClusterIP Service. Service discovery is plain DNS (`http://solve:8080`), the same names compose uses.
- **Zero-downtime rollouts.** Rolling updates use `maxSurge 1` / `maxUnavailable 0` / `minReadySeconds 5`. Readiness gates traffic on dependencies; liveness only checks that the process is alive. A `preStop` sleep of 10 s plus 30 s of LB connection draining means pods leave the load balancer before they stop.
- **Availability.**
  - Every Deployment has at least 2 replicas.
  - `topologySpreadConstraints` spread replicas over nodes, with `ScheduleAnyway` so spreading never blocks scheduling.
  - `PodDisruptionBudget minAvailable 1` stops `kubectl drain` or node upgrades from evicting the last ready pod.
- **Scalability.**
  - HPAs act on CPU relative to each pod's request. scramble is the deliberate CPU hotspot.
  - The behavior block scales up immediately and back down after 60 s of low load.
  - The cluster autoscaler (3-5 nodes) adds nodes when HPA pods are Pending.
  - HPA-managed Deployments have **no `spec.replicas`**, so `kubectl apply` never resets a scaled-out service.
- **Stateful pieces run self-managed on the cluster.** Managed Cloud SQL HA plus Memorystore would add about US$185/month.
  - **CloudNativePG** gives a primary with streaming replicas, automatic failover (`pg-rw` follows the primary), and generated credentials (`pg-app` Secret -> `DATABASE_URL`).
  - **Redis** has a PVC. It is designed to be loseable: leaderboards rebuild and the solve outbox re-delivers events.
- **Security.**
  - Pods run as non-root (`runAsNonRoot`, numeric UID), with no privilege escalation, all capabilities dropped and a read-only root filesystem (writable `/tmp` via emptyDir).
  - No ServiceAccount token is mounted.
  - Secrets are never committed. `cubr-secrets` holds `JWT_SECRET` and `INTERNAL_API_TOKEN` (required on `/internal/*` calls between services) and is created by `commands.sh` section 8.
- **Images.** One image per service, tagged `<version>` and built with `--build-arg APP_VERSION`. The version shows in each service's `/_info` and in the footer (the web image's `/_info`).

### Resource sizing (requests -> limits)

| Workload | CPU req | Mem req | CPU lim | Mem lim | Why |
|---|---|---|---|---|---|
| scramble | 250m | 256Mi | 1 | 512Mi | Saturates about 1 core (1 cubing.js worker, ~4-5 fresh 4x4 req/s) at 165-240 MB RSS. The 250m request makes HPA % rise visibly. |
| solve | 50m | 128Mi | 500m | 512Mi | 25 MB csTimer imports are parsed in memory |
| stats | 50m | 128Mi | 500m | 512Mi | Bulk-import recomputes. 256Mi was OOMKilled while seeding. |
| auth | 50m | 96Mi | 500m | 256Mi | bcrypt cost 10 bursts CPU |
| leaderboard, race | 50m | 96Mi | 300-500m | 256Mi | Redis-bound |
| wca | 50m | 128Mi | 500m | 384Mi | SQL-heavy, cached in Redis |
| web | 20m | 32Mi | 200m | 128Mi | nginx static files |
| Postgres (3x on GKE) | 100m | 512Mi | - | 1Gi | No CPU limit (avoids throttling the DB). `shared_buffers` 128MB. |
| Redis | 50m | 128Mi | 500m | 512Mi | `maxmemory 300mb`, `noeviction` |

Baseline requests on GKE come to about **1.6 vCPU / 3.5 GiB**. Three e2-standard-2 nodes give about 5 vCPU / 16 GiB allocatable. That leaves headroom for 8 scramble pods (2 vCPU requested) plus jobs before the autoscaler needs node 4.

---

## 2. Local development with docker compose

```bash
docker compose up -d --build                  # build all images and start everything
open http://localhost:8080                    # gateway: same routes as the Ingress
docker compose ps                             # all services report (healthy) via /readyz
docker compose up -d --scale solve=3          # 3 replicas behind the gateway (round-robin)
for i in $(seq 9); do curl -s localhost:8080/api/solves/_info | grep -o '"pod":"[^"]*"'; done
docker compose --profile jobs run --rm wca-import       # downloads the WCA export (or see below)
docker compose --profile jobs run --rm seed             # 150 users + ~100k solves (SEED_USERS=20 for less); demo login: demo / cubr-demo
node scripts/smoke.mjs http://localhost:8080            # end-to-end check
docker compose down          # stop; add -v to also delete the Postgres/Redis volumes
```

- The gateway resolves backends **per request** through Docker's DNS (`resolver 127.0.0.11 valid=10s`):
  - it starts even if a service is down; that route answers `502 {"error":{"code":"UNAVAILABLE"...}}`;
  - after `--scale` it round-robins over all containers within about 10 s;
  - the access log (`docker compose logs gateway`) shows the container it picked (`upstream=`); no response header names a container or an internal address.
- `/internal/*` returns 404, including `../` and `%2e%2e` tricks. WebSocket upgrades on `/socket.io` work, with a 1 h timeout. `client_max_body_size` is 25m.
- Host ports: `8080` (gateway), plus Postgres on `127.0.0.1:55433` and Redis on `127.0.0.1:56380` (psql / redis-cli, or running one service on the host with `npm run dev`).
- Offline WCA import from an unzipped export:
  `docker compose --profile jobs run --rm -v "$PWD/data/wca/tsv:/data:ro" -e WCA_TSV_DIR=/data wca-import`

## 3. GKE deployment

Run `scripts/commands.sh` section by section (`scripts/commands.sh list` prints them). Every command carries a comment explaining it and its flags.

| section  | Step |
|---|---|
| 0 | Variables (`PROJECT_ID=cubr-app`, `ZONE=australia-southeast1-a`, `CLUSTER=cubr`, `REPO=cubr`, `VERSION=1.5.17`) |
| 1 | `gcloud auth list`, select your account (`ACCOUNT`, default: gcloud's active one), set project/region/zone |
| 2 | Enable container, artifactregistry, cloudbuild and compute APIs |
| 3 | Artifact Registry repo. IAM: nodes get `artifactregistry.reader` and `container.defaultNodeServiceAccount`; the build SA gets `artifactregistry.writer`, `logging.logWriter` and `storage.objectViewer`. |
| 4 | `gcloud builds submit --config cloudbuild.yaml --substitutions _VERSION=1.5.17,...` (10 images in parallel, native amd64) |
| 5 | `gcloud container clusters create` (3x e2-standard-2, autoscaling 3-5, 30 GB pd-balanced, regular channel, VPC-native) + `get-credentials` |
| 6 | Reserve the global static IP `cubr-ip` |
| 7 | Install CloudNativePG 1.30.1 (server-side apply) and wait for the operator |
| 8 | Namespace + `cubr-secrets` (random `JWT_SECRET`, `INTERNAL_API_TOKEN`) |
| 9 | `kubectl apply -k deploy/k8s/overlays/gke`, wait for pg/redis/rollouts, wait for the Ingress IP (up to 25 min: ~17 min on a first deploy) and for the load balancer to answer (up to 10 min), smoke test |
| 10 | `kubectl create job --from=cronjob/wca-import wca-import-now`, seed Job |
| 11 | Cost control: pause (autoscaler off, app and Redis to 0 replicas, hibernate PostgreSQL, pool to 0); resume and delete (namespace, cluster, IP, repo) as commented copy-paste steps |

To release a new version permanently: commit (the pre-commit hook bumps the version in every deploy file and the commit is tagged `vX.Y.Z`; enable the hooks once per clone with `git config core.hooksPath .githooks`, and see `scripts/bump-version.sh` for the details), build that version with section 4, then apply it with section 9. Don't edit `newTag` by hand, and always build before applying: until section 4 has run, the overlay names images that don't exist yet. A `kubectl set image` lasts only until the next `kubectl apply -k`, which reverts to the overlay's tag.

**Verified on GKE** (first deploy; Kubernetes 1.36.4, 3x e2-standard-2):

- Cloud Build: all 10 images in about 2-2.5 min.
- First deploy: the Ingress got its address after about 17 min (Google configures the 8 backend services one after another, about 90 s each), and the load balancer answered 3 min later, with all 8 backends `HEALTHY`.
- Smoke test passes through the public IP.
- WCA import: 2.6 million rows in 52 s. Seed: 151 users and about 91,500 solves in 36 s.
- Rolling updates of all 8 services (1.0.12 -> 1.0.14 -> 1.0.15) took 55-63 s each with **0 errors** in 325 and 356 requests, probing an authenticated `GET /api/sessions` (through solve to PostgreSQL) and the web pods' `/_info` twice a second.

## 4. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Ingress answers **404 / 502** for 5-10 min after deploy | The Google LB is still being programmed and health checks are warming up. Check `kubectl -n cubr describe ingress cubr` until the `ingress.kubernetes.io/backends` annotation shows `HEALTHY` everywhere. BackendConfigs probe `/readyz:8080`, so a backend whose Postgres/Redis is down stays unhealthy on purpose. |
| A single backend permanently `UNHEALTHY` | `kubectl -n cubr logs deploy/<svc>` and `curl` its `/readyz` via `kubectl port-forward`. BackendConfig changes can take minutes to sync. |
| **ImagePullBackOff** with 403 on GKE | The node SA can't read Artifact Registry: re-run the `artifactregistry.reader` binding (section 3). Check the image path `australia-southeast1-docker.pkg.dev/cubr-app/cubr/<svc>:<tag>` exists (`gcloud artifacts docker images list ...`). |
| `exec format error` | arm64 image on amd64 nodes. Build with Cloud Build (native amd64), or `docker buildx build --platform linux/amd64`. |
| Cloud Build: permission denied pushing / writing logs | The build SA lacks `artifactregistry.writer` / `logging.logWriter` (section 3). New projects build as the Compute default SA. |
| `failed calling webhook "...cnpg.io"` when applying | The CNPG operator isn't ready yet: `kubectl rollout status deployment/cnpg-controller-manager -n cnpg-system`, then re-apply. On private-node clusters, open TCP 9443 from the control plane. |
| Pods stuck `CreateContainerConfigError` | The Secret is missing: `cubr-secrets` (section 8) or `pg-app` (created by CNPG once the Cluster exists; pods recover automatically). |
| wca-import Job fails `curl: (22) ... 429` | The WCA export endpoint is rate-limiting your IP. Retry later (`kubectl delete job wca-import-now` then create it again). Locally with docker compose, import offline from an unzipped export (see section 2 above). |
| HPA `TARGETS <unknown>` | metrics-server missing (GKE runs it by default) or the container has no CPU request. |
| WebSocket drops every 30 s on GKE | The race BackendConfig must have `timeoutSec: 3600`. The classic ALB closes WebSockets at the backend timeout. |
| `kubectl drain` hangs | A PDB is blocking (by design, e.g. only one ready replica). Wait for the replacement pod, or check `kubectl get pdb -n cubr`. Use `--delete-emptydir-data`. |
