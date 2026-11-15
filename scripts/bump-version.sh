#!/usr/bin/env bash
# =============================================================================================
# The release version of cubr, kept in step across every file that names it: the image tags
# in the GKE overlays, VERSION in scripts/commands.sh, the defaults in cloudbuild.yaml and
# scripts/build-push.sh, and the deployment table in deploy/README.md.
#
#   scripts/bump-version.sh                   # next patch version, e.g. 1.0.2 -> 1.0.3
#   scripts/bump-version.sh minor             # 1.0.2 -> 1.1.0   (major: 1.0.2 -> 2.0.0)
#   scripts/bump-version.sh 1.2.0             # a given version (must be above the highest tag)
#   scripts/bump-version.sh --current         # print the version the files name
#   scripts/bump-version.sh --check [vX.Y.Z]  # fail unless the files name one version (= the tag)
#
# Every commit gets its own version: .githooks/pre-commit bumps the patch version (unless the
# commit already carries a new one) and .githooks/post-commit tags the commit vX.Y.Z. Enable the
# hooks once per clone:  git config core.hooksPath .githooks
# A new version is always above the highest tag, so a tag is never reused or moved: images are
# pulled IfNotPresent, and new code pushed under an existing tag would never roll out.
# =============================================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(
  deploy/k8s/overlays/gke/kustomization.yaml
  deploy/k8s/overlays/gke/seed/kustomization.yaml
  scripts/commands.sh
  cloudbuild.yaml
  scripts/build-push.sh
  deploy/README.md
)

# Every version the files name, one per line, without duplicates.
# shellcheck disable=SC2016 # the ${ and backticks below are literal text in the sed patterns
versions() {
  {
    sed -n 's/^ *newTag: "\(.*\)"$/\1/p' deploy/k8s/overlays/gke/kustomization.yaml deploy/k8s/overlays/gke/seed/kustomization.yaml
    sed -n 's/^VERSION="\([^"]*\)".*/\1/p' scripts/commands.sh
    sed -n 's/^  _VERSION: \(.*\)$/\1/p' cloudbuild.yaml
    sed -n 's/^VERSION="${VERSION:-\(.*\)}"$/\1/p' scripts/build-push.sh
    sed -n 's/.*`VERSION=\([0-9][^`]*\)`.*/\1/p' deploy/README.md
  } | sort -u
}

# The one version all files name; fails when they disagree.
current() {
  local v
  v="$(versions)"
  if [ -z "$v" ] || [ "$(printf '%s\n' "$v" | wc -l)" -ne 1 ]; then
    echo "bump-version: the deploy files name different versions: $(printf '%s\n' "$v" | paste -sd' ' -)" >&2
    return 1
  fi
  echo "$v"
}

# Highest vX.Y.Z tag without the "v" (empty when there is none).
highest_tag() {
  git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | sed -n '1s/^v//p'
}

# version_gt A B: true when version A is above version B (X.Y.Z, compared field by field).
version_gt() {
  local -a a b
  local i
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    if [ "${a[i]:-0}" -gt "${b[i]:-0}" ]; then return 0; fi
    if [ "${a[i]:-0}" -lt "${b[i]:-0}" ]; then return 1; fi
  done
  return 1
}

# The next patch/minor/major version above both the files' version and the highest tag.
next() {
  local base top major minor patch
  base="$(current)"
  top="$(highest_tag)"
  if [ -n "$top" ] && version_gt "$top" "$base"; then base="$top"; fi
  IFS=. read -r major minor patch <<<"$base"
  case "$1" in
    patch) echo "$major.$minor.$((patch + 1))" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    major) echo "$((major + 1)).0.0" ;;
  esac
}

# Rewrites version $1 to $2 in every place the files name it (the rollout demo's 1.1.0 and
# 9.9.9-broken in scripts/commands.sh and deploy/README.md are left alone).
write() {
  OLD="$1" NEW="$2" perl -pi -e '
    BEGIN { $o = quotemeta $ENV{OLD}; $n = $ENV{NEW} }
    s{^(\s*newTag: ")$o(")}{$1$n$2};
    s{^(VERSION=")$o(")}{$1$n$2};
    s{^(VERSION="\$\{VERSION:-)$o(\}")}{$1$n$2};
    s{^(  _VERSION: )$o(?=\s)}{$1$n};
    s{(--substitutions[= ]_VERSION=)$o(?=[ ,])}{$1$n};
    s{(\$REGISTRY/web:)$o(?=\s)}{$1$n};
    s{(\(default )$o(\))}{$1$n$2};
    s{(`VERSION=)$o(`)}{$1$n$2};
  ' "${FILES[@]}"
  current >/dev/null # all files must now name the new version
}

# CI: every file names one version, and on a tag push that version is the tag.
check() {
  local v
  v="$(current)"
  if [ -n "${1:-}" ] && [ "v$v" != "$1" ]; then
    echo "bump-version: tag $1, but the deploy files name $v" >&2
    exit 1
  fi
  echo "the deploy files name $v${1:+ (= tag $1)}"
}

# .githooks/pre-commit: give the commit the next patch version unless it already carries a
# version above the highest tag (a manual minor/major bump, or a commit that was aborted).
pre_commit() {
  local cur top new
  # `git add` below would sweep unstaged edits of these files into the commit: refuse instead.
  if ! git diff --quiet -- "${FILES[@]}"; then
    echo "pre-commit: stage or stash your changes to these files first:" >&2
    git diff --name-only -- "${FILES[@]}" >&2
    exit 1
  fi
  cur="$(current)"
  top="$(highest_tag)"
  if [ -z "$top" ] || version_gt "$cur" "$top"; then
    echo "pre-commit: version $cur"
    return
  fi
  new="$(next patch)"
  write "$cur" "$new"
  git add -- "${FILES[@]}"
  echo "pre-commit: version $cur -> $new"
}

case "${1:-patch}" in
  --current) current ;;
  --check) check "${2:-}" ;;
  --pre-commit) pre_commit ;;
  patch | minor | major)
    cur="$(current)"
    new="$(next "${1:-patch}")"
    write "$cur" "$new"
    echo "$cur -> $new"
    ;;
  *)
    if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      cur="$(current)"
      top="$(highest_tag)"
      if [ -n "$top" ] && ! version_gt "$1" "$top"; then
        echo "bump-version: $1 is not above the highest tag v$top" >&2
        exit 1
      fi
      write "$cur" "$1"
      echo "$cur -> $1"
    else
      sed -n '2,18p' "$0"
      exit 1
    fi
    ;;
esac
