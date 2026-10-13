-- =============================================================================
-- Step 4: wca_staging.meta — which export is loaded, when, and how big it is.
-- The psql variables are passed by import.sh (-v export_date=... etc.); :'name' inserts them
-- as properly quoted SQL literals, so nothing from the downloaded metadata is executed.
-- =============================================================================
CREATE TABLE wca_staging.meta (
  export_date    timestamptz NOT NULL,          -- from the export's metadata.json / the WCA API
  export_version text,                          -- export format version, e.g. 'v2.0.2'
  source         text        NOT NULL,          -- where the files came from (URL, zip or folder)
  imported_at    timestamptz NOT NULL DEFAULT now(),
  load_seconds   numeric,                       -- duration of download + COPY + indexing
  row_counts     jsonb       NOT NULL,          -- exact row count per table
  size_bytes     bigint      NOT NULL           -- tables + indexes
);

INSERT INTO wca_staging.meta (export_date, export_version, source, load_seconds, row_counts, size_bytes)
SELECT (:'export_date')::timestamptz,
       nullif(:'export_version', ''),
       :'source',
       (:'load_seconds')::numeric,
       jsonb_build_object(
         'continents',     (SELECT count(*) FROM wca_staging.continents),
         'countries',      (SELECT count(*) FROM wca_staging.countries),
         'events',         (SELECT count(*) FROM wca_staging.events),
         'persons',        (SELECT count(*) FROM wca_staging.persons),
         'persons_current',(SELECT count(*) FROM wca_staging.persons WHERE sub_id = 1),
         'competitions',   (SELECT count(*) FROM wca_staging.competitions),
         'ranks_single',   (SELECT count(*) FROM wca_staging.ranks_single),
         'ranks_average',  (SELECT count(*) FROM wca_staging.ranks_average),
         'percentiles',    (SELECT count(*) FROM wca_staging.percentiles),
         'distribution',   (SELECT count(*) FROM wca_staging.distribution)
       ),
       (SELECT sum(pg_total_relation_size(c.oid))::bigint
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'wca_staging' AND c.relkind = 'r');
