#!/bin/bash
# Ships a release to production. Only code merged to main runs there:
#   1. the version's tag (vX.Y.Z) must be on origin/main
#   2. the images are built on Cloud Build from that tag (git archive), never from a working tree
#   3. deploy.sh copies the compose files and gateway config from the same tag and restarts
# Usage:
#   deploy/vps/release.sh            the newest release on origin/main
#   deploy/vps/release.sh 1.1.0      a given release on main (e.g. to roll back)
set -euo pipefail
cd "$(dirname "$0")/../.."
CONF="${CUBR_GCLOUD_CONFIG:-cubr}"

git fetch -q origin main --tags 2>/dev/null \
  || echo "warning: couldn't fetch origin, checking the last fetched copy of main" >&2
VERSION="${1:-$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main | sed 's/^v//')}"
TAG="v${VERSION}"
git rev-parse -q --verify "refs/tags/${TAG}^{commit}" >/dev/null || { echo "no tag ${TAG}" >&2; exit 1; }
git merge-base --is-ancestor "$TAG" origin/main \
  || { echo "${TAG} is not on main: only releases merged to main may run in production" >&2; exit 1; }

src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
git archive "$TAG" | tar -x -C "$src"
echo "building ${TAG} (from the tag) on Cloud Build"
gcloud builds submit "$src" --configuration="$CONF" --config="$src/cloudbuild.yaml" \
  --ignore-file=.dockerignore --region=australia-southeast1 --machine-type=e2-highcpu-8 \
  --substitutions="_VERSION=${VERSION}"

deploy/vps/deploy.sh "$VERSION"
