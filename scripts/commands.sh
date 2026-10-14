#!/usr/bin/env bash
# =============================================================================================
# cubetype -- every command used to build, deploy, demonstrate and tear down cubetype on
# Google Kubernetes Engine (GKE Standard, project infs3208-a2-koen, zone australia-southeast1-a).
#
# HOW TO USE
#   This file is organised in numbered sections (0-10) that are meant to be executed IN ORDER,
#   ideally copy-pasted one command at a time from a terminal in the repository root so you
#   can watch each result. Every command has a comment above it explaining what it does and
#   what its flags/parameters mean.
#
#   A whole section can also be run non-interactively:
#       scripts/commands.sh 5          # runs section 0 (variables) + section 5
#       scripts/commands.sh list       # lists the sections
#
# PREREQUISITES on the laptop: gcloud CLI, kubectl, openssl, curl, node.
# Local alternatives (no cloud): docker compose (docker-compose.yml) and kind
# (scripts/kind-up.sh) -- see deploy/README.md.
# =============================================================================================
set -euo pipefail                       # stop on the first error / unset variable / failed pipe stage
cd "$(dirname "$0")/.."                 # all relative paths below are relative to the repo root

# =============================================================================================
# 0. Variables (used by every section)
# =============================================================================================
PROJECT_ID="infs3208-a2-koen"           # Google Cloud project
ACCOUNT="koen@mangotree.info"           # Google account that owns / is Owner of the project
REGION="australia-southeast1"           # Sydney: Artifact Registry + Cloud Build region
ZONE="australia-southeast1-a"           # zonal cluster = free GKE management fee (free tier)
CLUSTER="cubetype"                      # GKE cluster name
REPO="cubetype"                         # Artifact Registry Docker repository name
VERSION="1.0.0"                         # release being deployed (image tag + APP_VERSION)
NS="cubetype"                           # Kubernetes namespace of the app
REGISTRY="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO"   # full image prefix, e.g. $REGISTRY/web:1.0.0
CNPG_VERSION="1.30.1"                   # CloudNativePG (PostgreSQL operator) release
DEPLOYMENTS="auth scramble solve stats leaderboard race wca web"

# Prints the public IP of the GKE Ingress (empty until Google has provisioned the load balancer).
ingress_ip() {
  # -o jsonpath: extract only the IP address field from the Ingress status
  kubectl -n "$NS" get ingress cubetype -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
}

# =============================================================================================
# 1. gcloud: select the right account and project
# =============================================================================================
section_1() {
  # List the Google accounts gcloud has credentials for; the active one is marked with *.
  gcloud auth list

  # (Only if the account is missing or its token expired) log in through the browser.
  # gcloud auth login "$ACCOUNT"

  # Make $ACCOUNT the account used by all following gcloud commands.
  gcloud config set account "$ACCOUNT"

  # Set the default project so --project=... can be omitted from every command.
  gcloud config set project "$PROJECT_ID"

  # Default region (Cloud Build, Artifact Registry) and zone (cluster, disks) for gcloud.
  gcloud config set compute/region "$REGION"
  gcloud config set compute/zone "$ZONE"

  # Show the resulting configuration (account, project, region, zone) to double-check.
  gcloud config list
}

# =============================================================================================
# 2. Enable the Google Cloud APIs we use
# =============================================================================================
section_2() {
  # Turn on the APIs (idempotent, takes ~1 min the first time):
  #   container.googleapis.com         Google Kubernetes Engine
  #   artifactregistry.googleapis.com  Docker image registry
  #   cloudbuild.googleapis.com        remote image builds
  #   compute.googleapis.com           VMs, disks, load balancer, static IP
  gcloud services enable \
    container.googleapis.com \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    compute.googleapis.com

  # Verify: list enabled services and keep only the four we need.
  gcloud services list --enabled | grep -E 'container|artifactregistry|cloudbuild|compute'
}

# =============================================================================================
# 3. Artifact Registry repository
# =============================================================================================
section_3() {
  # Create the Docker repository that will hold our images:
  #   --repository-format=docker  stores container images
  #   --location                  region (same as the cluster -> fast, free pulls)
  #   --description               free text shown in the console
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="cubetype container images (INFS3208)"

  # (Optional, only for scripts/build-push.sh from the laptop) let `docker push` authenticate
  # to the regional registry host with your gcloud credentials.
  # gcloud auth configure-docker "$REGION-docker.pkg.dev"
}

# =============================================================================================
# 4. Build all images with Cloud Build and push them to Artifact Registry
# =============================================================================================
section_4() {
  # Upload the source (honours .gitignore: node_modules/dist are skipped) and run
  # cloudbuild.yaml, which builds the 10 images in parallel on amd64 machines and pushes them:
  #   --region         run the build in Sydney (next to the registry)
  #   --config         the build definition (repo root)
  #   --substitutions  values for ${_VERSION} (tag + APP_VERSION), ${_REGION}, ${_REPO}
  #   .                the build context = repository root
  gcloud builds submit \
    --region="$REGION" \
    --config=cloudbuild.yaml \
    --substitutions="_VERSION=$VERSION,_REGION=$REGION,_REPO=$REPO" \
    .

  # List the images now in the repository, with their tags (should show 10 x :$VERSION).
  #   --include-tags  show tags next to the digests
  gcloud artifacts docker images list "$REGISTRY" --include-tags

  # Alternative without Cloud Build (cross-compiles for linux/amd64 on the laptop and pushes):
  # VERSION="$VERSION" scripts/build-push.sh
}

