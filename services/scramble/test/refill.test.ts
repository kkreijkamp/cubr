// The background pool refill loop (refill.ts) with fake timers: what it tops up and how much,
// how it stands down for user requests and its time budget, how it survives errors and stops.
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrambleGenerator } from '../src/generator.js';
import { POOL_TARGETS, type ScramblePool } from '../src/pool.js';
import { startRefiller, type RefillOptions, type Refiller } from '../src/refill.js';
import { fakeBackend, type FakeBackend } from './fakes.js';

/** Every pool at its target, except the ones given. */
const full = (over: Record<string, number> = {}): Record<string, number> => ({ ...POOL_TARGETS, ...over });

/** Just enough of ScramblePool for the loop: available, sizes, push (which fills the sizes up). */
function fakePool(sizes: Record<string, number>) {
  const state = { up: true, failNext: null as Error | null };
  const pushed: [string, string[]][] = [];
  const pool = {
    available: () => state.up,
    sizes: vi.fn(async () => {
      if (state.failNext) {
        const err = state.failNext;
        state.failNext = null;
        throw err;
      }
      return { ...sizes };
    }),
    push: vi.fn(async (event: string, scrambles: string[]) => {
      pushed.push([event, scrambles]);
      sizes[event] = (sizes[event] ?? 0) + scrambles.length;
      return sizes[event];
    }),
  };
  return { pool: pool as unknown as ScramblePool, sizes: pool.sizes, pushed, state };
}

const scrambles = (event: string, ids: number[]) => ids.map((id) => `${event} scramble ${id}`);

describe('pool refill loop', () => {
  const warn = vi.fn();
  const log = { warn, info() {}, error() {} } as unknown as FastifyBaseLogger;
  let refiller: Refiller | null = null;
  let backend: FakeBackend;
  let generator: ScrambleGenerator;

  function start(sizes: Record<string, number>, opts: Partial<RefillOptions> = {}) {
    const p = fakePool(sizes);
    refiller = startRefiller({ pool: p.pool, generator, log }, { intervalMs: 2000, batch: 5, budgetMs: 10_000, ...opts });
    return p;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: every nap is exactly intervalMs
    backend = fakeBackend(1, 10);
    generator = new ScrambleGenerator(backend, { timeoutMs: 60_000, maxQueue: 100 });
  });
  afterEach(async () => {
    if (refiller) {
      const stopping = refiller.stop();
      await vi.runAllTimersAsync();
      await stopping;
      refiller = null;
    }
    warn.mockClear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('tops up the relatively emptiest pool with up to `batch` scrambles at refill priority, once per interval', async () => {
    const generate = vi.spyOn(generator, 'generate');
    const p = start(full({ '333': 150, '444': 40 })); // 333 misses 25 %, 444 misses 20 %
    await vi.advanceTimersByTimeAsync(1999);
    expect(p.sizes).not.toHaveBeenCalled(); // still napping

    await vi.advanceTimersByTimeAsync(101);
    expect(p.pushed).toEqual([['333', scrambles('333', [1, 2, 3, 4, 5])]]);
    expect(generate.mock.calls.map(([event, priority]) => [event, priority])).toEqual(Array(5).fill(['333', 'refill']));
    expect(refiller!.stats()).toMatchObject({ enabled: true, cycles: 1, pushed: 5, lastEvent: '333', lastError: null, pausedCycles: 0 });

    await vi.advanceTimersByTimeAsync(2100); // 333 still misses 22.5 %
    expect(p.pushed.map(([event, batch]) => [event, batch.length])).toEqual([
      ['333', 5],
      ['333', 5],
    ]);
  });

  it('never generates past what a pool is missing', async () => {
    const p = start(full({ '444': 47 }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(p.pushed).toEqual([['444', scrambles('444', [1, 2, 3])]]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(p.pushed).toHaveLength(1); // full now
    expect(refiller!.stats()).toMatchObject({ cycles: 2, pushed: 3 });
  });

  it('stands down while a user request is being served, and for a second after', async () => {
    backend.behave = (event) => (event === '777' ? 2500 : 10);
    const p = start(full({ '333': 0 }));
    const request = generator.generate('777', 'request'); // runs from 0 to 2500 ms
    await vi.advanceTimersByTimeAsync(2100);
    expect(p.sizes).not.toHaveBeenCalled();
    expect(refiller!.stats()).toMatchObject({ pausedCycles: 1, cycles: 0, pushed: 0, paused: true });

    await vi.advanceTimersByTimeAsync(400);
    await request;
    await vi.advanceTimersByTimeAsync(1600); // next cycle at 4000: 1.5 s after the request
    expect(p.pushed).toEqual([['333', scrambles('333', [2, 3, 4, 5, 6])]]);
  });

  it('stops a batch early when a request comes in, keeping what it already generated', async () => {
    backend.behave = () => 100;
    const p = start(full({ '333': 0 }));
    await vi.advanceTimersByTimeAsync(2050); // the first refill search is running
    const request = generator.generate('222', 'request');
    await vi.advanceTimersByTimeAsync(200);
    expect(await request).toBe('222 scramble 2'); // it went next, before any more refills
    expect(p.pushed).toEqual([['333', ['333 scramble 1']]]);
    expect(backend.calls.map((c) => c.event)).toEqual(['333', '222']);
  });

  it('stops a batch once its time budget is spent', async () => {
    backend.behave = () => 100;
    const p = start(full({ '333': 0 }), { budgetMs: 250 });
    await vi.advanceTimersByTimeAsync(2000 + 5 * 100);
    expect(p.pushed).toEqual([['333', scrambles('333', [1, 2, 3])]]); // 300 ms > 250 ms after the third
  });

  it('does nothing while Redis is unavailable, and resumes once it is back', async () => {
    const p = start(full({ '333': 0 }));
    p.state.up = false;
    await vi.advanceTimersByTimeAsync(4100);
    expect(p.sizes).not.toHaveBeenCalled();
    expect(backend.calls).toEqual([]);
    p.state.up = true;
    await vi.advanceTimersByTimeAsync(2100);
    expect(p.pushed).toHaveLength(1);
  });

  it('records a failed cycle, warns once and carries on', async () => {
    const p = start(full({ '333': 0 }));
    p.state.failNext = new Error('redis command timed out');
    await vi.advanceTimersByTimeAsync(2100);
    expect(refiller!.stats()).toMatchObject({ lastError: 'redis command timed out', pushed: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2100);
    expect(refiller!.stats()).toMatchObject({ lastError: null, pushed: 5 });
  });

  it('stops at once in the middle of a nap', async () => {
    const p = start(full({ '333': 0 }));
    await vi.advanceTimersByTimeAsync(500);
    await refiller!.stop(); // no need for the 2 s to pass
    refiller = null;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.sizes).not.toHaveBeenCalled();
  });

  it('finishes the search in hand when stopped mid-batch, keeps it, and starts no more', async () => {
    backend.behave = () => 100;
    const p = start(full({ '333': 0 }));
    await vi.advanceTimersByTimeAsync(2050);
    const stopping = refiller!.stop();
    refiller = null;
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    expect(p.pushed).toEqual([['333', ['333 scramble 1']]]);
    expect(backend.calls).toHaveLength(1);
  });
});
