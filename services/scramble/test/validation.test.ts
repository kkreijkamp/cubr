import { describe, expect, it } from 'vitest';
import { HttpError, parse } from '@cubr/common';
import { loadScrambleSettings } from '../src/settings.js';
import { resolveDailyDate, scrambleQuerySchema } from '../src/validation.js';

const query = (q: Record<string, string>) => parse(scrambleQuerySchema, q);

function expect400(fn: () => unknown, message?: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(400);
    expect((err as HttpError).code).toBe('BAD_REQUEST');
    if (message) expect((err as HttpError).message).toMatch(message);
    return;
  }
  throw new Error('expected a 400 BAD_REQUEST');
}

describe('scramble query (count / fresh)', () => {
  it('defaults to count=1, fresh=false', () => {
    expect(query({})).toEqual({ count: 1, fresh: false });
  });

  it('accepts 1..25', () => {
    expect(query({ count: '1' }).count).toBe(1);
    expect(query({ count: '12' }).count).toBe(12);
    expect(query({ count: '25' }).count).toBe(25);
  });

  it('rejects counts outside 1..25 and non-integers', () => {
    for (const count of ['0', '26', '-1', '1.5', 'abc', '', '1e3']) expect400(() => query({ count }), /^count: /);
  });

  it('parses fresh', () => {
    expect(query({ fresh: '1' }).fresh).toBe(true);
    expect(query({ fresh: 'true' }).fresh).toBe(true);
    expect(query({ fresh: '0' }).fresh).toBe(false);
    expect(query({ fresh: 'false' }).fresh).toBe(false);
    expect400(() => query({ fresh: 'yes' }), /^fresh: /);
  });
});

describe('resolveDailyDate', () => {
  const now = new Date('2026-10-14T23:59:59Z');

  it('defaults to today (UTC)', () => {
    expect(resolveDailyDate(undefined, now)).toBe('2026-10-14');
    expect(resolveDailyDate('', now)).toBe('2026-10-14');
    // 23:30 in UTC-10 is already tomorrow in UTC
    expect(resolveDailyDate(undefined, new Date('2026-10-15T00:30:00Z'))).toBe('2026-10-15');
  });

  it('accepts today back to 30 days ago', () => {
    expect(resolveDailyDate('2026-10-14', now)).toBe('2026-10-14');
    expect(resolveDailyDate('2026-10-01', now)).toBe('2026-10-01');
    expect(resolveDailyDate('2026-09-14', now)).toBe('2026-09-14');
  });

  it('rejects dates older than 30 days or in the future', () => {
    expect400(() => resolveDailyDate('2026-09-13', now), /last 30 days/);
    expect400(() => resolveDailyDate('2026-10-15', now), /future/);
  });

  it('rejects malformed and impossible dates', () => {
    for (const d of ['2026-1-01', '14-10-2026', 'today', '2026-10-14T00:00:00Z', '20261014']) {
      expect400(() => resolveDailyDate(d, now), /YYYY-MM-DD/);
    }
    expect400(() => resolveDailyDate('2026-02-30', now), /valid calendar date/);
    expect400(() => resolveDailyDate('2026-13-01', now), /valid calendar date/);
  });

  it('handles leap days', () => {
    expect(resolveDailyDate('2028-02-29', new Date('2028-03-10T12:00:00Z'))).toBe('2028-02-29');
    expect400(() => resolveDailyDate('2027-02-29', new Date('2027-03-10T12:00:00Z')), /valid calendar date/);
  });
});

describe('loadScrambleSettings', () => {
  it('has sensible defaults', () => {
    expect(loadScrambleSettings({})).toEqual({
      workers: 1,
      timeoutMs: 15_000,
      maxQueue: 250,
      refillIntervalMs: 2_000,
      refillBatch: 5,
      refillBudgetMs: 300,
      refillEnabled: true,
    });
  });

  it('clamps and parses overrides', () => {
    const s = loadScrambleSettings({ SCRAMBLE_WORKERS: '99', SCRAMBLE_TIMEOUT_MS: 'x', SCRAMBLE_REFILL: 'off' });
    expect(s.workers).toBe(16);
    expect(s.timeoutMs).toBe(15_000);
    expect(s.refillEnabled).toBe(false);
  });
});
