import { describe, expect, it } from 'vitest';
import { HttpError, parse } from '@cubr/common';
import {
  assertDailyAllowed, createSessionBody, createSolveBody, importBody, isDailyOpen, MAX_IMPORT_SOLVES, mergeSessionsBody, patchSessionBody,
  patchSolveBody, resolveCreatedAt, utcDay,
} from '../src/schemas.js';

const SID = '33333333-3333-4333-8333-333333333333';
const ID = '11111111-1111-4111-8111-111111111111';

function errorOf(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    return err as HttpError;
  }
  throw new Error('expected an error');
}

describe('createSolveBody', () => {
  const valid = { id: ID, sessionId: SID, timeMs: 12_345, penalty: 'OK', scramble: "R U R'" };

  it('accepts a valid body and applies defaults', () => {
    const b = parse(createSolveBody, { sessionId: SID, timeMs: 1 });
    expect(b.penalty).toBe('OK');
    expect(b.scramble).toBe('');
    expect(parse(createSolveBody, valid).timeMs).toBe(12_345);
  });

  it.each([
    ['timeMs 0', { timeMs: 0 }, 'timeMs'],
    ['timeMs > 24h', { timeMs: 86_400_001 }, 'timeMs'],
    ['fractional timeMs', { timeMs: 1.5 }, 'timeMs'],
    ['bad penalty', { penalty: '+4' }, 'penalty'],
    ['long scramble', { scramble: 'x'.repeat(2001) }, 'scramble'],
    ['long comment', { comment: 'x'.repeat(501) }, 'comment'],
    ['bad source', { source: 'cheat' }, 'source'],
    ['bad id', { id: 'nope' }, 'id'],
    ['bad createdAt', { createdAt: 'yesterday' }, 'createdAt'],
    ['daily index 5', { daily: { date: '2026-10-14', index: 5 } }, 'daily.index'],
    ['daily bad date', { daily: { date: '2026-02-30', index: 0 } }, 'daily.date'],
    ['daily source without daily', { source: 'daily' }, 'daily'],
  ])('rejects %s', (_name, patch, path) => {
    const err = errorOf(() => parse(createSolveBody, { ...valid, ...patch }));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(400);
    expect(err.message.startsWith(`${path}:`)).toBe(true);
  });

  it('accepts boundary values', () => {
    expect(() => parse(createSolveBody, { ...valid, timeMs: 86_400_000, scramble: 'x'.repeat(2000), comment: 'y'.repeat(500) })).not.toThrow();
    expect(() => parse(createSolveBody, { ...valid, createdAt: '2026-10-14T10:00:00+10:00' })).not.toThrow();
  });
});

describe('createSessionBody / patchSolveBody', () => {
  it('validates session name and event', () => {
    expect(parse(createSessionBody, { name: '  OH  ', event: '333oh' })).toEqual({ name: 'OH', event: '333oh', practice: false });
    expect(parse(createSessionBody, { name: 'warm up', event: '333', practice: true })).toEqual({ name: 'warm up', event: '333', practice: true });
    expect(errorOf(() => parse(createSessionBody, { name: 'x', event: '333', practice: 'yes' })).message).toMatch(/^practice:/);
    expect(errorOf(() => parse(createSessionBody, { name: '', event: '333' })).message).toMatch(/^name:/);
    expect(errorOf(() => parse(createSessionBody, { name: 'x'.repeat(41), event: '333' })).message).toMatch(/^name:/);
    expect(errorOf(() => parse(createSessionBody, { name: 'x', event: '333mbf' })).message).toMatch(/^event: unknown event/);
  });

  it('takes an optional createdAt (a cleared session keeps its place), which must be a timestamp', () => {
    const at = '2026-03-01T10:00:00.000Z';
    expect(parse(createSessionBody, { name: 'x', event: '333', createdAt: at })).toEqual({ name: 'x', event: '333', practice: false, createdAt: at });
    expect(errorOf(() => parse(createSessionBody, { name: 'x', event: '333', createdAt: 'yesterday' })).message).toMatch(/^createdAt:/);
  });

  it('renames a session and/or marks it as practice, but not neither', () => {
    expect(parse(patchSessionBody, { name: ' OH ' })).toEqual({ name: 'OH' });
    expect(parse(patchSessionBody, { practice: true })).toEqual({ practice: true });
    expect(parse(patchSessionBody, { name: 'x', practice: false })).toEqual({ name: 'x', practice: false });
    expect(() => parse(patchSessionBody, {})).toThrow(HttpError);
    expect(errorOf(() => parse(patchSessionBody, { name: '' })).message).toMatch(/^name:/);
  });

  it('requires at least one patch field, allows clearing the comment', () => {
    expect(() => parse(patchSolveBody, {})).toThrow(HttpError);
    expect(parse(patchSolveBody, { comment: null })).toEqual({ comment: null });
    expect(parse(patchSolveBody, { penalty: 'DNF' })).toEqual({ penalty: 'DNF' });
  });
});

