#!/usr/bin/env bash
# =============================================================================================
# Local Kubernetes for cubetype: creates (or reuses) a kind cluster and deploys the full stack
# with the kustomize manifests (deploy/k8s/overlays/local). Idempotent -- safe to re-run.
#
#   scripts/kind-up.sh                 # cluster + operators + build/load images + deploy
#   SKIP_BUILD=1 scripts/kind-up.sh    # images already loaded, just (re)deploy
#   open http://localhost:8090         # gateway NodePort 30080 mapped by the kind config
#
# Environment:
#   KUBECONFIG    kubeconfig file to use/write (default ~/.kube/cubetype-kind.yaml -- a separate
#                 file, so your normal ~/.kube/config contexts are never touched)
#   KIND_CLUSTER  cluster name (default cubetype)
#   NODE_IMAGE    optional kind node image (Kubernetes version), e.g. kindest/node:v1.36.4
#   SKIP_BUILD=1  don't build/load images
# =============================================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/cubetype-kind.yaml}"
KIND_CLUSTER="${KIND_CLUSTER:-cubetype}"
CNPG_VERSION="1.30.1"
METRICS_SERVER_VERSION="v0.8.0"
NS="cubetype"
echo "KUBECONFIG=$KUBECONFIG"

# 1. Cluster: 1 control-plane + 2 workers, NodePort 30080 -> localhost:8090 (kind-config.yaml).
if ! kind get clusters | grep -qx "$KIND_CLUSTER"; then
  # kind create cluster flags:
  #   --config      node layout + port mapping     --kubeconfig  where to write credentials
  #   --image       (optional) Kubernetes version of the nodes     --wait  until the API is Ready
  kind create cluster --name "$KIND_CLUSTER" \
    --config deploy/k8s/kind/kind-config.yaml \
    --kubeconfig "$KUBECONFIG" \
    ${NODE_IMAGE:+--image "$NODE_IMAGE"} \
    --wait 120s
fi

# 2. CloudNativePG operator (server-side apply: the CRDs are too big for client-side apply).
kubectl apply --server-side -f \
  "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-${CNPG_VERSION%.*}/releases/cnpg-${CNPG_VERSION}.yaml" >/dev/null
# Wait until the operator (and its validating webhook) is ready to accept Cluster objects.
kubectl rollout status deployment/cnpg-controller-manager -n cnpg-system --timeout=300s

# 3. metrics-server (kind does not ship it) so HPAs and `kubectl top` work.
kubectl apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER_VERSION}/components.yaml" >/dev/null
# kind's kubelets use self-signed certificates -> add --kubelet-insecure-tls once (JSON patch
# appends to the container's args; skipped if the flag is already there).
if ! kubectl -n kube-system get deployment metrics-server -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q kubelet-insecure-tls; then
  kubectl -n kube-system patch deployment metrics-server --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
fi
kubectl -n kube-system rollout status deployment/metrics-server --timeout=180s

# 4. Images: build cubetype/<svc>:dev locally and copy them into the kind worker nodes.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  KIND_CLUSTER="$KIND_CLUSTER" scripts/build-local.sh --kind
fi

# 5. Namespace + Secret (random JWT key and internal token; kept if it already exists).
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" get secret cubetype-secrets >/dev/null 2>&1 || \
  kubectl -n "$NS" create secret generic cubetype-secrets \
    --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
    --from-literal=INTERNAL_API_TOKEN="$(openssl rand -hex 24)"

# 6. Deploy the local overlay and wait for PostgreSQL, Redis and every Deployment.
kubectl apply -k deploy/k8s/overlays/local
kubectl -n "$NS" wait cluster/pg --for=condition=Ready --timeout=600s
kubectl -n "$NS" rollout status statefulset/redis --timeout=300s
for d in auth scramble solve stats leaderboard race wca web gateway; do
  kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s
done
kubectl -n "$NS" get pods -o wide

cat <<EOF

cubetype is running on kind: http://localhost:8090
  load WCA data : kubectl -n $NS create job --from=cronjob/wca-import wca-import-now
                  (or offline from unzipped TSVs: scripts/kind-wca-import-tsv.sh <tsv-dir>)
  seed users    : kubectl apply -k deploy/k8s/overlays/local/seed
  smoke test    : node scripts/smoke.mjs http://localhost:8090
  kubectl       : export KUBECONFIG=$KUBECONFIG
EOF
