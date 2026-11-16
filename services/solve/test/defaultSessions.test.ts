import { describe, expect, it } from 'vitest';
import { EVENTS } from '@cubr/cubestats';
import { migrations } from '../src/migrations.js';
import { DEFAULT_SESSIONS } from '../src/repo.js';

describe('default practice sessions', () => {
  it('a new account starts with "3x3" and then "3x3 practice"', () => {
    expect(DEFAULT_SESSIONS.map((s) => [s.name, s.event, s.practice])).toEqual([
      ['3x3', '333', false],
      ['3x3 practice', '333', true],
    ]);
  });

  it('migration 004 backfills a practice session for every event, named like the web app does', () => {
    const m = migrations.find((x) => x.id === '004_practice_session_per_event');
    expect(m).toBeDefined();
    for (const e of EVENTS) expect(m!.sql).toContain(`('${e.id}', '${e.short} practice')`);
    // only where the user has the event's sessions but no practice session yet
    expect(m!.sql).toMatch(/NOT EXISTS[\s\S]*p\.practice/);
  });

  it('migration ids stay unique and in order', () => {
    const ids = migrations.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