describe('importBody', () => {
  const solve = { timeMs: 9000, penalty: 'OK', scramble: 'R', createdAt: '2020-01-01T00:00:00.000Z' };

  it('accepts sessions with solves', () => {
    const b = parse(importBody, { sessions: [{ name: 'a', event: '222', solves: [solve, { ...solve, comment: 'c' }] }] });
    expect(b.sessions[0].solves).toHaveLength(2);
  });

  it('requires createdAt and a known event', () => {
    expect(errorOf(() => parse(importBody, { sessions: [{ name: 'a', event: '333', solves: [{ timeMs: 1 }] }] })).message).toMatch(
      /createdAt/,
    );
    expect(errorOf(() => parse(importBody, { sessions: [{ name: 'a', event: 'abc', solves: [] }] })).message).toMatch(/event/);
  });

  it(`rejects more than ${MAX_IMPORT_SOLVES} solves in total`, () => {
    const half = Array.from({ length: MAX_IMPORT_SOLVES / 2 + 1 }, () => solve);
    const err = errorOf(() => parse(importBody, { sessions: [{ name: 'a', event: '333', solves: half }, { name: 'b', event: '333', solves: half }] }));
    expect(err.message).toMatch(/at most 100000 solves/);
  });
});

describe('resolveCreatedAt', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  it('defaults to now and accepts small clock skew', () => {
    expect(resolveCreatedAt(undefined, now).getTime()).toBe(now);
    expect(resolveCreatedAt('2026-10-14T12:04:00Z', now).toISOString()).toBe('2026-10-14T12:04:00.000Z');
    expect(resolveCreatedAt('2001-01-01T00:00:00Z', now).toISOString()).toBe('2001-01-01T00:00:00.000Z');
  });
  it('clamps timestamps more than 5 minutes in the future to now', () => {
    expect(resolveCreatedAt('2026-10-14T12:06:00Z', now).getTime()).toBe(now);
    expect(resolveCreatedAt('2030-01-01T00:00:00Z', now).getTime()).toBe(now);
  });
  it('rejects unparseable timestamps', () => {
    expect(errorOf(() => resolveCreatedAt('not a date', now)).statusCode).toBe(400);
  });
});

describe('assertDailyAllowed', () => {
  const now = Date.parse('2026-10-14T23:30:00Z');
  it('allows UTC yesterday, today and tomorrow for daily events', () => {
    expect(utcDay(now)).toBe('2026-10-14');
    for (const d of ['2026-10-13', '2026-10-14', '2026-10-15']) expect(() => assertDailyAllowed(d, '333', now)).not.toThrow();
  });
  it('rejects other days and non-daily events', () => {
    expect(errorOf(() => assertDailyAllowed('2026-10-12', '333', now)).statusCode).toBe(400);
    expect(errorOf(() => assertDailyAllowed('2026-10-16', '333', now)).statusCode).toBe(400);
    expect(errorOf(() => assertDailyAllowed('2026-10-14', '777', now)).message).toMatch(/no daily challenge/);
  });
  it('isDailyOpen: the same window decides when a penalty change still reaches the official attempt', () => {
    for (const d of ['2026-10-13', '2026-10-14', '2026-10-15']) expect(isDailyOpen(d, now)).toBe(true);
    for (const d of ['2026-10-12', '2026-10-16', '']) expect(isDailyOpen(d, now)).toBe(false);
  });
});

describe('mergeSessionsBody', () => {
  it('accepts 1-50 unique uuids and lower-cases them', () => {
    expect(parse(mergeSessionsBody, { sourceIds: [SID.toUpperCase()] })).toEqual({ sourceIds: [SID] });
  });
  it('rejects empty, duplicate, non-uuid and oversized lists', () => {
    expect(errorOf(() => parse(mergeSessionsBody, { sourceIds: [] })).statusCode).toBe(400);
    expect(errorOf(() => parse(mergeSessionsBody, { sourceIds: [SID, SID] })).statusCode).toBe(400);
    expect(errorOf(() => parse(mergeSessionsBody, { sourceIds: ['nope'] })).statusCode).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(errorOf(() => parse(mergeSessionsBody, { sourceIds: many })).statusCode).toBe(400);
    expect(errorOf(() => parse(mergeSessionsBody, {})).statusCode).toBe(400);
  });
});
