import { describe, expect, it } from 'vitest';
import { HttpError, parse } from '@cubetype/common';
import { createSessionBody, createSolveBody, patchSolveBody, resolveCreatedAt } from '../src/schemas.js';

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
    expect(parse(createSessionBody, { name: '  OH  ', event: '333oh' })).toEqual({ name: 'OH', event: '333oh' });
    expect(errorOf(() => parse(createSessionBody, { name: '', event: '333' })).message).toMatch(/^name:/);
    expect(errorOf(() => parse(createSessionBody, { name: 'x'.repeat(41), event: '333' })).message).toMatch(/^name:/);
    expect(errorOf(() => parse(createSessionBody, { name: 'x', event: '333mbf' })).message).toMatch(/^event: unknown event/);
  });

  it('requires at least one patch field, allows clearing the comment', () => {
    expect(() => parse(patchSolveBody, {})).toThrow(HttpError);
    expect(parse(patchSolveBody, { comment: null })).toEqual({ comment: null });
    expect(parse(patchSolveBody, { penalty: 'DNF' })).toEqual({ penalty: 'DNF' });
  });
});

describe('resolveCreatedAt', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  it('defaults to now and accepts small clock skew', () => {
    expect(resolveCreatedAt(undefined, now).getTime()).toBe(now);
    expect(resolveCreatedAt('2026-10-14T12:04:00Z', now).toISOString()).toBe('2026-10-14T12:04:00.000Z');
    expect(resolveCreatedAt('2001-01-01T00:00:00Z', now).toISOString()).toBe('2001-01-01T00:00:00.000Z');
  });
  it('rejects timestamps more than 5 minutes in the future', () => {
    expect(errorOf(() => resolveCreatedAt('2026-10-14T12:06:00Z', now)).statusCode).toBe(400);
  });
});
