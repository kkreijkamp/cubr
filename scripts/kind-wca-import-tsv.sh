#!/usr/bin/env bash
# =============================================================================================
# Offline WCA import into the kind cluster from an already-unzipped export folder (the
# WCA_export_*.tsv files + metadata.json). Use it when the WCA download endpoint rate-limits
# you (HTTP 429) or you have no internet; the normal path is the CronJob:
#   kubectl -n cubetype create job --from=cronjob/wca-import wca-import-now
#
#   scripts/kind-wca-import-tsv.sh ./data/wca/tsv
#
# How: start a temporary pod from the wca-import image (sleeping), copy metadata.json and the
# seven TSVs the importer loads into its emptyDir with `kubectl cp` (a fully unzipped export is
# ~1.7 GB, most of it tables we don't use), run the importer inside it (WCA_TSV_DIR), delete the pod.
#
# Environment: KUBECONFIG (default ~/.kube/cubetype-kind.yaml, the file scripts/kind-up.sh writes)
# =============================================================================================
set -euo pipefail
TSV_DIR="${1:?usage: $0 <folder with WCA_export_*.tsv>}"
NS="cubetype"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/cubetype-kind.yaml}"
TABLES="continents countries events persons competitions ranks_single ranks_average"
[ -f "$TSV_DIR/metadata.json" ] || { echo "$TSV_DIR has no metadata.json" >&2; exit 1; }
for t in $TABLES; do
  [ -f "$TSV_DIR/WCA_export_$t.tsv" ] || { echo "$TSV_DIR has no WCA_export_$t.tsv" >&2; exit 1; }
done

# Create the helper pod: same image, user and DATABASE_URL (Secret pg-app) as the CronJob.
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: wca-import-tsv
  namespace: $NS
  labels: { app.kubernetes.io/name: wca-import, app.kubernetes.io/part-of: cubetype }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 70, runAsGroup: 70, fsGroup: 70 }
  containers:
    - name: wca-import
      image: cubetype/wca-import:dev
      imagePullPolicy: IfNotPresent
      command: ["sleep", "3600"]
      env:
        - name: DATABASE_URL
          valueFrom: { secretKeyRef: { name: pg-app, key: uri } }
        - { name: WORK_DIR, value: /work }
        - { name: WCA_TSV_DIR, value: /work/tsv }
      volumeMounts: [ { name: work, mountPath: /work } ]
  volumes: [ { name: work, emptyDir: { sizeLimit: 1Gi } } ]
EOF
# Always remove the helper pod at the end, even if a step fails.
trap 'kubectl -n "$NS" delete pod wca-import-tsv --wait=false >/dev/null 2>&1 || true' EXIT

# Wait until the pod runs, then copy the files (kubectl cp = tar over the API server).
kubectl -n "$NS" wait pod/wca-import-tsv --for=condition=Ready --timeout=120s
kubectl -n "$NS" exec wca-import-tsv -- mkdir -p /work/tsv
for f in metadata.json $(for t in $TABLES; do echo "WCA_export_$t.tsv"; done); do
  kubectl -n "$NS" cp "$TSV_DIR/$f" "wca-import-tsv:/work/tsv/$f"
done

# Run the importer (staging schema -> indexes -> atomic swap), streaming its log.
kubectl -n "$NS" exec wca-import-tsv -- /opt/wca-import/import.sh
