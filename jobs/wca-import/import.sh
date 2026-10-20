#!/usr/bin/env bash
# =============================================================================
# cubetype WCA importer: loads the official WCA results export into PostgreSQL (schema `wca`).
#
# Runs as a Kubernetes Job/CronJob (weekly refresh) and as a docker compose one-shot.
#
#   1. locate the export:  local TSV folder  ->  local zip  ->  download the latest zip
#   2. skip if the database already holds this export (unless FORCE=1)
#   3. create a fresh schema `wca_staging` and STREAM every TSV into it with COPY
#      (the 381 MB zip is never extracted to disk: `unzip -p` pipes straight into psql)
#   4. sanity checks, primary/foreign keys, indexes, VACUUM ANALYZE
#   5. precompute percentiles + histogram buckets (the "where do you stand" chart)
#   6. write wca_staging.meta (export date, version, row counts, size)
#   7. swap wca_staging -> wca atomically in ONE transaction (zero-downtime refresh)
#
# If anything fails (`set -euo pipefail`), the job exits non-zero and the live `wca` schema is
# untouched: readers keep using the previous dataset, K8s retries / reports the failed Job.
#
# Environment:
#   DATABASE_URL    postgres://user:pass@host:5432/db                      (required)
#   WCA_TSV_DIR     folder with the unzipped WCA_export_*.tsv + metadata.json (optional, fastest)
#   WCA_TSV_ZIP     path to an already-downloaded WCA_export_v2_tsv.zip      (optional)
#   WCA_EXPORT_API  export metadata endpoint (default: WCA public API, see below)
#   WORK_DIR        scratch directory for the downloaded zip (default /tmp/wca-import;
#                   on Kubernetes mount an emptyDir of >= 1 GiB here)
#   FORCE=1         import even if this export is already loaded
#   KEEP_ZIP=1      keep the downloaded zip in WORK_DIR after the run
#
# The downloaded files are treated as untrusted DATA: they are only ever streamed into COPY;
# metadata values reach SQL exclusively as psql :'variables' (quoted literals).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="${SQL_DIR:-$SCRIPT_DIR/sql}"
WCA_EXPORT_API="${WCA_EXPORT_API:-https://www.worldcubeassociation.org/api/v0/export/public}"
WORK_DIR="${WORK_DIR:-/tmp/wca-import}"
FORCE="${FORCE:-0}"
KEEP_ZIP="${KEEP_ZIP:-0}"
: "${DATABASE_URL:?DATABASE_URL must be set, e.g. postgres://cubetype:cubetype@postgres:5432/cubetype}"

export PGCLIENTENCODING=UTF8            # the export is UTF-8 (e.g. names written in Chinese characters)
export PGAPPNAME=wca-import
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"   # hide NOTICEs, keep warnings

# The export files we load, in load order (parents before children).
TABLES=(continents countries events persons competitions ranks_single ranks_average)
# Columns kept from competitions (the export has 22; delegates/organizers contain e-mails).
COMPETITION_COLUMNS="id,name,city_name,country_id,cancelled,year,month,day,end_year,end_month,end_day,latitude_microdegrees,longitude_microdegrees"

