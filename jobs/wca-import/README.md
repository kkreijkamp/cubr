# wca-import job

Loads the official **WCA results export** (public, weekly-refreshed; format v2) into PostgreSQL
schema `wca`, which the [wca service](../../services/wca/README.md) reads. Runs as a Kubernetes
Job (initial load) / CronJob (weekly refresh) and as a docker compose one-shot.

> This information is based on competition results owned and maintained by the World Cube
> Association, published at https://worldcubeassociation.org/results as of October 14, 2026.

It is a commented shell script ([`import.sh`](import.sh)) plus five SQL files ([`sql/`](sql)),
packaged on `postgres:17-alpine` (psql) + `bash curl unzip jq`.

## Pipeline
1. **Locate the export**: `WCA_TSV_DIR` (unzipped folder) -> `WCA_TSV_ZIP` (local zip) -> otherwise ask
   `https://www.worldcubeassociation.org/api/v0/export/public` (`export_date`, `export_version`, `tsv_url`).
2. **Skip** if `wca.meta.export_date` already equals that export date (unless `FORCE=1`), before downloading anything.
3. **Download** (`curl -fL --retry 3`, HTTPS only, URL must be on `*.worldcubeassociation.org`) to `WORK_DIR`.
4. **Staging schema** `wca_staging`, created fresh; each TSV is **streamed** with
   `unzip -p export.zip WCA_export_<t>.tsv | psql -c "\copy wca_staging.<t> FROM pstdin WITH (FORMAT csv, DELIMITER E'\t', QUOTE E'\x01', NULL 'NULL', HEADER MATCH)"`.
   Nothing is extracted to disk. `HEADER MATCH` makes the job fail if the WCA changes a column.
   For `competitions` only 13 of 22 columns are kept: `delegates`/`organizers` contain e-mail addresses and
   are dropped by an `awk` projection *before* the data reaches the database.
5. **Sanity checks** (minimum row counts), primary keys, foreign keys, indexes, `VACUUM ANALYZE`. Bulk-load first, index once.
6. **Precompute** `percentiles` (total, WR, p10...p99 per event/kind) and `distribution` (fine histogram buckets) with
   `percentile_cont` and `width_bucket`.
7. **`meta`**: export date/version, source, import time, exact row count per table, size.
8. **Atomic swap** in one transaction: `wca` -> `wca_old`, `wca_staging` -> `wca`, drop `wca_old`.
   Readers see the complete old or the complete new dataset, never a partial one (zero-downtime refresh).
   If any step fails, the job exits non-zero and the live `wca` schema is untouched.

## Data loaded (export of 2026-10-14)
Measured on the docker compose Postgres 17 (Docker Desktop on an M-series Mac), loading from `WCA_TSV_DIR`:

| Table | Rows | Data | Indexes | Total |
|---|---:|---:|---:|---:|
| `ranks_single` | 1,049,779 | 64 MB | 45 MB | 109 MB |
| `ranks_average` | 911,389 | 55 MB | 39 MB | 94 MB |
| `persons` | 300,482 (300,003 current) | 22 MB | 52 MB | 74 MB |
| `competitions` | 18,907 | 2.2 MB | 0.7 MB | 3.0 MB |
| `distribution` (derived) | 18,096 | 1.0 MB | 0.6 MB | 1.7 MB |
| `countries` | 207 | | | 88 kB |
| `percentiles` (derived) | 32 | | | 64 kB |
| `events` | 22 | | | 64 kB |
| `continents` | 7 | | | 64 kB |
| `meta` | 1 | | | 16 kB |
| **Total (10 tables)** | **2,298,922** | | | **281 MB** |

Source: the 7 TSVs used are 106 MB uncompressed (the full export zip is 381 MB / 1.66 GB unzipped).

Import timing (total **7.3 s**): streaming COPY of all 7 files 1.4 s - checks + keys + indexes + VACUUM ANALYZE 3.5 s -
percentiles/histograms 2.2 s - meta 0.1 s - swap < 0.1 s. A re-run with the same export exits after ~1 s
("already loaded"). During a forced re-import, a client querying `wca` every ~20 ms saw 378 successful queries and
0 errors (zero-downtime swap verified). A corrupted header (`HEADER MATCH`) aborts the run, drops `wca_staging`
and leaves the live schema untouched (verified).

Not loaded: `results` (6.97 M rows, 665 MB), `result_attempts` (32 M), `scrambles` (3.2 M); the
service only needs per-person bests and ranks, which `ranks_single`/`ranks_average` already contain.

