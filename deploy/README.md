# cubetype deployment

This folder holds everything needed to run cubetype outside a developer's editor:

- a **docker compose** stack for local development;
- a **kind** (Kubernetes-in-Docker) setup for testing the Kubernetes manifests locally.

Both use the same container images and the same routing table.

| Path | What it is |
|---|---|
| `../docker-compose.yml` | Full local stack: Postgres, Redis, 7 services, web and the nginx gateway (+ `jobs` profile) |
| `gateway/nginx.conf` | Compose gateway that mimics the GKE Ingress routes |
| `k8s/base/` | Environment-neutral manifests (kustomize): namespace, ConfigMap, CloudNativePG `Cluster`, Redis StatefulSet, 8 Deployments + Services |
| `k8s/overlays/local/` | kind: local `cubetype/<svc>:dev` images, nginx `gateway` (NodePort 30080 → `localhost:8090`) instead of the Ingress |
| `k8s/kind/kind-config.yaml` | kind cluster: 1 control-plane + 2 workers, port mapping 8090 → 30080 |
| `../scripts/build-local.sh` | `docker build` all images as `cubetype/<name>:dev` (`--kind` also loads them into kind) |
| `../scripts/kind-up.sh` | Repeatable local Kubernetes setup (cluster, CNPG, images, secret, deploy) |
| `../scripts/smoke.mjs` | End-to-end check through any entry point: `node scripts/smoke.mjs <baseUrl>` |

---

## 1. Architecture of the deployment

**Why it is built this way**

- **Kubernetes-native building blocks.** Each microservice is a Deployment with a ClusterIP Service. Service discovery is plain DNS (`http://solve:8080`), the same names compose uses.
- **Stateful pieces run self-managed on the cluster.** Managed Cloud SQL HA plus Memorystore would add about US$185/month.
  - **CloudNativePG** gives a primary with streaming replicas, automatic failover (`pg-rw` follows the primary), and generated credentials (`pg-app` Secret → `DATABASE_URL`).
  - **Redis** has a PVC. It is designed to be loseable: the scramble pool refills and the solve outbox re-delivers events.
- **Images.** One image per service, tagged `<version>` and built with `--build-arg APP_VERSION`. The version shows in `X-Service` and in every `_info` response.

---

## 2. Local development with docker compose

```bash
docker compose up -d --build                  # build all images and start everything
open http://localhost:8080                    # gateway: same routes as the Ingress
docker compose ps                             # all services report (healthy) via /readyz
docker compose up -d --scale solve=3          # 3 replicas behind the gateway (round-robin)
for i in $(seq 9); do curl -sI localhost:8080/api/solves/_info | grep -i x-served-by; done
docker compose --profile jobs run --rm wca-import       # downloads the WCA export (or see below)
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

This uses the kustomize manifests (`overlays/local`), with an nginx gateway instead of a cloud load balancer. It always uses a **separate kubeconfig file**, so your normal contexts are never touched.

```bash
brew install kind                                       # once
export KUBECONFIG=~/.kube/cubetype-kind.yaml            # any separate file
scripts/kind-up.sh                                      # cluster + CNPG 1.30.1 + build/load images + deploy
open http://localhost:8090                              # gateway NodePort 30080 (kind port mapping)
node scripts/smoke.mjs http://localhost:8090
```

What `kind-up.sh` does, step by step (equivalent manual commands):

```bash
kind create cluster --config deploy/k8s/kind/kind-config.yaml --kubeconfig "$KUBECONFIG"
kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.1.yaml
kubectl rollout status deployment/cnpg-controller-manager -n cnpg-system
scripts/build-local.sh --kind                      # docker build + kind load (worker nodes only)
kubectl create namespace cubetype
kubectl -n cubetype create secret generic cubetype-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)"
kubectl apply -k deploy/k8s/overlays/local
kubectl -n cubetype wait cluster/pg --for=condition=Ready --timeout=600s
```
