# cubetype deployment

This folder holds everything needed to run cubetype outside a developer's editor:

- a **docker compose** stack for local development;
- a **kind** (Kubernetes-in-Docker) setup for testing the Kubernetes manifests locally;
- **GKE Standard** in `infs3208-a2-koen` / `australia-southeast1-a` for the real deployment.

All three use the same container images and the same routing table.

| Path | What it is |
|---|---|
| `../docker-compose.yml` | Full local stack: Postgres, Redis, 7 services, web and the nginx gateway (+ `jobs` profile) |
| `gateway/nginx.conf` | Compose gateway that mimics the GKE Ingress routes |
| `k8s/base/` | Environment-neutral manifests (kustomize): namespace, ConfigMap, CloudNativePG `Cluster`, Redis StatefulSet, 8 Deployments + Services + PDBs, 4 HPAs, wca-import CronJob |
| `k8s/overlays/gke/` | Artifact Registry images, Ingress, BackendConfigs, NEG annotations, `standard-rwo` storage, 3 Postgres instances |
| `k8s/overlays/local/` | kind: local `cubetype/<svc>:dev` images, nginx `gateway` (NodePort 30080 → `localhost:8090`) instead of the Ingress |
| `k8s/jobs/seed`, `k8s/jobs/loadgen` | On-demand Jobs: demo data, HPA load generator. Not part of the base. Apply seed via `overlays/<env>/seed` so the image is rewritten. |
| `k8s/kind/kind-config.yaml` | kind cluster: 1 control-plane + 2 workers, port mapping 8090 → 30080 |
| `cloudbuild/single-image.yaml` | Cloud Build for one image (e.g. `web:1.1.0` for the rollout demo) |
| `../cloudbuild.yaml` | Cloud Build for all 10 images in parallel |
| `../scripts/build-local.sh` | `docker build` all images as `cubetype/<name>:dev` (`--kind` also loads them into kind) |
| `../scripts/build-push.sh` | Alternative to Cloud Build: `docker buildx --platform linux/amd64 --push` to Artifact Registry |
| `../scripts/kind-up.sh` | Repeatable local Kubernetes setup (cluster, CNPG, metrics-server, images, secret, deploy) |
| `../scripts/kind-wca-import-tsv.sh` | Offline WCA import into kind from an unzipped export (if the WCA API rate-limits you) |
| `../scripts/smoke.mjs` | End-to-end check through any entry point: `node scripts/smoke.mjs <baseUrl>` |

---

## 1. Architecture of the deployment

