import { describe, expect, it } from 'vitest';
import { EVENT_IDS } from '@cubr/cubestats';
import { POOL_TARGETS, pickRefillEvent, poolKey } from '../src/pool.js';

const full = (): Record<string, number> => ({ ...POOL_TARGETS });

describe('POOL_TARGETS', () => {
  it('has a target for every supported event (and nothing else)', () => {
    expect(Object.keys(POOL_TARGETS).sort()).toEqual([...EVENT_IDS].sort());
    expect(POOL_TARGETS['333mbf']).toBeUndefined();
  });

  it('matches SPEC section 9.2', () => {
    for (const e of ['333', '222', 'pyram', 'skewb']) expect(POOL_TARGETS[e]).toBe(200);
    for (const e of ['444', 'sq1', 'clock', 'minx', '333oh', '333bf', '333fm']) expect(POOL_TARGETS[e]).toBe(50);
    for (const e of ['555', '666', '777', '444bf', '555bf']) expect(POOL_TARGETS[e]).toBe(20);
  });

  it('uses the scramble:pool:<event> key', () => {
    expect(poolKey('333')).toBe('scramble:pool:333');
  });
});

describe('pickRefillEvent', () => {
  it('starts with 333 when every pool is empty', () => {
    expect(pickRefillEvent({})).toEqual({ event: '333', deficit: 200 });
  });

  it('returns null when every pool is at (or above) its target', () => {
    expect(pickRefillEvent(full())).toBeNull();
    expect(pickRefillEvent({ ...full(), '333': 250 })).toBeNull();
  });

  it('picks the relatively emptiest pool', () => {
    // 333 misses 100/200 (50 %), 444 misses 40/50 (80 %)
    expect(pickRefillEvent({ ...full(), '333': 100, '444': 10 })).toEqual({ event: '444', deficit: 40 });
  });

  it('breaks ratio ties by the larger absolute deficit', () => {
    // both 50 % empty: 333 misses 100, 444 misses 25
    expect(pickRefillEvent({ ...full(), '444': 25, '333': 100 })).toEqual({ event: '333', deficit: 100 });
  });

  it('treats missing and negative sizes as empty', () => {
    expect(pickRefillEvent({ ...full(), '555bf': undefined as unknown as number })).toEqual({ event: '555bf', deficit: 20 });
    expect(pickRefillEvent({ ...full(), skewb: -3 })).toEqual({ event: 'skewb', deficit: 200 });
  });

  it('ignores events without a target', () => {
    expect(pickRefillEvent({ ...full() }, { '333mbf': 10, ...POOL_TARGETS }, ['333mbf', ...EVENT_IDS])).toEqual({
      event: '333mbf',
      deficit: 10,
    });
    expect(pickRefillEvent(full(), POOL_TARGETS, ['bogus'])).toBeNull();
  });
});
