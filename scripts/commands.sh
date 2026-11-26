#!/usr/bin/env bash
# =============================================================================================
# cubr -- every command used to build, deploy and tear down cubr on
# Google Kubernetes Engine (GKE Standard, project cubr-app, zone australia-southeast1-a).
#
# HOW TO USE
#   This file is organised in numbered sections (0-11) that are meant to be executed IN ORDER,
#   ideally copy-pasted one command at a time from a terminal in the repository root so you
#   can watch each result. Every command has a comment above it explaining what it does and
#   what its flags/parameters mean.
#
#   A whole section can also be run non-interactively:
#       scripts/commands.sh 5          # runs section 0 (variables) + section 5
#       scripts/commands.sh list       # lists the sections
#   Every section runs unattended (section 9 waits in bounded loops).
#
# PREREQUISITES on the laptop: gcloud CLI, kubectl, openssl, curl, jq (optional: hey).
# Local alternative (no cloud): docker compose (docker-compose.yml) -- see deploy/README.md.
# =============================================================================================
set -euo pipefail                       # stop on the first error / unset variable / failed pipe stage
cd "$(dirname "$0")/.."                 # all relative paths below are relative to the repo root

# =============================================================================================
# 0. Variables (used by every section)
# =============================================================================================
PROJECT_ID="cubr-app"                   # Google Cloud project
ACCOUNT="${ACCOUNT:-$(gcloud config get-value account 2>/dev/null)}"   # Google account that owns the project (default: gcloud's active one)
REGION="australia-southeast1"           # Sydney: Artifact Registry + Cloud Build region
ZONE="australia-southeast1-a"           # zonal cluster = free GKE management fee (free tier)
CLUSTER="cubr"                          # GKE cluster name
REPO="cubr"                             # Artifact Registry Docker repository name
VERSION="1.6.74"                         # release being deployed (image tag + APP_VERSION)
NS="cubr"                               # Kubernetes namespace of the app
REGISTRY="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO"   # full image prefix, e.g. $REGISTRY/web:1.6.74
CNPG_VERSION="1.30.1"                   # CloudNativePG (PostgreSQL operator) release
DEPLOYMENTS="auth scramble solve stats leaderboard race wca web"


