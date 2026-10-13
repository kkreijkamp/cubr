import type { Migration } from '@cubetype/common';

export const migrations: Migration[] = [
  {
    id: '001_daily_challenges',
    sql: `
      CREATE TABLE IF NOT EXISTS scramble.daily_challenges (
        day        date NOT NULL,
        event      text NOT NULL,
        scrambles  text[] NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (day, event)
      );
    `,
  },
];
