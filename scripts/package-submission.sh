#!/usr/bin/env bash
# Builds the Blackboard submission archive: source code + README/deployment instructions +
# proposal, without dependencies, build output or local data.
#   scripts/package-submission.sh            # -> ../Koen_Kreijkamp_s4890458_cubetype.zip
set -euo pipefail
cd "$(dirname "$0")/.."                                   # repository root
OUT="${1:-../Koen_Kreijkamp_s4890458_cubetype.zip}"       # archive path (default: next to the repo)

# Re-render the proposal PDF from its HTML source so the archive has the latest version.
#   --headless=new  no window   --no-pdf-header-footer  no URL/date in the margins
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --no-pdf-header-footer --print-to-pdf=docs/proposal/proposal.pdf docs/proposal/proposal.html 2>/dev/null || true

rm -f "$OUT"
# zip -r: recurse into folders; -x: exclude dependencies, build output, secrets and OS junk
zip -r -q "$OUT" . \
  -x '*/node_modules/*' 'node_modules/*' '*/dist/*' 'web/dist/*' '.git/*' '*.DS_Store' \
     '.env' '.env.*' 'deploy/k8s/secrets/*' 'data/*' '*.log'
echo "created $OUT ($(du -h "$OUT" | cut -f1))"
# List the top of the archive as a sanity check.
unzip -l "$OUT" | tail -1