# Prints the public IP of the GKE Ingress (empty until Google has provisioned the load balancer).
ingress_ip() {
  # -o jsonpath: extract only the IP address field from the Ingress status
  kubectl -n "$NS" get ingress cubr -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
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
# 3. Artifact Registry repository + IAM permissions
# =============================================================================================
section_3() {
  # Create the Docker repository that will hold our images:
  #   --repository-format=docker  stores container images
  #   --location                  region (same as the cluster -> fast, free pulls)
  #   --description               free text shown in the console
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="cubr container images"

  # Look up the numeric project number (part of the default service-account e-mails).
  #   --format='value(projectNumber)'  print only that field, no table
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

  # The Compute Engine default service account: GKE nodes run as it (image pulls, logging).
  COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

  # Ask Cloud Build which service account runs our builds (new projects use the Compute
  # default SA, older ones <number>@cloudbuild.gserviceaccount.com). The value has the form
  # projects/<p>/serviceAccounts/<email>; ${VAR##*/} strips everything up to the last "/".
  BUILD_SA="$(gcloud builds get-default-service-account --format='value(serviceAccountEmail)')"
  BUILD_SA="${BUILD_SA##*/}"
  echo "nodes: $COMPUTE_SA   builds: $BUILD_SA"

  # Allow the GKE nodes to PULL images from the repository (avoids ImagePullBackOff / 403):
  #   --location  repository region     --member  who gets the role     --role  read-only access
  gcloud artifacts repositories add-iam-policy-binding "$REPO" \
    --location="$REGION" \
    --member="serviceAccount:$COMPUTE_SA" \
    --role="roles/artifactregistry.reader"

  # Minimum permissions GKE nodes need for logging/monitoring when the default SA is not an
  # Editor (common in university organisations): the "Kubernetes Engine Default Node Service
  # Account" role. --condition=None: unconditional binding.
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$COMPUTE_SA" \
    --role="roles/container.defaultNodeServiceAccount" \
    --condition=None

  # Allow Cloud Build to PUSH images into the repository (writer = read + push).
  gcloud artifacts repositories add-iam-policy-binding "$REPO" \
    --location="$REGION" \
    --member="serviceAccount:$BUILD_SA" \
    --role="roles/artifactregistry.writer"

  # Allow Cloud Build to write build logs (cloudbuild.yaml uses logging: CLOUD_LOGGING_ONLY).
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$BUILD_SA" \
    --role="roles/logging.logWriter" \
    --condition=None

  # Allow Cloud Build to read the uploaded source archive from the <project>_cloudbuild bucket.
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$BUILD_SA" \
    --role="roles/storage.objectViewer" \
    --condition=None

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
  gcloud compute addresses create cubr-ip --global --ip-version=IPV4

  # Print the reserved address (this will be the app's URL: http://<address>/).
  gcloud compute addresses describe cubr-ip --global --format='value(address)'
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

  # (Optional) kubectl plugin for `kubectl cnpg status pg -n cubr` (macOS / Homebrew).
  # brew install kubectl-cnpg
}

# =============================================================================================
# 8. Namespace + application secret (never committed to git)
# =============================================================================================
section_8() {
  # Create the namespace (dry-run renders the YAML, apply makes it idempotent on re-runs).
  #   --dry-run=client -o yaml  don't create, just print the object   | kubectl apply -f -  create/update it
  kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

  # Create Secret cubr-secrets, only if it does not exist yet (re-creating it would
  # log every user out), with two random keys:
  #   JWT_SECRET          HS256 signing key shared by all services (32 random bytes, 64 hex chars)
  #   INTERNAL_API_TOKEN  shared secret the seed Job sends as X-Internal-Token so auth skips
  #                       its per-IP register/login rate limits (24 random bytes, 48 hex chars)
  # Flags: generic = Opaque secret from literal values; --from-literal = one key=value pair.
  kubectl -n "$NS" get secret cubr-secrets >/dev/null 2>&1 || \
    kubectl -n "$NS" create secret generic cubr-secrets \
      --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
      --from-literal=INTERNAL_API_TOKEN="$(openssl rand -hex 24)"

  # (Only if the secret was created before INTERNAL_API_TOKEN existed) add the missing key in
  # place; -p = merge patch, stringData = plain text.
  # kubectl -n "$NS" patch secret cubr-secrets -p "{\"stringData\":{\"INTERNAL_API_TOKEN\":\"$(openssl rand -hex 24)\"}}"

  # Show that the secret exists (values are not printed, only key names and sizes).
  kubectl -n "$NS" describe secret cubr-secrets
}

# =============================================================================================
# 9. Deploy cubr (kustomize overlay for GKE) and wait until it is up
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

  # Record why revision 1 exists; this text appears in `kubectl rollout history`.
  #   --all        every Deployment in the namespace     --overwrite  replace an existing value
  kubectl -n "$NS" annotate deployment --all kubernetes.io/change-cause="initial release $VERSION" --overwrite

  # Overview: pods with the node they run on (-o wide), services, HPAs, PDBs, PostgreSQL.
  kubectl -n "$NS" get pods -o wide
  kubectl -n "$NS" get svc,hpa,pdb
  kubectl -n "$NS" get cluster pg

  # Wait for the load balancer in two bounded loops instead of `get ingress -w`: Ctrl+C on a
  # watch would stop this whole script, so the smoke test below would never run.
  # 1) Up to 25 min until the Ingress has its address (the static IP, once Google has created
  #    the load balancer's forwarding rule). Checked every 10 s. On a first deploy Google sets
  #    up the 8 backend services one after another (~90 s each) before the forwarding rule:
  #    the address appeared after ~17 min on this project.
  waited=0
  until [ -n "$(ingress_ip)" ]; do
    if [ "$waited" -ge 1500 ]; then
      echo "no Ingress address after 25 min: see kubectl -n $NS describe ingress cubr" >&2
      return 1
    fi
    sleep 10; waited=$((waited + 10))
  done
  kubectl -n "$NS" get ingress cubr

  # 2) Up to 10 more min until it answers: Google returns 404/502 until the backends' health
  #    checks pass (usually 5-10 min).
  #   -s  silent    -m 5  give up on a request after 5 s    -o /dev/null  discard the body
  #   -w '%{http_code}'  print only the HTTP status (000 if there was no answer)
  waited=0
  until [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$(ingress_ip)/_info")" = 200 ]; do
    if [ "$waited" -ge 600 ]; then
      echo "the load balancer still doesn't answer after 10 min: see the backends' health below" >&2
      kubectl -n "$NS" describe ingress cubr
      return 1
    fi
    sleep 10; waited=$((waited + 10))
  done

  # Per-backend health as seen by Google (annotation ingress.kubernetes.io/backends -> HEALTHY).
  kubectl -n "$NS" describe ingress cubr

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
  # image (overlays/gke/seed rewrites cubr/seed:dev to Artifact Registry).
  kubectl apply -k deploy/k8s/overlays/gke/seed

  # Follow its progress (one line per user).
  kubectl -n "$NS" logs -f job/seed

  # Verify the data arrived: global statistics and WCA metadata through the Ingress.
  curl -s "http://$(ingress_ip)/api/stats/global"; echo
  curl -s "http://$(ingress_ip)/api/wca/meta"; echo
}

