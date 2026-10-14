#!/usr/bin/env bash
# =============================================================================================
# Build cubetype container images on this machine (native architecture) and optionally copy
# them into the local kind cluster.
#
#   scripts/build-local.sh                         # build every image that has a Dockerfile -> cubetype/<name>:dev
#   scripts/build-local.sh web solve               # build only these images
#   scripts/build-local.sh --kind                  # build all, then `kind load` them into the kind cluster
#   TAG=1.1.0 scripts/build-local.sh --kind web    # build cubetype/web:1.1.0 (APP_VERSION=1.1.0) for the rollout demo
#
# Environment:
#   TAG           image tag (default dev)
#   APP_VERSION   version baked into the image, shown by /_info and X-Service (default = TAG)
#   KIND_CLUSTER  kind cluster name (default cubetype)
#
# Images whose Dockerfile is missing are skipped with a warning.
# =============================================================================================
set -euo pipefail

# Run from the repository root: every Dockerfile uses the repo root as its build context.
cd "$(dirname "$0")/.."

TAG="${TAG:-dev}"
APP_VERSION="${APP_VERSION:-$TAG}"
KIND_CLUSTER="${KIND_CLUSTER:-cubetype}"
ALL_IMAGES="auth scramble solve stats leaderboard race wca web wca-import"

LOAD_KIND=0
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --kind) LOAD_KIND=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) TARGETS+=("$arg") ;;
  esac
done
# No names given -> build everything.
if [ ${#TARGETS[@]} -eq 0 ]; then
  read -r -a TARGETS <<<"$ALL_IMAGES"
fi

# Maps an image name to its Dockerfile (services/<name>, jobs/<name> or web).
dockerfile_for() {
  case "$1" in
    web) echo "web/Dockerfile" ;;
    wca-import|seed) echo "jobs/$1/Dockerfile" ;;
    *) echo "services/$1/Dockerfile" ;;
  esac
}

BUILT=()
for name in "${TARGETS[@]}"; do
  dockerfile="$(dockerfile_for "$name")"
  if [ ! -f "$dockerfile" ]; then
    echo "!! skipping $name: $dockerfile missing" >&2
    continue
  fi
  echo "==> building cubetype/$name:$TAG (APP_VERSION=$APP_VERSION)"
  # docker build flags:
  #   -f                 which Dockerfile to use (context is always the repo root ".")
  #   --build-arg        bakes APP_VERSION into the image (ENV APP_VERSION in every Dockerfile)
  #   --provenance=false no attestation manifest -> a plain single-platform image that
  #                      `kind load docker-image` can import (Docker Desktop containerd store)
  #   -t                 the local tag the kind overlay (and docker-compose.yml) expects
  docker build -f "$dockerfile" \
    --build-arg "APP_VERSION=$APP_VERSION" \
    --provenance=false \
    -t "cubetype/$name:$TAG" .
  BUILT+=("cubetype/$name:$TAG")
done

if [ "$LOAD_KIND" -eq 1 ] && [ ${#BUILT[@]} -gt 0 ]; then
  # Only the worker nodes run application pods (the control-plane is tainted NoSchedule), so
  # copying the images there only saves time and disk space.
  workers="$(kind get nodes --name "$KIND_CLUSTER" | grep -v control-plane | paste -sd, -)"
  for image in "${BUILT[@]}"; do
    echo "==> kind load $image -> $workers"
    # kind load docker-image: copies an image from the local Docker engine into the kind
    # nodes' containerd, so pods with imagePullPolicy IfNotPresent start without a registry.
    #   --name   kind cluster name     --nodes   comma-separated node list (workers only)
    kind load docker-image "$image" --name "$KIND_CLUSTER" --nodes "$workers"
  done
fi

echo "done: ${BUILT[*]:-nothing built}"
