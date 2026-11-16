// ScramblePool when Redis misbehaves (fake timers, a stub client): commands give up after 250 ms,
// a failure opens a 3 s circuit breaker during which Redis is not even asked, and _info keeps the
// last sizes it saw. Requests then generate directly (see scrambles.integration.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from '@cubr/common';
import { EVENT_IDS } from '@cubr/cubestats';
import { ScramblePool } from '../src/pool.js';

describe('ScramblePool resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a command after 250 ms and leaves Redis alone for 3 s', async () => {
    const lpop = vi.fn((_key: string, _count: number): Promise<string[] | null> => new Promise(() => {}));
    const pool = new ScramblePool({ status: 'ready', lpop } as unknown as Redis);
    const stuck = expect(pool.take('333', 2)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(250);
    await stuck;

    expect(pool.available()).toBe(false);
    await expect(pool.take('333', 2)).rejects.toThrow(/unavailable/);
    expect(lpop).toHaveBeenCalledTimes(1); // not asked while the breaker is open

    await vi.advanceTimersByTimeAsync(3000);
    expect(pool.available()).toBe(true);
    lpop.mockResolvedValueOnce(['s1', 's2']);
    expect(await pool.take('333', 2)).toEqual(['s1', 's2']);
  });

  it('opens the breaker after a command error as well', async () => {
    const lpop = vi.fn().mockRejectedValueOnce(new Error('LOADING Redis is loading the dataset in memory'));
    const pool = new ScramblePool({ status: 'ready', lpop } as unknown as Redis, { cooldownMs: 1000 });
    await expect(pool.take('222', 1)).rejects.toThrow(/LOADING/);
    expect(pool.available()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pool.available()).toBe(true);
  });

  it('is unavailable while the connection is not ready, without sending anything', async () => {
    const lpop = vi.fn();
    const pool = new ScramblePool({ status: 'reconnecting', lpop } as unknown as Redis);
    expect(pool.available()).toBe(false);
    await expect(pool.take('333', 1)).rejects.toThrow(/unavailable/);
    expect(lpop).not.toHaveBeenCalled();
  });

  it('keeps reporting the last sizes it saw, with their age, while Redis is down', async () => {
    let fail = false;
    const redis = {
      status: 'ready',
      pipeline() {
        const pipe = {
          llen: () => pipe,
          exec: async () => {
            if (fail) throw new Error('connection reset');
            return EVENT_IDS.map(() => [null, 7]);
          },
        };
        return pipe;
      },
    } as unknown as Redis;
    const pool = new ScramblePool(redis);
    expect(await new ScramblePool({ ...redis, status: 'end' } as unknown as Redis).cachedSizes()).toBeNull(); // never seen any

    const first = await pool.cachedSizes();
    expect(first).toEqual({ sizes: Object.fromEntries(EVENT_IDS.map((e) => [e, 7])), ageMs: 0 });
    fail = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pool.cachedSizes()).toEqual({ sizes: first!.sizes, ageMs: 5000 });
    expect(pool.available()).toBe(false);
  });
});
