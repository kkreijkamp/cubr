// The start-up warm-up (warmup.ts) with fake timers: every backend slot builds every event's
// tables once; readiness waits for it; a total failure retries instead of reporting ready.
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrambleGenerator } from '../src/generator.js';
import { jobLabel } from '../src/practice.js';
import { WARMUP_EVENTS, newWarmupState, warmUp } from '../src/warmup.js';
import { fakeBackend } from './fakes.js';

const log = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

describe('warm-up', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs one search per warm-up event on every backend slot, then reports ready with the timings', async () => {
    const backend = fakeBackend(2, 7);
    const generator = new ScrambleGenerator(backend, { timeoutMs: 30_000, maxQueue: 100 });
    const state = newWarmupState();
    const done = warmUp(generator, state, log);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(WARMUP_EVENTS.length * 7);
    await done;
    for (const slot of [0, 1]) expect(backend.calls.filter((c) => c.slot === slot).map((c) => c.event)).toEqual(WARMUP_EVENTS);
    expect(state).toEqual({
      done: true,
      totalMs: WARMUP_EVENTS.length * 7, // the slots warm up side by side
      timings: Object.fromEntries(WARMUP_EVENTS.map((e) => [jobLabel(e), 7])),
      failures: [],
    });
  });

  it('notes the events that failed but reports ready when the others worked', async () => {
    const backend = fakeBackend(1, 1);
    backend.behave = (event) => (event === '444' || event === 'sq1' ? new Error(`no tables for ${event}`) : 1);
    const state = newWarmupState();
    const done = warmUp(new ScrambleGenerator(backend, { timeoutMs: 30_000, maxQueue: 100 }), state, log);
    await vi.advanceTimersByTimeAsync(WARMUP_EVENTS.length);
    await done;
    expect(state.done).toBe(true);
    expect(state.failures).toEqual(['444: no tables for 444', 'sq1: no tables for sq1']);
    expect(Object.keys(state.timings).sort()).toEqual(
      WARMUP_EVENTS.filter((e) => e !== '444' && e !== 'sq1')
        .map(jobLabel)
        .sort(),
    );
  });

  it('retries every 5 s while every event fails, instead of reporting ready', async () => {
    const backend = fakeBackend(1, 1);
    let broken = true;
    backend.behave = () => (broken ? new Error('cubing.js failed to load') : 1);
    const state = newWarmupState();
    let finished = false;
    const done = warmUp(new ScrambleGenerator(backend, { timeoutMs: 30_000, maxQueue: 100 }), state, log).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(4900);
    expect(finished).toBe(false);
    expect(state.done).toBe(false);
    expect(state.failures).toHaveLength(WARMUP_EVENTS.length);
    expect(backend.calls).toHaveLength(WARMUP_EVENTS.length); // no second attempt yet

    broken = false;
    await vi.advanceTimersByTimeAsync(100 + WARMUP_EVENTS.length);
    await done;
    expect(state).toMatchObject({ done: true, failures: [] });
    expect(backend.calls).toHaveLength(2 * WARMUP_EVENTS.length);
  });
});
