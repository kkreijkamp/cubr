import type { Migration } from '@cubr/common';

// Schema `solve` exactly as in docs/SPEC.md section 7.2. `migrate()` creates the schema itself and
// tracks applied ids in solve.schema_migrations (advisory-locked, safe with many replicas).
export const migrations: Migration[] = [
  {
    id: '001_init',
    sql: `
CREATE TABLE solve.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  name       text NOT NULL,
  event      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON solve.sessions (user_id, created_at);

CREATE TABLE solve.solves (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  session_id  uuid NOT NULL REFERENCES solve.sessions(id) ON DELETE CASCADE,
  event       text NOT NULL,
  time_ms     integer NOT NULL CHECK (time_ms > 0),
  penalty     text NOT NULL DEFAULT 'OK' CHECK (penalty IN ('OK','+2','DNF')),
  scramble    text NOT NULL,
  comment     text,
  source      text NOT NULL DEFAULT 'timer' CHECK (source IN ('timer','manual','import','race','daily','seed')),
  daily_date  date,
  daily_index smallint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  inserted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX solves_session_time ON solve.solves (session_id, created_at);
CREATE INDEX solves_user_event_time ON solve.solves (user_id, event, created_at);
CREATE UNIQUE INDEX solves_daily_unique ON solve.solves (user_id, daily_date, event, daily_index) WHERE daily_date IS NOT NULL;

-- Transactional outbox: events are written in the same transaction as the solve, then
-- relayed to the Redis stream by a background loop (src/outbox.ts).
CREATE TABLE solve.outbox (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished ON solve.outbox (id) WHERE published_at IS NULL;
`,
  },
  {
    id: '002_daily_attempts',
    sql: `
-- The official daily-challenge attempts: one row per (user, day, event, index), kept exactly as
-- submitted. Completion and the challenge ao5 are computed from these rows, so deleting or
-- re-penalising a daily solve afterwards changes neither, and an attempted index can't be redone.
CREATE TABLE solve.daily_attempts (
  user_id     uuid NOT NULL,
  daily_date  date NOT NULL,
  event       text NOT NULL,
  daily_index smallint NOT NULL,
  solve_id    uuid NOT NULL,
  time_ms     integer NOT NULL,
  penalty     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, daily_date, event, daily_index)
);
INSERT INTO solve.daily_attempts (user_id, daily_date, event, daily_index, solve_id, time_ms, penalty, created_at)
SELECT user_id, daily_date, event, daily_index, id, time_ms, penalty, inserted_at
  FROM solve.solves
 WHERE daily_date IS NOT NULL AND daily_index IS NOT NULL
ON CONFLICT DO NOTHING;
`,
  },
  {
    id: '003_practice_sessions',
    sql: `
-- A practice session's solves count for no personal best and no leaderboard. The flag travels in
-- solve.created and the internal solve list; changing it emits session.updated.
ALTER TABLE solve.sessions ADD COLUMN practice boolean NOT NULL DEFAULT false;
`,
  },
];