# =============================================================================================
# 5. Create the GKE Standard cluster and connect kubectl to it
# =============================================================================================
section_5() {
  # Create a zonal GKE Standard cluster:
  #   --zone                  single zone (fee covered by the GKE free tier; zonal PDs)
  #   --release-channel       "regular": Google-managed, tested Kubernetes upgrades
  #   --machine-type          e2-standard-2 = 2 vCPU / 8 GB per node (fits 8 services x 2
  #                           replicas + 3 PostgreSQL instances + HPA headroom)
  #   --num-nodes             3 nodes to start with (one PostgreSQL instance per node)
  #   --enable-autoscaling    cluster autoscaler adds nodes when pods are Pending (HPA scale-out)
  #   --min-nodes/--max-nodes autoscaler bounds (per zone)
  #   --disk-type/--disk-size 30 GB pd-balanced boot disks (default would be 100 GB)
  #   --enable-ip-alias       VPC-native networking -> container-native load balancing (NEGs)
  gcloud container clusters create "$CLUSTER" \
    --zone="$ZONE" \
    --release-channel=regular \
    --machine-type=e2-standard-2 \
    --num-nodes=3 \
    --enable-autoscaling --min-nodes=3 --max-nodes=5 \
    --disk-type=pd-balanced --disk-size=30 \
    --enable-ip-alias

  # Install the kubectl authentication plugin GKE requires (skip if already installed).
  # gcloud components install gke-gcloud-auth-plugin

  # Write the cluster's endpoint + credentials into ~/.kube/config and make it the current
  # kubectl context (gke_<project>_<zone>_<cluster>).
  gcloud container clusters get-credentials "$CLUSTER" --zone="$ZONE"

  # Confirm the 3 nodes are Ready (-o wide adds internal/external IPs and versions).
  kubectl get nodes -o wide
}

# =============================================================================================
# 6. Reserve a static global IP for the Ingress
# =============================================================================================
section_6() {
  # Reserve a permanent public IPv4 address for the load balancer, so the URL survives
  # re-deployments. --global: GKE Ingress creates a GLOBAL external Application Load Balancer.
  # The Ingress refers to it by name (annotation kubernetes.io/ingress.global-static-ip-name).
  gcloud compute addresses create cubetype-ip --global --ip-version=IPV4

  # Print the reserved address (this will be the app's URL: http://<address>/).
  gcloud compute addresses describe cubetype-ip --global --format='value(address)'
}

# =============================================================================================
# 7. Install the CloudNativePG operator (manages the PostgreSQL cluster)
# =============================================================================================
section_7() {
  # Install the operator (CRDs, RBAC, webhooks, controller Deployment in namespace cnpg-system):
  #   --server-side  server-side apply: required because the CRDs are too large for the
  #                  last-applied-configuration annotation of client-side apply
  #   -f <url>       the official release manifest for version $CNPG_VERSION
  kubectl apply --server-side -f \
    "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-${CNPG_VERSION%.*}/releases/cnpg-${CNPG_VERSION}.yaml"

  # Wait until the operator's controller (and its admission webhook) is running, otherwise
  # creating the Cluster object in section 9 would be rejected. --timeout: give up after 5 min.
  kubectl rollout status deployment/cnpg-controller-manager -n cnpg-system --timeout=300s

  # Verify the new resource type exists (Cluster = postgresql.cnpg.io/v1).
  kubectl get crd clusters.postgresql.cnpg.io

  # (Optional) kubectl plugin for `kubectl cnpg status pg -n cubetype` (macOS / Homebrew).
  # brew install kubectl-cnpg
}

# =============================================================================================
# 8. Namespace + application secret (never committed to git)
# =============================================================================================
section_8() {
  # Create the namespace (dry-run renders the YAML, apply makes it idempotent on re-runs).
  #   --dry-run=client -o yaml  don't create, just print the object   | kubectl apply -f -  create/update it
  kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

  # Create Secret cubetype-secrets, only if it does not exist yet (re-creating it would
  # log every user out), with two random keys:
  #   JWT_SECRET          HS256 signing key shared by all services (32 random bytes, 64 hex chars)
  #   INTERNAL_API_TOKEN  shared secret the seed Job sends as X-Internal-Token so auth skips
  #                       its per-IP register/login rate limits (24 random bytes, 48 hex chars)
  # Flags: generic = Opaque secret from literal values; --from-literal = one key=value pair.
  kubectl -n "$NS" get secret cubetype-secrets >/dev/null 2>&1 || \
    kubectl -n "$NS" create secret generic cubetype-secrets \
      --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
      --from-literal=INTERNAL_API_TOKEN="$(openssl rand -hex 24)"

  # (Only if the secret was created before INTERNAL_API_TOKEN existed) add the missing key in
  # place; -p = merge patch, stringData = plain text.
  # kubectl -n "$NS" patch secret cubetype-secrets -p "{\"stringData\":{\"INTERNAL_API_TOKEN\":\"$(openssl rand -hex 24)\"}}"

  # Show that the secret exists (values are not printed, only key names and sizes).
  kubectl -n "$NS" describe secret cubetype-secrets
}