```
                    Internet
                       │  http://<cubetype-ip>/
         ┌─────────────▼─────────────┐   GKE Ingress (class gce) = Google external Application LB
         │  URL map: path prefixes   │   static global IP "cubetype-ip", health checks on /readyz
         └──┬───┬───┬───┬───┬───┬──┬─┘   container-native LB: traffic goes straight to pod IPs (NEGs)
            │   │   │   │   │   │  └───────────── default → web (nginx, SPA)          HPA 2–6
   /api/auth│   │   │   │   │   └─ /api/race, /socket.io → race (WebSockets)        HPA 2–6
  /api/users│   │   │   │   └──── /api/wca → wca                                    2
            │   │   │   └──────── /api/leaderboards → leaderboard                   2
            │   │   └──────────── /api/stats → stats                                2
            │   └──────────────── /api/sessions, /api/solves → solve                HPA 2–6
            └──── auth  2         /api/scrambles → scramble (CPU-heavy)             HPA 2–8
                       │
     internal (ClusterIP Services, http://<svc>:8080, /internal/* never exposed)
                       │
   ┌───────────────────▼───────────────────┐      ┌───────────────────────────────┐
   │ CloudNativePG Cluster "pg"            │      │ Redis StatefulSet (PVC 1Gi)   │
   │ pg-1 primary + pg-2, pg-3 replicas    │      │ streams (event bus), cache,   │
   │ Service pg-rw → primary, auto-failover│      │ leaderboards, race state      │
   └───────────────────────────────────────┘      └───────────────────────────────┘
   CronJob wca-import (weekly) · Job seed (on demand) · Job loadgen (HPA demo)
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
  - The behavior block is tuned for a live demo: scale up immediately, scale down after 60 s.
  - The cluster autoscaler (3–5 nodes) adds nodes when HPA pods are Pending.
  - HPA-managed Deployments have **no `spec.replicas`**, so `kubectl apply` never resets a scaled-out service.
- **Stateful pieces run self-managed on the cluster.** Managed Cloud SQL HA plus Memorystore would add about US$185/month.
  - **CloudNativePG** gives a primary with streaming replicas, automatic failover (`pg-rw` follows the primary), and generated credentials (`pg-app` Secret → `DATABASE_URL`).
  - **Redis** has a PVC. It is designed to be loseable: leaderboards rebuild and the solve outbox re-delivers events.
- **Security.**
  - Pods run as non-root (`runAsNonRoot`, numeric UID), with no privilege escalation, all capabilities dropped and a read-only root filesystem (writable `/tmp` via emptyDir).
  - No ServiceAccount token is mounted.
  - Secrets are never committed. `cubetype-secrets` holds `JWT_SECRET` and `INTERNAL_API_TOKEN` and is created by `kind-up.sh` (see §3).
- **Images.** One image per service, tagged `<version>` and built with `--build-arg APP_VERSION`. The version shows in `X-Service` and on the `/status` page.

---

## 2. Local development with docker compose

```bash
docker compose up -d --build                  # build all images and start everything
open http://localhost:8080                    # gateway: same routes as the Ingress
docker compose ps                             # all services report (healthy) via /readyz
docker compose up -d --scale solve=3          # 3 replicas behind the gateway (round-robin)
for i in $(seq 9); do curl -sI localhost:8080/api/solves/_info | grep -i x-served-by; done
docker compose --profile jobs run --rm wca-import       # downloads the WCA export (or see below)
docker compose --profile jobs run --rm seed             # 150 users + ~100k solves (SEED_USERS=20 for less)
node scripts/smoke.mjs http://localhost:8080            # end-to-end check
docker compose down          # stop; add -v to also delete the Postgres/Redis volumes
```

- The gateway resolves backends **per request** through Docker's DNS (`resolver 127.0.0.11 valid=10s`):
  - it starts even if a service is down; that route answers `502 {"error":{"code":"UNAVAILABLE"…}}`;
  - after `--scale` it round-robins over all containers within about 10 s;
  - the `X-Upstream` response header shows the container it picked.
- `/internal/*` returns 404, including `../` and `%2e%2e` tricks. WebSocket upgrades on `/socket.io` work, with a 1 h timeout. `client_max_body_size` is 25m.
- Host ports: `8080` (gateway), plus Postgres on `127.0.0.1:55433` and Redis on `127.0.0.1:56380` (psql / redis-cli, or running one service on the host with `npm run dev`).
- Offline WCA import from an unzipped export:
  `docker compose --profile jobs run --rm -v "$PWD/data/wca/tsv:/data:ro" -e WCA_TSV_DIR=/data wca-import`

## 3. Local Kubernetes (kind)

This uses the same manifests as GKE (`overlays/local`), with an nginx gateway instead of the Google LB. It always uses a **separate kubeconfig file**, so your normal contexts are never touched.

```bash
brew install kind                                       # once
export KUBECONFIG=~/.kube/cubetype-kind.yaml            # any separate file
scripts/kind-up.sh                                      # cluster + CNPG 1.30.1 + metrics-server + build/load images + deploy
open http://localhost:8090                              # gateway NodePort 30080 (kind port mapping)
kubectl -n cubetype create job --from=cronjob/wca-import wca-import-now   # WCA data (needs internet)
scripts/kind-wca-import-tsv.sh ./data/wca/tsv           # ...or offline from unzipped TSVs
kubectl apply -k deploy/k8s/overlays/local/seed         # demo users + solves
node scripts/smoke.mjs http://localhost:8090
```

What `kind-up.sh` does, step by step (equivalent manual commands):

```bash
kind create cluster --config deploy/k8s/kind/kind-config.yaml --kubeconfig "$KUBECONFIG"
kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.1.yaml
kubectl rollout status deployment/cnpg-controller-manager -n cnpg-system
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.8.0/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
scripts/build-local.sh --kind                      # docker build + kind load (worker nodes only)
kubectl create namespace cubetype
kubectl -n cubetype create secret generic cubetype-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" --from-literal=INTERNAL_API_TOKEN="$(openssl rand -hex 24)"
kubectl apply -k deploy/k8s/overlays/local
kubectl -n cubetype wait cluster/pg --for=condition=Ready --timeout=600s
```

The rollout demo also works locally:

```bash
TAG=1.1.0 scripts/build-local.sh --kind web
kubectl -n cubetype set image deployment/web web=cubetype/web:1.1.0
kubectl -n cubetype rollout status deployment/web
kubectl -n cubetype rollout undo deployment/web
```

The HPA demo works the same way: `kubectl apply -k deploy/k8s/jobs/loadgen; kubectl -n cubetype get hpa scramble -w`.

To match GKE's version exactly, create the cluster with `NODE_IMAGE=kindest/node:v1.36.4 scripts/kind-up.sh`.

## 4. GKE deployment

In short (zone `australia-southeast1-a`, Artifact Registry `australia-southeast1-docker.pkg.dev/infs3208-a2-koen/cubetype`):

```bash
gcloud builds submit --region=australia-southeast1 --config=cloudbuild.yaml --substitutions=_VERSION=1.0.0 .
gcloud container clusters create cubetype --zone=australia-southeast1-a --machine-type=e2-standard-2 \
  --num-nodes=3 --enable-autoscaling --min-nodes=3 --max-nodes=5 --enable-ip-alias
gcloud compute addresses create cubetype-ip --global          # the Ingress refers to it by name
kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.1.yaml
kubectl create namespace cubetype
kubectl -n cubetype create secret generic cubetype-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" --from-literal=INTERNAL_API_TOKEN="$(openssl rand -hex 24)"
kubectl apply -k deploy/k8s/overlays/gke
```

To release a new version, change `newTag` in `k8s/overlays/gke/kustomization.yaml` and re-apply.

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Ingress answers **404 / 502** for 5–10 min after deploy | The Google LB is still being programmed and health checks are warming up. Check `kubectl -n cubetype describe ingress cubetype` until the `ingress.kubernetes.io/backends` annotation shows `HEALTHY` everywhere. BackendConfigs probe `/readyz:8080`, so a backend whose Postgres/Redis is down stays unhealthy on purpose. |
| A single backend permanently `UNHEALTHY` | `kubectl -n cubetype logs deploy/<svc>` and `curl` its `/readyz` via `kubectl port-forward`. BackendConfig changes can take minutes to sync. |
| `exec format error` | arm64 image on amd64 nodes. Build with Cloud Build or `scripts/build-push.sh` (`--platform linux/amd64`). |
| `failed calling webhook "...cnpg.io"` when applying | The CNPG operator isn't ready yet: `kubectl rollout status deployment/cnpg-controller-manager -n cnpg-system`, then re-apply. On private-node clusters, open TCP 9443 from the control plane. |
| Pods stuck `CreateContainerConfigError` | The Secret is missing: `cubetype-secrets` or `pg-app` (created by CNPG once the Cluster exists; pods recover automatically). |
| wca-import Job fails `curl: (22) … 429` | The WCA export endpoint is rate-limiting your IP. Retry later (`kubectl delete job wca-import-now` then create it again). Locally, use `scripts/kind-wca-import-tsv.sh`. |
| HPA `TARGETS <unknown>` | metrics-server missing (kind: see §3) or the container has no CPU request. |
| `kubectl drain` hangs | A PDB is blocking (by design, e.g. only one ready replica). Wait for the replacement pod, or check `kubectl get pdb -n cubetype`. Use `--delete-emptydir-data`. |
