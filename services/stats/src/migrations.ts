import type { Migration } from '@cubetype/common';

export const migrations: Migration[] = [
  {
    // Exactly the read model from docs/SPEC.md §7.3.
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
];
