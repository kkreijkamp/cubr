-- =============================================================================
-- Step 2: sanity checks, primary/foreign keys and the indexes the wca service relies on.
-- Runs after all COPYs finished (bulk-load first, index once).
-- =============================================================================
SET maintenance_work_mem = '128MB';   -- faster index builds; modest enough for a small DB pod

-- Refuse to publish a truncated/broken download: the swap only happens if this passes.
DO $$
DECLARE
  n_persons bigint := (SELECT count(*) FROM wca_staging.persons);
  n_single  bigint := (SELECT count(*) FROM wca_staging.ranks_single);
  n_average bigint := (SELECT count(*) FROM wca_staging.ranks_average);
  n_comps   bigint := (SELECT count(*) FROM wca_staging.competitions);
BEGIN
  IF n_persons < 100000 OR n_single < 300000 OR n_average < 300000 OR n_comps < 10000 THEN
    RAISE EXCEPTION 'export looks incomplete (persons=%, ranks_single=%, ranks_average=%, competitions=%)',
      n_persons, n_single, n_average, n_comps;
  END IF;
END $$;

-- ---- primary keys -----------------------------------------------------------------------
ALTER TABLE wca_staging.continents    ADD CONSTRAINT continents_pkey    PRIMARY KEY (id);
ALTER TABLE wca_staging.countries     ADD CONSTRAINT countries_pkey     PRIMARY KEY (id);
ALTER TABLE wca_staging.events        ADD CONSTRAINT events_pkey        PRIMARY KEY (id);
-- (wca_id, sub_id): also serves every "WHERE wca_id = ?" lookup (leading column)
ALTER TABLE wca_staging.persons       ADD CONSTRAINT persons_pkey       PRIMARY KEY (wca_id, sub_id);
ALTER TABLE wca_staging.competitions  ADD CONSTRAINT competitions_pkey  PRIMARY KEY (id);
-- (person_id, event_id): also serves "all PBs of one person" (leading column person_id)
ALTER TABLE wca_staging.ranks_single  ADD CONSTRAINT ranks_single_pkey  PRIMARY KEY (person_id, event_id);
ALTER TABLE wca_staging.ranks_average ADD CONSTRAINT ranks_average_pkey PRIMARY KEY (person_id, event_id);

-- ---- foreign keys (relational integrity of the export is verified on every import) -------
ALTER TABLE wca_staging.countries     ADD CONSTRAINT countries_continent_fkey    FOREIGN KEY (continent_id) REFERENCES wca_staging.continents (id);
ALTER TABLE wca_staging.persons       ADD CONSTRAINT persons_country_fkey        FOREIGN KEY (country_id)   REFERENCES wca_staging.countries (id);
ALTER TABLE wca_staging.competitions  ADD CONSTRAINT competitions_country_fkey   FOREIGN KEY (country_id)   REFERENCES wca_staging.countries (id);
ALTER TABLE wca_staging.ranks_single  ADD CONSTRAINT ranks_single_event_fkey     FOREIGN KEY (event_id)     REFERENCES wca_staging.events (id);
ALTER TABLE wca_staging.ranks_average ADD CONSTRAINT ranks_average_event_fkey    FOREIGN KEY (event_id)     REFERENCES wca_staging.events (id);
-- (ranks.person_id -> persons is 1:n over sub_id, so it cannot be a declared FK; the importer
--  does not rely on it and the service always joins persons with sub_id = 1.)

-- ---- secondary indexes --------------------------------------------------------------------
-- Rank estimator: "how many people are faster than X in event E" = index range scan;
-- records = first entry per event; neighbours = a few entries either side of X.
CREATE INDEX ranks_single_event_best  ON wca_staging.ranks_single  (event_id, best);
CREATE INDEX ranks_average_event_best ON wca_staging.ranks_average (event_id, best);
-- Country rank: all current persons of one country (then joined to ranks by primary key).
CREATE INDEX persons_country ON wca_staging.persons (country_id, wca_id) WHERE sub_id = 1;
-- Person search by name prefix ("feli" -> Feliks ...), case-insensitive.
CREATE INDEX persons_name_lower ON wca_staging.persons (lower(name) text_pattern_ops) WHERE sub_id = 1;
-- ?country=AU resolves ISO codes to WCA country ids.
CREATE INDEX countries_iso2 ON wca_staging.countries (iso2);

-- Substring search ("zemd", "park") uses a trigram GIN index. pg_trgm is a *trusted* extension,
-- so the database owner may create it without superuser rights. It is installed into `public`
-- (never into wca_staging, which would drop it again on the next swap). If it is unavailable the
-- import still succeeds and the service's ILIKE search simply runs without this index.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pg_trgm not available (%), skipping trigram index', SQLERRM;
END $$;

DO $$
DECLARE trgm_schema text;
BEGIN
  SELECT n.nspname INTO trgm_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';
  IF trgm_schema IS NOT NULL THEN
    EXECUTE format('CREATE INDEX persons_name_trgm ON wca_staging.persons USING gin (name %I.gin_trgm_ops) WHERE sub_id = 1', trgm_schema);
  END IF;
END $$;

-- VACUUM sets the visibility map (enables index-only scans for the count queries) and ANALYZE
-- gives the planner fresh statistics. (Cannot run inside a transaction block.)
VACUUM (ANALYZE) wca_staging.continents, wca_staging.countries, wca_staging.events, wca_staging.persons,
                 wca_staging.competitions, wca_staging.ranks_single, wca_staging.ranks_average;
