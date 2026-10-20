#!/usr/bin/env bash
# =============================================================================================
# Alternative to Cloud Build (scripts/commands.sh §4): build the images on this laptop for
# linux/amd64 (GKE e2 nodes are x86-64; Apple Silicon builds arm64 by default, which would
# crash on GKE with "exec format error") and push them straight to Artifact Registry.
# Slower than Cloud Build for npm steps under emulation, but handy for a quick single-image fix.
#
#   scripts/build-push.sh                    # all images, tag $VERSION (default 1.0.7)
#   VERSION=1.1.0 scripts/build-push.sh web  # only web:1.1.0 (rollout demo)
#
# Prerequisite (once): gcloud auth configure-docker australia-southeast1-docker.pkg.dev
# =============================================================================================
set -euo pipefail
cd "$(dirname "$0")/.."                      # build context = repo root

PROJECT_ID="${PROJECT_ID:-infs3208-a2-koen}"
REGION="${REGION:-australia-southeast1}"
REPO="${REPO:-cubetype}"
VERSION="${VERSION:-1.0.7}"
REGISTRY="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO"
ALL_IMAGES="auth scramble solve stats leaderboard race wca web wca-import seed"

TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
  read -r -a TARGETS <<<"$ALL_IMAGES"
fi

dockerfile_for() {
  case "$1" in
    web) echo "web/Dockerfile" ;;
    wca-import|seed) echo "jobs/$1/Dockerfile" ;;
    *) echo "services/$1/Dockerfile" ;;
  esac
}

for name in "${TARGETS[@]}"; do
  dockerfile="$(dockerfile_for "$name")"
  [ -f "$dockerfile" ] || { echo "!! skipping $name: $dockerfile missing" >&2; continue; }
  echo "==> $REGISTRY/$name:$VERSION"
  # docker buildx build flags:
  #   --platform linux/amd64  target CPU architecture of the GKE nodes (cross-build via QEMU;
  #                           the Dockerfiles run npm/esbuild on $BUILDPLATFORM natively)
  #   -f                      the Dockerfile; "." (repo root) is the build context
  #   --build-arg             APP_VERSION baked into the image (/_info, X-Service header)
  #   -t                      Artifact Registry name: <region>-docker.pkg.dev/<project>/<repo>/<image>:<tag>
  #   --push                  upload to the registry directly (no local copy is kept)
  docker buildx build --platform linux/amd64 \
    -f "$dockerfile" \
    --build-arg "APP_VERSION=$VERSION" \
    -t "$REGISTRY/$name:$VERSION" \
    --push .
done
