#!/usr/bin/env bash
# Builds the Blackboard submission archive from the last commit: source code and tests,
# Dockerfiles, deployment manifests and scripts, README/deployment instructions.
# Left out: the proposal (submitted on its own), git metadata (.git, the .github CI workflow,
# .githooks), and - because git archive only takes committed files - dependencies, build output,
# local data and OS junk. .gitignore stays: `gcloud builds submit` reads it to skip node_modules.
#   scripts/package-submission.sh            # -> ../Koen_Kreijkamp_s4890458_cubetype.zip
set -euo pipefail
cd "$(dirname "$0")/.."                                   # repository root
OUT="${1:-../Koen_Kreijkamp_s4890458_cubetype.zip}"       # archive path (default: next to the repo)

# Only committed files go into the archive, so refuse to run with uncommitted changes.
#   --porcelain  stable, script-friendly output: empty when the working tree is clean
if [ -n "$(git status --porcelain)" ]; then
  echo "commit (or stash) your changes first: the archive is built from the last commit" >&2
  exit 1
fi

# The files of the last commit as a zip.
#   --format=zip        zip instead of tar            --prefix=cubetype/  one top-level folder
#   -o "$OUT"           write the archive here        HEAD                the last commit
#   ':!<path>'          pathspecs that leave a path out of the archive
rm -f "$OUT"
git archive --format=zip --prefix=cubetype/ -o "$OUT" HEAD -- . \
  ':!docs/proposal' ':!.github' ':!.githooks'
echo "created $OUT ($(du -h "$OUT" | cut -f1)) from $(git log -1 --format='%h %s')"
# Sanity check: the last line of the listing gives the total file count and size.
unzip -l "$OUT" | tail -1