# =============================================================================================
# 9. Deploy cubetype (kustomize overlay for GKE) and wait until it is up
# =============================================================================================
section_9() {
  # Render deploy/k8s/overlays/gke (base + Artifact Registry images + Ingress + BackendConfigs
  # + NEG annotations + standard-rwo storage) and create/update every object in it.
  #   -k  use kustomize (directory with kustomization.yaml) instead of plain files
  kubectl apply -k deploy/k8s/overlays/gke

  # Wait for PostgreSQL: the operator bootstraps pg-1 (primary), then clones pg-2/pg-3.
  #   --for=condition=Ready  the Cluster reports all instances healthy   --timeout  max wait
  kubectl -n "$NS" wait cluster/pg --for=condition=Ready --timeout=900s

  # Wait for Redis (StatefulSet with its persistent volume).
  kubectl -n "$NS" rollout status statefulset/redis --timeout=300s

  # Wait for every microservice Deployment to have all replicas ready.
  for d in $DEPLOYMENTS; do
    kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s
  done

  # Record why revision 1 exists; this text appears in `kubectl rollout history` (section 14).
  #   --all        every Deployment in the namespace     --overwrite  replace an existing value
  kubectl -n "$NS" annotate deployment --all kubernetes.io/change-cause="initial release $VERSION" --overwrite

  # Overview: pods with the node they run on (-o wide), services, HPAs, PDBs, PostgreSQL.
  kubectl -n "$NS" get pods -o wide
  kubectl -n "$NS" get svc,hpa,pdb
  kubectl -n "$NS" get cluster pg

  # Watch the Ingress until the ADDRESS column shows the static IP (Ctrl+C to stop).
  # The load balancer + health checks need ~5-10 minutes; until then expect 404/502.
  #   -w  watch: print a new line on every change
  kubectl -n "$NS" get ingress cubetype -w || true

  # Per-backend health as seen by Google (annotation ingress.kubernetes.io/backends -> HEALTHY).
  kubectl -n "$NS" describe ingress cubetype

  # Smoke test through the public entry point: SPA info and one API.
  curl -s "http://$(ingress_ip)/_info"; echo
  curl -s "http://$(ingress_ip)/api/scrambles/333?count=1"; echo

  # Full end-to-end check of every microservice through the Ingress.
  node scripts/smoke.mjs "http://$(ingress_ip)"
}

# =============================================================================================
# 10. Load data: WCA results (CronJob run now) + demo users and solves (seed Job)
# =============================================================================================
section_10() {
  # Start the weekly wca-import CronJob immediately as a one-off Job:
  #   --from=cronjob/wca-import  copy the CronJob's job template      wca-import-now  Job name
  kubectl -n "$NS" create job --from=cronjob/wca-import wca-import-now

  # Follow the importer's log (download -> staging schema -> indexes -> atomic swap).
  #   -f  stream until the pod exits      job/<name>  pick the Job's pod automatically
  kubectl -n "$NS" logs -f job/wca-import-now

  # Block until the Job reports Complete (fails after 30 min).
  kubectl -n "$NS" wait --for=condition=complete job/wca-import-now --timeout=1800s

  # Create the seed Job (150 users + ~100k solves through the public APIs), using the GKE
  # image (overlays/gke/seed rewrites cubetype/seed:dev to Artifact Registry).
  kubectl apply -k deploy/k8s/overlays/gke/seed

  # Follow its progress (one line per user).
  kubectl -n "$NS" logs -f job/seed

  # Verify the data arrived: global statistics and WCA metadata through the Ingress.
  curl -s "http://$(ingress_ip)/api/stats/global"; echo
  curl -s "http://$(ingress_ip)/api/wca/meta"; echo
}

# ---------------------------------------------------------------------------------------------
# Section runner: `scripts/commands.sh <n>` runs one section; `scripts/commands.sh list` lists them.
# ---------------------------------------------------------------------------------------------
usage() {
  # Print the section titles (lines like "# 7. Install ..." directly under a ==== line).
  grep -E '^# [0-9]+\. ' "$0"
}

case "${1:-list}" in
  list|-h|--help) usage ;;
  0) echo "variables: PROJECT_ID=$PROJECT_ID ZONE=$ZONE CLUSTER=$CLUSTER REGISTRY=$REGISTRY VERSION=$VERSION" ;;
  [1-9]|10) "section_$1" ;;
  *) echo "unknown section '$1'" >&2; usage; exit 1 ;;
esac