# =============================================================================================
# 11. Cost control and clean-up
# =============================================================================================
section_11() {
  # `scripts/commands.sh 11` runs only the pause. The resume and delete steps further down are
  # commented out: copy-paste them one at a time.

  # --- pause (keep everything, pay only for disks / LB / registry, ~US$21/month; ~4 min) ---
  # 1) Switch the cluster autoscaler off first. Left on, it sees the Pending pods while the
  #    nodes drain and adds nodes back, and billing quietly resumes.
  #   --node-pool  the pool created with the cluster    --no-enable-autoscaling  autoscaler off
  gcloud container clusters update "$CLUSTER" --zone="$ZONE" --node-pool=default-pool \
    --no-enable-autoscaling

  # 2) Scale the app to 0 replicas. Otherwise the nodes can't drain: each Deployment's
  #    PodDisruptionBudget (minAvailable 1) blocks evicting its last pod, and once PostgreSQL is
  #    down the pods that depend on it are unready, so their PDBs allow no evictions at all.
  #    An HPA does nothing while its Deployment has 0 replicas.
  #   --all  every Deployment in the namespace    --replicas  desired number of pods
  kubectl -n "$NS" scale deployment --all --replicas=0

  # Redis too: it runs with --appendonly, so it flushes its data to its volume on shutdown.
  kubectl -n "$NS" scale statefulset redis --replicas=0

  # 3) Stop PostgreSQL cleanly: with the hibernation annotation CloudNativePG shuts every
  #    instance down and deletes its pods, but keeps the PVCs (the data).
  #   --overwrite  replace the annotation if it is already set
  kubectl -n "$NS" annotate cluster pg cnpg.io/hibernation=on --overwrite

  # Wait until the PostgreSQL pods are gone (GKE: ~20 s).
  #   --for=delete  until the pods no longer exist    -l  the cluster's pods    --timeout  give up after 5 min
  kubectl -n "$NS" wait --for=delete pod -l cnpg.io/cluster=pg --timeout=300s

  # 4) Remove all nodes (VMs stop being billed; the remaining system pods become Pending).
  #   --num-nodes  nodes in the pool    --quiet  no prompt
  gcloud container clusters resize "$CLUSTER" --zone="$ZONE" --node-pool=default-pool \
    --num-nodes=0 --quiet

  # A few minutes later, check that it stayed at zero: this must list no VMs. If one is left
  # (a node the autoscaler added just before it was switched off), run the resize again.
  #   --filter  only the cluster's node VMs (names start with gke-<cluster>-)
  gcloud compute instances list --filter="name~^gke-$CLUSTER-"

  # --- resume (~10 min) ---
  # 1) Back to 3 nodes (~1 min).
  #   --num-nodes  nodes in the pool    --quiet  no prompt
  # gcloud container clusters resize "$CLUSTER" --zone="$ZONE" --node-pool=default-pool --num-nodes=3 --quiet
  # 2) Cluster autoscaler on again, with the bounds from section 5.
  #   --enable-autoscaling  autoscaler on    --min-nodes/--max-nodes  its bounds
  # gcloud container clusters update "$CLUSTER" --zone="$ZONE" --node-pool=default-pool --enable-autoscaling --min-nodes=3 --max-nodes=5
  # 3) Wake PostgreSQL: CloudNativePG recreates the instances from their PVCs.
  #   --overwrite  replace the annotation set by the pause
  # kubectl -n "$NS" annotate cluster pg cnpg.io/hibernation=off --overwrite
  # 4) Wait until all 3 instances are ready (~2 min). Not on the Ready condition: right after
  #    waking it still shows the state from before the pause, so `--for=condition=Ready` returns
  #    at once.
  #   --for=jsonpath=...=3  until 3 instances report ready    --timeout  give up after 15 min
  # kubectl -n "$NS" wait cluster/pg --for=jsonpath='{.status.readyInstances}'=3 --timeout=900s
  # 5) Redis back to its one replica (it reloads its data from the volume), and wait for it.
  #   --replicas  desired number of pods    --timeout  give up after 5 min
  # kubectl -n "$NS" scale statefulset redis --replicas=1
  # kubectl -n "$NS" rollout status statefulset/redis --timeout=300s
  # 6) Every Deployment back to 2 replicas. Re-applying the overlay (section 9) would not do it:
  #    the HPA-managed Deployments (race, scramble, solve, web) have no replicas field.
  #   --all  every Deployment in the namespace    --replicas  desired number of pods (HPA minimum)
  # kubectl -n "$NS" scale deployment --all --replicas=2
  # 7) Wait until every Deployment is READY 2/2 (~1 min), then run the smoke test from section 9.
  #   --timeout  give up on a Deployment after 5 min
  # for d in $DEPLOYMENTS; do kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s; done
  # node scripts/smoke.mjs "http://$(ingress_ip)"
  # 8) The HPAs show "cpu: <unknown>" for a few minutes until metrics-server has fresh samples.
  #    Wait for real percentages before relying on autoscaling.
  # kubectl -n "$NS" get hpa

  # --- delete everything ---
  # 1) Delete the app namespace first: removes the Ingress (-> Google deletes the load
  #    balancer and NEGs) and the PVCs (-> the persistent disks are deleted).
  #   --timeout  give up waiting after 10 min
  # kubectl delete namespace "$NS" --timeout=600s
  # 2) Delete the cluster (all node VMs and their boot disks). --quiet: no prompt.
  # gcloud container clusters delete "$CLUSTER" --zone="$ZONE" --quiet
  # 3) Release the static IP (a reserved but unused address is billed).
  #   --global  the IP is a global address (section 6)
  # gcloud compute addresses delete cubr-ip --global --quiet
  # 4) Delete the image repository (storage billed per GB).
  #   --location  the repository's region
  # gcloud artifacts repositories delete "$REPO" --location="$REGION" --quiet
  # 5) Check that nothing billable is left behind: orphaned disks (name pvc-...) and LB rules.
  # gcloud compute disks list
  # gcloud compute forwarding-rules list
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
  [1-9]|1[01]) "section_$1" ;;
  *) echo "unknown section '$1'" >&2; usage; exit 1 ;;
esac
