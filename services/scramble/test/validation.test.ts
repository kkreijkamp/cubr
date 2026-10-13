import { describe, expect, it } from 'vitest';
import { HttpError, parse } from '@cubetype/common';
import { scrambleQuerySchema } from '../src/validation.js';

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