## Schema `wca`
| Table | Key | Notes |
|---|---|---|
| `continents` | `id` | |
| `countries` | `id` (WCA country name, e.g. `Australia`) | `iso2` indexed; FK -> continents |
| `events` | `id` | `format` time / number (FMC) / multi |
| `persons` | `(wca_id, sub_id)` | `sub_id = 1` is the current name/country; FK -> countries |
| `competitions` | `id` | no delegate/organizer e-mails, no free-text fields; FK -> countries |
| `ranks_single`, `ranks_average` | `(person_id, event_id)` | `best` in centiseconds (333fm: moves, average x100); FK -> events |
| `percentiles` | `(event_id, kind)` | precomputed totals, WR, p10...p99, histogram range |
| `distribution` | `(event_id, kind, bucket)` | 600 buckets per timed event (1 per move for 333fm) |
| `meta` | one row | export date/version, row counts, size |

Indexes: `ranks_*(event_id, best)` (rank counts, records, neighbours), `persons(country_id, wca_id) WHERE sub_id=1`
(country ranks), `persons(lower(name) text_pattern_ops)` (prefix search), `persons USING gin (name gin_trgm_ops)`
(substring search; `pg_trgm` is created in `public` and skipped with a warning if not permitted),
`countries(iso2)`; the primary keys cover lookups by `wca_id` and by `person_id`.

## Environment
| Var | Default | |
|---|---|---|
| `DATABASE_URL` | (required) | e.g. `postgres://cubr:cubr@postgres:5432/cubr` |
| `WCA_TSV_DIR` | - | folder with the unzipped `WCA_export_*.tsv` + `metadata.json` (local dev, fastest) |
| `WCA_TSV_ZIP` | - | path to a downloaded `WCA_export_v2_tsv.zip` |
| `WCA_EXPORT_API` | WCA public API | |
| `WORK_DIR` | `/tmp/wca-import` | where the zip is downloaded. **K8s: mount an `emptyDir` (sizeLimit >= 1Gi) here.** |
| `FORCE` | `0` | `1` = re-import even if this export is loaded |
| `KEEP_ZIP` | `0` | `1` = keep the downloaded zip |

Resources: the job itself is light (psql + unzip streaming, < 64 MiB RAM, little CPU); disk = the
381 MB zip in `WORK_DIR`. The database needs room for two copies of the schema during the swap
(~2 x 281 MB, plus roughly the same again in WAL per import) and uses `maintenance_work_mem = 128MB` while building indexes.
Use `concurrencyPolicy: Forbid` on the CronJob (two concurrent runs would share `wca_staging`).

## Run
```bash
docker build -f jobs/wca-import/Dockerfile -t cubr/wca-import:dev .
# local folder (read-only bind mount), Postgres of the docker compose stack (127.0.0.1:55433)
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$PWD/data/wca/tsv:/data:ro" -e WCA_TSV_DIR=/data \
  -e DATABASE_URL=postgres://cubr:cubr@host.docker.internal:55433/cubr cubr/wca-import:dev
# download the latest export (what the CronJob does)
docker run --rm -e DATABASE_URL=... cubr/wca-import:dev
```
Kubernetes (CronJob sketch; the initial load is the same pod spec as a Job):
```yaml
spec:
  schedule: "0 4 * * 1"             # weekly, Monday 04:00
  timeZone: Australia/Brisbane
  concurrencyPolicy: Forbid         # two runs would share wca_staging
  jobTemplate:
    spec:
      backoffLimit: 3               # the WCA download endpoint sometimes answers 429
      activeDeadlineSeconds: 3600
      template:
        spec:
          restartPolicy: Never
          securityContext: { runAsNonRoot: true, runAsUser: 70, runAsGroup: 70, fsGroup: 70 }
          containers:
            - name: wca-import
              image: .../cubr/wca-import:<version>
              env:
                - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: pg-app, key: uri } } }
                - { name: WORK_DIR, value: /work }
              resources: { requests: { cpu: 50m, memory: 128Mi }, limits: { cpu: 500m, memory: 512Mi } }
              volumeMounts: [ { name: work, mountPath: /work }, { name: tmp, mountPath: /tmp } ]
          volumes: [ { name: work, emptyDir: { sizeLimit: 2Gi } }, { name: tmp, emptyDir: { sizeLimit: 64Mi } } ]
```

docker compose one-shot (`docker compose --profile jobs run --rm wca-import`):
```yaml
wca-import:
  profiles: ["jobs"]
  image: cubr/wca-import:dev
  build: { context: ., dockerfile: jobs/wca-import/Dockerfile, args: *build-args }
  restart: "no"
  environment:
    DATABASE_URL: postgres://cubr:cubr@postgres:5432/cubr
    FORCE: ${FORCE:-0}
  depends_on: { postgres: { condition: service_healthy } }
```
To load a local export instead of downloading one, add
`-v "$PWD/data/wca/tsv:/data:ro" -e WCA_TSV_DIR=/data` to the `run` command.
