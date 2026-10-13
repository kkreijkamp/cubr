-- =============================================================================
-- Step 3: precomputed statistics for the frontend's "where do you stand" chart.
--
--   wca_staging.percentiles   one row per (event, kind): total, min, p10..p99, histogram range
--   wca_staging.distribution  fine-grained histogram buckets per (event, kind)
--
-- Values stay in raw WCA units (centiseconds; 333fm single = moves, average = moves x 100);
-- the wca service converts to ms/moves and merges the fine buckets into the bucket count the
-- client asks for. Computing this once per import (instead of per request) turns a 300k-row
-- aggregation into a 600-row primary-key read.
--
-- Histogram range: [lo, hi) with lo = 0.5th percentile and hi just above the 99th percentile,
-- so a handful of extreme results do not squash the chart (results outside are reported as
-- `below` / `above`). Bucket widths are whole WCA units, so every bucket covers the same
-- number of possible values (no aliasing):
--   timed events: 600 buckets, width = ceil((p99 - lo) / 600) centiseconds
--                 (600 is divisible by 10, 20, 25, 30, 40, 50, 60, 75, 100, ... so most
--                  requested bucket counts merge exactly)
--   333fm:        1 bucket per move (single: width 1, average: width 100)
-- Only current events with a plain numeric encoding are included (format 'time' or 'number',
-- rank < 900): 333mbf ('multi') and retired events are excluded.
-- =============================================================================

CREATE TEMP VIEW all_ranks AS
  SELECT 'single'::text AS kind, r.event_id, e.format, r.best
  FROM wca_staging.ranks_single r JOIN wca_staging.events e ON e.id = r.event_id
  WHERE e.format IN ('time', 'number') AND e.rank < 900 AND r.best > 0
  UNION ALL
  SELECT 'average'::text, r.event_id, e.format, r.best
  FROM wca_staging.ranks_average r JOIN wca_staging.events e ON e.id = r.event_id
  WHERE e.format IN ('time', 'number') AND e.rank < 900 AND r.best > 0;

CREATE TABLE wca_staging.percentiles (
  event_id     text NOT NULL REFERENCES wca_staging.events (id),
  kind         text NOT NULL CHECK (kind IN ('single', 'average')),
  total        int  NOT NULL,              -- number of people with a result
  min_best     int  NOT NULL,              -- = world record
  max_best     int  NOT NULL,
  p10 float8 NOT NULL, p25 float8 NOT NULL, p50 float8 NOT NULL,
  p75 float8 NOT NULL, p90 float8 NOT NULL, p99 float8 NOT NULL,
  lo           int  NOT NULL,              -- histogram covers [lo, lo + bucket_count * bucket_width)
  bucket_width int  NOT NULL,
  bucket_count int  NOT NULL,
  below        int  NOT NULL DEFAULT 0,    -- results < lo  (fastest ~0.5 %)
  above        int  NOT NULL DEFAULT 0,    -- results >= hi (slowest ~1 %)
  PRIMARY KEY (event_id, kind)
);

INSERT INTO wca_staging.percentiles
  (event_id, kind, total, min_best, max_best, p10, p25, p50, p75, p90, p99, lo, bucket_width, bucket_count)
WITH stats AS (
  SELECT event_id, kind, format, count(*)::int AS total, min(best) AS min_best, max(best) AS max_best,
         percentile_cont(ARRAY[0.005, 0.10, 0.25, 0.50, 0.75, 0.90, 0.99]) WITHIN GROUP (ORDER BY best) AS p
  FROM all_ranks
  GROUP BY event_id, kind, format
), ranged AS (
  SELECT s.*,
         CASE WHEN format = 'number' AND kind = 'average' THEN floor(p[1] / 100) * 100   -- whole moves
              ELSE floor(p[1]) END::int AS lo,
         CASE WHEN format = 'number' AND kind = 'average' THEN 100
              WHEN format = 'number' THEN 1
              ELSE greatest(1, ceil((p[7] - floor(p[1])) / 600.0)) END::int AS width
  FROM stats s
)
SELECT event_id, kind, total, min_best, max_best, p[2], p[3], p[4], p[5], p[6], p[7], lo, width,
       CASE WHEN format = 'number' THEN greatest(1, ceil((p[7] + 1 - lo) / width))::int ELSE 600 END
FROM ranged;

-- Count results per bucket in ONE pass: width_bucket returns 0 for values below lo and
-- bucket_count + 1 for values >= hi.
CREATE TEMP TABLE bucket_counts AS
SELECT r.event_id, r.kind,
       width_bucket(r.best::numeric, p.lo::numeric, (p.lo + p.bucket_count * p.bucket_width)::numeric, p.bucket_count) AS bucket,
       count(*)::int AS n
FROM all_ranks r JOIN wca_staging.percentiles p USING (event_id, kind)
GROUP BY 1, 2, 3;

CREATE TABLE wca_staging.distribution (
  event_id  text NOT NULL,
  kind      text NOT NULL,
  bucket    int  NOT NULL,                 -- 1 .. bucket_count
  from_best int  NOT NULL,                 -- inclusive
  to_best   int  NOT NULL,                 -- exclusive
  count     int  NOT NULL,
  PRIMARY KEY (event_id, kind, bucket),
  FOREIGN KEY (event_id, kind) REFERENCES wca_staging.percentiles (event_id, kind)
);

-- generate_series emits every bucket (also empty ones, count 0) so the chart has no gaps.
INSERT INTO wca_staging.distribution (event_id, kind, bucket, from_best, to_best, count)
SELECT p.event_id, p.kind, b.bucket,
       p.lo + (b.bucket - 1) * p.bucket_width,
       p.lo + b.bucket * p.bucket_width,
       coalesce(c.n, 0)
FROM wca_staging.percentiles p
CROSS JOIN LATERAL generate_series(1, p.bucket_count) AS b (bucket)
LEFT JOIN bucket_counts c ON c.event_id = p.event_id AND c.kind = p.kind AND c.bucket = b.bucket;

UPDATE wca_staging.percentiles p
SET below = coalesce((SELECT n FROM bucket_counts c WHERE c.event_id = p.event_id AND c.kind = p.kind AND c.bucket = 0), 0),
    above = coalesce((SELECT n FROM bucket_counts c WHERE c.event_id = p.event_id AND c.kind = p.kind AND c.bucket = p.bucket_count + 1), 0);

-- Every result must be accounted for exactly once (below + buckets + above = total).
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.event_id || '/' || p.kind, ', ') INTO bad
  FROM wca_staging.percentiles p
  WHERE p.below + p.above + (SELECT sum(d.count) FROM wca_staging.distribution d
                             WHERE d.event_id = p.event_id AND d.kind = p.kind) <> p.total;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'histogram does not add up for %', bad;
  END IF;
END $$;

ANALYZE wca_staging.percentiles, wca_staging.distribution;
