-- =============================================================================
-- Step 5: zero-downtime swap. Renaming schemas is a catalog-only operation, and doing all of
-- it in ONE transaction means concurrent readers (the wca service) see either the complete
-- old dataset or the complete new one - never an empty or half-loaded schema. Queries that
-- are already running finish on the old tables (DROP waits for their locks).
-- =============================================================================
SET lock_timeout = '60s';   -- give up (and keep the old data) rather than queue forever

BEGIN;
DROP SCHEMA IF EXISTS wca_old CASCADE;          -- leftover of an interrupted earlier run
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'wca') THEN
    ALTER SCHEMA wca RENAME TO wca_old;
  END IF;
END $$;
ALTER SCHEMA wca_staging RENAME TO wca;
COMMENT ON SCHEMA wca IS 'cubetype: official WCA results export (loaded by jobs/wca-import, read by the wca service)';
DROP SCHEMA IF EXISTS wca_old CASCADE;
COMMIT;