# ---- logging helpers ---------------------------------------------------------------------
log()  { printf '%s [wca-import] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }
now()  { local t="${EPOCHREALTIME:-$(date +%s)}"; printf '%s' "${t/,/.}"; }   # seconds.micros (bash 5)
secs_since() { awk -v s="$1" -v e="$(now)" 'BEGIN { printf "%.1f", e - s }'; }
step() { STEP_START=$(now); log "==> $*"; }
step_done() { log "    done in $(secs_since "$STEP_START")s"; }

# psql with: no ~/.psqlrc, stop at the first error, quiet.
psql_run() { psql "$DATABASE_URL" --no-psqlrc -v ON_ERROR_STOP=1 --quiet "$@"; }
# Run SQL from stdin and print the bare result (stdin, not -c, so :'var' interpolation works).
psql_value() { psql_run --tuples-only --no-align "$@"; }

JOB_START=$(now)
log "cubetype WCA importer starting (FORCE=$FORCE)"

# ---- 0. wait for Postgres (the Job may start before the database pod is ready) -----------
step "waiting for PostgreSQL"
for attempt in $(seq 1 60); do
  if pg_isready --quiet --dbname="$DATABASE_URL"; then break; fi
  [[ $attempt -eq 60 ]] && die "PostgreSQL not reachable after 120 s"
  sleep 2
done
step_done

# ---- 1. locate the export -----------------------------------------------------------------
# Defines read_member <file>: writes one export file to stdout, wherever it lives.
ZIP=""
DOWNLOADED_ZIP=""
STAGING_CREATED=0
cleanup() {
  local status=$?
  if [[ -n "$DOWNLOADED_ZIP" && "$KEEP_ZIP" != "1" ]]; then rm -f "$DOWNLOADED_ZIP" "$DOWNLOADED_ZIP.part"; fi
  # A failed run leaves the live `wca` schema untouched; also free the space of the half-built copy.
  if [[ $status -ne 0 && $STAGING_CREATED -eq 1 ]]; then
    log "import FAILED (exit $status): dropping wca_staging, the live wca schema is unchanged"
    psql_run -c 'DROP SCHEMA IF EXISTS wca_staging CASCADE' >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

step "locating the WCA export"
if [[ -n "${WCA_TSV_DIR:-}" && -f "${WCA_TSV_DIR}/WCA_export_persons.tsv" ]]; then
  SOURCE="dir:${WCA_TSV_DIR}"
  read_member() { cat -- "${WCA_TSV_DIR}/$1"; }
  has_member()  { [[ -f "${WCA_TSV_DIR}/$1" ]]; }
  [[ -f "${WCA_TSV_DIR}/metadata.json" ]] || die "${WCA_TSV_DIR}/metadata.json missing"
  METADATA="$(cat -- "${WCA_TSV_DIR}/metadata.json")"
  RAW_EXPORT_DATE="$(jq -r '.export_date // empty' <<<"$METADATA")"
  EXPORT_VERSION="$(jq -r '.export_format_version // empty' <<<"$METADATA")"
  log "    using local TSV folder ${WCA_TSV_DIR}"
else
  [[ -n "${WCA_TSV_DIR:-}" ]] && log "    WARNING: WCA_TSV_DIR=${WCA_TSV_DIR} has no WCA_export_persons.tsv, ignoring it"
  [[ -n "${WCA_TSV_ZIP:-}" && ! -f "${WCA_TSV_ZIP}" ]] && log "    WARNING: WCA_TSV_ZIP=${WCA_TSV_ZIP} does not exist, ignoring it"
  if [[ -n "${WCA_TSV_ZIP:-}" && -f "${WCA_TSV_ZIP}" ]]; then
    ZIP="$WCA_TSV_ZIP"
    SOURCE="zip:${ZIP}"
    METADATA="$(unzip -p -- "$ZIP" metadata.json)" || die "metadata.json missing in $ZIP"
    RAW_EXPORT_DATE="$(jq -r '.export_date // empty' <<<"$METADATA")"
    EXPORT_VERSION="$(jq -r '.export_format_version // empty' <<<"$METADATA")"
    log "    using local zip ${ZIP}"
  else
    # Ask the WCA API which export is current (small JSON document):
    #   {"export_date":"2026-10-14T00:00:33Z","export_version":"v2.0.2","tsv_url":"https://...", ...}
    log "    querying ${WCA_EXPORT_API}"
    METADATA="$(curl -fsSL --retry 3 --retry-delay 5 --retry-all-errors --connect-timeout 20 --max-time 60 \
                     --proto '=https' --proto-redir '=https' "$WCA_EXPORT_API")" \
      || die "could not query the WCA export API"
    RAW_EXPORT_DATE="$(jq -r '.export_date // empty' <<<"$METADATA")"
    EXPORT_VERSION="$(jq -r '.export_version // empty' <<<"$METADATA")"
    TSV_URL="$(jq -r '.tsv_url // empty' <<<"$METADATA")"
    TSV_BYTES="$(jq -r '.tsv_filesize_bytes // 0' <<<"$METADATA")"
    # Only ever download over HTTPS from the WCA's own domain.
    [[ "$TSV_URL" =~ ^https://([a-z0-9-]+\.)*worldcubeassociation\.org/[A-Za-z0-9._/~%-]+$ ]] \
      || die "unexpected tsv_url in API response: '${TSV_URL}'"
    SOURCE="$TSV_URL"
    log "    latest export: ${RAW_EXPORT_DATE} (${EXPORT_VERSION}), tsv_url=${TSV_URL} ($((TSV_BYTES / 1048576)) MB)"
  fi
  read_member() { unzip -p -- "$ZIP" "$1"; }
  has_member()  { unzip -l -- "$ZIP" "$1" >/dev/null 2>&1; }
fi
[[ "$RAW_EXPORT_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2} ]] || die "export_date missing or malformed: '${RAW_EXPORT_DATE}'"
# Let Postgres normalise the date (the API says "2026-10-14T00:00:33Z", metadata.json
# "2026-10-14 00:00:33 UTC"); an unparsable value aborts the job here.
EXPORT_DATE="$(psql_value -v d="$RAW_EXPORT_DATE" <<'SQL'
SELECT to_char((:'d')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
SQL
)"
log "    export date ${EXPORT_DATE}, format ${EXPORT_VERSION:-unknown}"
step_done

# ---- 2. skip if already loaded -------------------------------------------------------------
LOADED_DATE=""
if [[ "$(psql_value <<<"SELECT to_regclass('wca.meta') IS NOT NULL;")" == "t" ]]; then
  LOADED_DATE="$(psql_value <<'SQL'
SELECT to_char(export_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM wca.meta LIMIT 1;
SQL
)"
fi
log "currently loaded export: ${LOADED_DATE:-none}"
if [[ "$LOADED_DATE" == "$EXPORT_DATE" && "$FORCE" != "1" ]]; then
  log "export ${EXPORT_DATE} is already loaded, nothing to do (set FORCE=1 to re-import)"
  exit 0
fi

# ---- 1b. download (only now that we know it is needed) -----------------------------------
if [[ "$SOURCE" == https://* ]]; then
  step "downloading the TSV export"
  mkdir -p "$WORK_DIR"
  ZIP="$WORK_DIR/WCA_export_v2_tsv.zip"
  DOWNLOADED_ZIP="$ZIP"
  curl -fL --retry 3 --retry-delay 15 --retry-all-errors --connect-timeout 20 --max-time 3600 \
       --proto '=https' --proto-redir '=https' --silent --show-error \
       -o "$ZIP.part" "$TSV_URL" || die "download failed"
  mv "$ZIP.part" "$ZIP"
  log "    $(du -h "$ZIP" | cut -f1) downloaded to $ZIP"
  step_done
fi

for t in "${TABLES[@]}"; do
  has_member "WCA_export_${t}.tsv" || die "export does not contain WCA_export_${t}.tsv"
done

# ---- 3. staging schema + streaming COPY ----------------------------------------------------
step "creating schema wca_staging"
STAGING_CREATED=1
psql_run -f "$SQL_DIR/01_staging_tables.sql"
step_done

# COPY options: the export is tab-separated with no quoting/escaping and writes SQL NULL as the
# literal text NULL. CSV mode with an impossible quote character (0x01) takes every field
# literally (TEXT mode would interpret backslashes). HEADER MATCH verifies the column names.
COPY_OPTIONS="WITH (FORMAT csv, DELIMITER E'\t', QUOTE E'\x01', NULL 'NULL', HEADER MATCH)"

# Keeps only the named columns of a TSV stream (header included), looked up by header name, so
# the result does not depend on the column order. Fails if a column is missing.
project_columns() {
  awk -F'\t' -v OFS='\t' -v want="$1" '
    NR == 1 {
      n = split(want, w, ",")
      for (i = 1; i <= NF; i++) idx[$i] = i
      for (j = 1; j <= n; j++) {
        if (!(w[j] in idx)) { print "missing column " w[j] > "/dev/stderr"; exit 2 }
        col[j] = idx[w[j]]
      }
    }
    { line = $(col[1]); for (j = 2; j <= n; j++) line = line OFS $(col[j]); print line }'
}

step "loading TSV files"
for t in "${TABLES[@]}"; do
  t_start=$(now)
  if [[ "$t" == "competitions" ]]; then
    out="$(read_member "WCA_export_${t}.tsv" | project_columns "$COMPETITION_COLUMNS" \
           | psql "$DATABASE_URL" --no-psqlrc -v ON_ERROR_STOP=1 -c "\\copy wca_staging.${t} FROM pstdin ${COPY_OPTIONS}")"
  else
    out="$(read_member "WCA_export_${t}.tsv" \
           | psql "$DATABASE_URL" --no-psqlrc -v ON_ERROR_STOP=1 -c "\\copy wca_staging.${t} FROM pstdin ${COPY_OPTIONS}")"
  fi
  log "    $(printf '%-14s %9s rows  %5ss' "$t" "${out#COPY }" "$(secs_since "$t_start")")"
done
step_done

# ---- 4. keys, indexes, statistics ----------------------------------------------------------
step "sanity checks, keys, indexes, VACUUM ANALYZE"
psql_run -f "$SQL_DIR/02_keys_indexes.sql"
step_done

# ---- 5. precomputed distributions ----------------------------------------------------------
step "precomputing percentiles and histograms"
psql_run -f "$SQL_DIR/03_distribution.sql"
step_done

# ---- 6. meta ---------------------------------------------------------------------------------
step "writing wca_staging.meta"
psql_run -v export_date="$EXPORT_DATE" -v export_version="${EXPORT_VERSION:-}" -v source="$SOURCE" \
         -v load_seconds="$(secs_since "$JOB_START")" -f "$SQL_DIR/04_meta.sql"
step_done

# ---- 7. atomic swap ------------------------------------------------------------------------
step "swapping wca_staging -> wca (single transaction)"
psql_run -f "$SQL_DIR/05_swap.sql"
STAGING_CREATED=0
step_done

# ---- summary -------------------------------------------------------------------------------
log "imported export ${EXPORT_DATE} in $(secs_since "$JOB_START")s total:"
psql_value <<'SQL' | while IFS= read -r line; do log "    $line"; done
SELECT format('%-16s %10s rows', key, to_char(value::bigint, 'FM999,999,999'))
FROM wca.meta, jsonb_each_text(row_counts) ORDER BY key;
SELECT format('%-16s %10s', 'size on disk', pg_size_pretty(size_bytes)) FROM wca.meta;
SQL
