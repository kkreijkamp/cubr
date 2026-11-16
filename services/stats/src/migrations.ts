import type { Migration } from '@cubr/common';

export const migrations: Migration[] = [
  {
    // Exactly the read model from docs/SPEC.md section 7.3.
    id: '001_init',
    sql: `
CREATE TABLE stats.user_totals (
  user_id uuid PRIMARY KEY, username text NOT NULL,
  solves integer NOT NULL DEFAULT 0, total_ms bigint NOT NULL DEFAULT 0,
  first_solve_at timestamptz, last_solve_at timestamptz,
  registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stats.personal_bests (
  user_id uuid NOT NULL, event text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('single','mo3','ao5','ao12','ao50','ao100')),
  value_ms integer NOT NULL, solve_id uuid, achieved_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, event, kind)
);
CREATE TABLE stats.pb_history (
  id bigserial PRIMARY KEY, user_id uuid NOT NULL, event text NOT NULL, kind text NOT NULL,
  value_ms integer NOT NULL, achieved_at timestamptz NOT NULL
);
CREATE INDEX pb_history_user ON stats.pb_history (user_id, event, achieved_at);
CREATE TABLE stats.daily_activity (
  user_id uuid NOT NULL, day date NOT NULL, event text NOT NULL,
  solves integer NOT NULL DEFAULT 0, total_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, event)
);
CREATE TABLE stats.hourly (
  user_id uuid NOT NULL, event text NOT NULL, hour smallint NOT NULL,
  solves integer NOT NULL DEFAULT 0, sum_ms bigint NOT NULL DEFAULT 0,   -- non-DNF only
  PRIMARY KEY (user_id, event, hour)
);
CREATE TABLE stats.processed_events (event_id text PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now());
`,
  },
  {
    // Internal additions (not part of any API contract), see README "Design notes".
    id: '002_ledger_outbox',
    sql: `
-- hourly.solves / sum_ms stay non-DNF only (meanMs = sum_ms / solves); DNFs are counted here so the
-- time-of-day chart can show every attempt.
ALTER TABLE stats.hourly ADD COLUMN dnfs integer NOT NULL DEFAULT 0;

-- Last valid IANA timezone seen in the user's events: used to re-bucket days on events that carry
-- no tz (session.deleted) and as "today" for streaks.
ALTER TABLE stats.user_totals ADD COLUMN tz text NOT NULL DEFAULT 'UTC';

-- Per-solve ledger: makes solve.created idempotent per solve (not just per event), lets late /
-- re-delivered events be ignored once a full recompute already counted (or a delete removed) the
-- solve, and gives O(1) access to a session's last 100 solves for incremental mo3/ao50/ao100.
CREATE TABLE stats.solve_ledger (
  solve_id     uuid PRIMARY KEY,
  seq          bigserial NOT NULL,            -- arrival order, tie-break for equal created_at
  user_id      uuid NOT NULL,
  event        text NOT NULL,
  session_id   uuid NOT NULL,
  time_ms      integer NOT NULL,
  effective_ms integer,                        -- NULL = DNF
  created_at   timestamptz NOT NULL,
  deleted      boolean NOT NULL DEFAULT false  -- tombstone written by solve.deleted
);
CREATE INDEX solve_ledger_session ON stats.solve_ledger (session_id, created_at, seq) WHERE NOT deleted;
CREATE INDEX solve_ledger_user_event ON stats.solve_ledger (user_id, event);

-- Tombstones for deleted sessions (late solve.created events for them are ignored).
CREATE TABLE stats.deleted_sessions (
  session_id uuid PRIMARY KEY, user_id uuid NOT NULL, deleted_at timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox for pb.updated: written in the same transaction as the PB change, relayed
-- to the Redis stream after commit and by a background loop (so no pb.updated is ever lost).
CREATE TABLE stats.pb_outbox (
  id bigserial PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX daily_activity_day ON stats.daily_activity (day);
CREATE INDEX personal_bests_event_kind ON stats.personal_bests (event, kind, value_ms);
CREATE INDEX processed_events_at ON stats.processed_events (processed_at);
`,
  },
  {
    // Session display names for the profile history chart's session filter. Names are owned by
    // solve-service; this copy is fed by solve.created (sessionName) and session.renamed events,
    // and backfilled from GET solve /internal/users/:id/sessions for sessions seen without one.
    id: '003_session_names',
    sql: `
CREATE TABLE stats.sessions (
  session_id uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  event      text NOT NULL,
  name       text NOT NULL,           -- '' = solve-service didn't know the session (not retried)
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON stats.sessions (user_id);
`,
  },
  {
    // Tombstones for deleted accounts (user.deleted): their rows are removed and any later
    // event for them (a late solve.created, a pb.updated already in flight) is ignored.
    id: '004_deleted_users',
    sql: `
CREATE TABLE stats.deleted_users (
  user_id uuid PRIMARY KEY, deleted_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    // Practice sessions (their solves count for no PB): the flag rides on the session names, fed by
    // solve.created / session.updated, every recompute (the internal solve list) and the backfill.
    // The profile's history chart leaves these sessions out of its PB line.
    id: '005_practice_sessions',
    sql: `
ALTER TABLE stats.sessions ADD COLUMN practice boolean NOT NULL DEFAULT false;
`,
  },
  {
    // The site-wide "solves today" counts the ledger's solves made since UTC midnight (routes/global.ts).
    id: '006_ledger_created_at',
    sql: `
CREATE INDEX solve_ledger_created_at ON stats.solve_ledger (created_at) WHERE NOT deleted;
`,
  },
];
