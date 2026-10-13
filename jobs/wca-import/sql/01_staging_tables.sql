-- =============================================================================
-- Step 1: a fresh staging schema with one table per WCA export file we use.
--
-- Column names and order follow the TSV headers of WCA export format v2 exactly, because
-- COPY ... HEADER MATCH (PostgreSQL 15+) refuses a file whose header differs from the table
-- definition: if the WCA ever changes the format the import fails loudly here, before the
-- live `wca` schema is touched.
--
-- Tables are created WITHOUT keys or indexes: bulk-loading into bare tables and indexing
-- once afterwards (02_keys_indexes.sql) is several times faster than maintaining the
-- indexes row by row during COPY.
-- =============================================================================
DROP SCHEMA IF EXISTS wca_staging CASCADE;
CREATE SCHEMA wca_staging;

COMMENT ON SCHEMA wca_staging IS 'cubetype: WCA export being imported (swapped into schema wca when complete)';

-- 8 rows, e.g. ('_Oceania', 'Oceania', 'OcR')
CREATE TABLE wca_staging.continents (
  id          text NOT NULL,          -- '_Europe'
  name        text NOT NULL,
  record_name text                    -- continental record abbreviation ('ER'), empty for 'Multiple Continents'
);

-- ~200 rows. NOTE: WCA country ids are English names ('Australia', 'USA'), the ISO code is iso2.
CREATE TABLE wca_staging.countries (
  id           text NOT NULL,
  iso2         text,
  name         text NOT NULL,
  continent_id text NOT NULL
);

-- ~22 rows incl. retired events (rank >= 990) and 333mbf (format 'multi', special encoding)
CREATE TABLE wca_staging.events (
  id     text NOT NULL,               -- '333', '333fm', 'minx', ...
  format text NOT NULL,               -- 'time' (centiseconds) | 'number' (FMC moves) | 'multi'
  name   text NOT NULL,
  rank   int  NOT NULL                -- display order
);

-- ~300k rows. A person who changed name/country has several rows; sub_id = 1 is the current one.
CREATE TABLE wca_staging.persons (
  name       text     NOT NULL,
  gender     text,                    -- 'm' | 'f' | 'o' | NULL
  wca_id     text     NOT NULL,       -- '2009ZEMD01'
  sub_id     smallint NOT NULL,
  country_id text     NOT NULL
);

-- ~19k rows. Only the columns cubetype needs: the export's delegates/organizers columns contain
-- e-mail addresses and are removed BEFORE the data reaches the database (data minimisation,
-- see project_columns in import.sh); long free-text columns (information, venue, ...) are
-- dropped as well.
CREATE TABLE wca_staging.competitions (
  id                     text NOT NULL,
  name                   text NOT NULL,
  city_name              text,
  country_id             text NOT NULL,
  cancelled              smallint NOT NULL,
  year                   smallint NOT NULL,
  month                  smallint NOT NULL,
  day                    smallint NOT NULL,
  end_year               smallint NOT NULL,
  end_month              smallint NOT NULL,
  end_day                smallint NOT NULL,
  latitude_microdegrees  int,
  longitude_microdegrees int
);

-- ~1.05M rows: every person's best single per event, with precomputed world/continent/country rank.
-- best is in WCA units: centiseconds for timed events, moves for 333fm.
CREATE TABLE wca_staging.ranks_single (
  best           int  NOT NULL,
  person_id      text NOT NULL,
  event_id       text NOT NULL,
  world_rank     int  NOT NULL,
  continent_rank int  NOT NULL,
  country_rank   int  NOT NULL
);

-- ~0.91M rows: best average per person/event (333fm averages are stored as moves x 100).
CREATE TABLE wca_staging.ranks_average (LIKE wca_staging.ranks_single);
