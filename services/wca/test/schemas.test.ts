import { describe, expect, it } from 'vitest';
import { parse, HttpError } from '@cubetype/common';
import { rankQuery } from '../src/schemas.js';

function badRequest(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(400);
    return (err as HttpError).message;
  }
  throw new Error('expected a 400');
}

describe('rankQuery', () => {
  it('coerces query strings and defaults kind to single', () => {
    expect(parse(rankQuery, { event: '333', value: '12000' })).toEqual({ event: '333', kind: 'single', value: 12000 });
    expect(parse(rankQuery, { event: '333fm', kind: 'average', value: '24.67', country: 'AU' })).toMatchObject({ value: 24.67, country: 'AU' });
  });
  it('rejects missing/invalid values', () => {
    expect(badRequest(() => parse(rankQuery, { event: '333' }))).toMatch(/value/);
    expect(badRequest(() => parse(rankQuery, { event: '333', value: 'fast' }))).toMatch(/value/);
    expect(badRequest(() => parse(rankQuery, { event: '333', value: '1', kind: 'mo3' }))).toMatch(/kind/);
    expect(badRequest(() => parse(rankQuery, { value: '1' }))).toMatch(/event/);
  });
});
