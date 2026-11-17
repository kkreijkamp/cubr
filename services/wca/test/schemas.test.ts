import { describe, expect, it } from 'vitest';
import { parse, HttpError } from '@cubr/common';
import { distributionQuery, escapeLike, personParams, personSearchQuery, rankQuery } from '../src/schemas.js';

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
    expect(badRequest(() => parse(rankQuery, { event: '333', value: 'Infinity' }))).toMatch(/value must be a number/);
    expect(badRequest(() => parse(rankQuery, { event: '333', value: '1', kind: 'mo3' }))).toMatch(/kind/);
    expect(badRequest(() => parse(rankQuery, { value: '1' }))).toMatch(/event/);
  });
});

describe('distributionQuery', () => {
  it('defaults to 50 buckets and bounds the count', () => {
    expect(parse(distributionQuery, { event: '333' }).buckets).toBe(50);
    expect(badRequest(() => parse(distributionQuery, { event: '333', buckets: '0' }))).toMatch(/buckets/);
    expect(badRequest(() => parse(distributionQuery, { event: '333', buckets: '601' }))).toMatch(/buckets/);
    expect(badRequest(() => parse(distributionQuery, { event: '333', buckets: '2.5' }))).toMatch(/buckets/);
  });
});

describe('personSearchQuery', () => {
  it('trims q and limits results to 50', () => {
    expect(parse(personSearchQuery, { q: '  feliks ' })).toEqual({ q: 'feliks', limit: 20 });
    expect(badRequest(() => parse(personSearchQuery, { q: '   ' }))).toMatch(/q/);
    expect(badRequest(() => parse(personSearchQuery, { q: 'a', limit: '51' }))).toMatch(/limit/);
  });
});

describe('personParams', () => {
  it('normalises WCA ids to upper case', () => {
    expect(parse(personParams, { wcaId: '2009zemd01' })).toEqual({ wcaId: '2009ZEMD01' });
  });
  it('rejects malformed ids', () => {
    expect(badRequest(() => parse(personParams, { wcaId: 'feliks' }))).toMatch(/2009ZEMD01/);
    expect(badRequest(() => parse(personParams, { wcaId: "2009ZEMD01' OR 1=1" }))).toMatch(/wcaId/);
  });
});

describe('escapeLike', () => {
  it('escapes LIKE wildcards so they match literally', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('Feliks')).toBe('Feliks');
  });
});
