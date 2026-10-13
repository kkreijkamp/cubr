import { describe, expect, it } from 'vitest';
import { HttpError } from '@cubetype/common';
import type { ScrambleBackend } from '../src/backends.js';
import { GenerationTimeoutError, QueueFullError, toHttpError } from '../src/errors.js';
import { ScrambleGenerator } from '../src/generator.js';
import { withTimeout } from '../src/util.js';

/** Fake backend: each run waits `ms` (or forever for event 'hang') and records the call order. */
function fakeBackend(size: number, ms = 5) {
  const calls: { slot: number; event: string }[] = [];
  const backend: ScrambleBackend = {
    kind: 'fake',
    size,
    run: (slot, event, timeoutMs) => {
      calls.push({ slot, event });
      const work = new Promise<string>((resolve) => {
        if (event !== 'hang') setTimeout(() => resolve(`${event}#${calls.length}`), ms);
      });
      return withTimeout(work, timeoutMs, () => new GenerationTimeoutError());
    },
    close: async () => {},
  };
  return { backend, calls };
}

describe('ScrambleGenerator', () => {
  it('runs one search at a time on a single-slot backend and reports queue depth', async () => {
    const { backend, calls } = fakeBackend(1);
    const gen = new ScrambleGenerator(backend, { timeoutMs: 1000, maxQueue: 100 });
    const all = gen.generateMany('333', 3);
    expect(gen.active).toBe(1);
    expect(gen.queueDepth).toBe(2);
    expect(await all).toHaveLength(3);
    expect(calls.map((c) => c.slot)).toEqual([0, 0, 0]);
    expect(gen.queueDepth).toBe(0);
    expect(gen.stats()).toMatchObject({ generated: 3, failed: 0, timeouts: 0, perEvent: { '333': { count: 3 } } });
  });

  it('lets requests overtake queued refills', async () => {
    const { backend, calls } = fakeBackend(1);
    const gen = new ScrambleGenerator(backend, { timeoutMs: 1000, maxQueue: 100 });
    const p = [gen.generate('r1', 'refill'), gen.generate('r2', 'refill'), gen.generate('r3', 'refill')];
    p.push(gen.generate('req', 'request'));
    await Promise.all(p);
    // r1 was already running; the request jumps ahead of r2/r3
    expect(calls.map((c) => c.event)).toEqual(['r1', 'req', 'r2', 'r3']);
  });

  it('is busy while requests run and shortly after', async () => {
    const { backend } = fakeBackend(1);
    const gen = new ScrambleGenerator(backend, { timeoutMs: 1000, maxQueue: 100 });
    expect(gen.isBusy()).toBe(false);
    await gen.generate('333', 'refill');
    expect(gen.isBusy()).toBe(false); // refills never make the generator "busy"
    const p = gen.generate('333');
    expect(gen.isBusy()).toBe(true);
    await p;
    expect(gen.isBusy(1000)).toBe(true);
    expect(gen.isBusy(0)).toBe(false);
  });

  it('uses every slot of a multi-slot backend', async () => {
    const { backend, calls } = fakeBackend(3, 20);
    const gen = new ScrambleGenerator(backend, { timeoutMs: 1000, maxQueue: 100 });
    const many = gen.generateMany('444', 3);
    expect(gen.active).toBe(3);
    await many;
    expect(new Set(calls.map((c) => c.slot))).toEqual(new Set([0, 1, 2]));
  });

  it('times out stuck searches and expires tasks that waited too long', async () => {
    const { backend, calls } = fakeBackend(1);
    const gen = new ScrambleGenerator(backend, { timeoutMs: 50, maxQueue: 100 });
    const stuck = gen.generate('hang');
    const queued = gen.generate('333');
    await expect(stuck).rejects.toBeInstanceOf(GenerationTimeoutError);
    await expect(queued).rejects.toBeInstanceOf(GenerationTimeoutError);
    expect(calls.map((c) => c.event)).toEqual(['hang']); // the queued one never ran
    expect(gen.stats().timeouts).toBe(2);
    // the slot is free again afterwards
    await expect(gen.generate('333')).resolves.toMatch(/^333#/);
  });

  it('sheds load when the queue is full', async () => {
    const { backend } = fakeBackend(1);
    const gen = new ScrambleGenerator(backend, { timeoutMs: 1000, maxQueue: 5 });
    const ok = gen.generateMany('333', 5);
    await expect(gen.generateMany('333', 2)).rejects.toBeInstanceOf(QueueFullError);
    expect(gen.stats().rejected).toBe(2);
    await ok;
  });

  it('rejects queued work on close', async () => {
    const { backend } = fakeBackend(1, 30);
    const gen = new ScrambleGenerator(backend, { timeoutMs: 1000, maxQueue: 100 });
    const running = gen.generate('333');
    const queued = gen.generate('333');
    await gen.close();
    await expect(queued).rejects.toThrow(/shutting down/);
    await running;
  });
});

describe('toHttpError', () => {
  it('maps timeouts and overload to 503 UNAVAILABLE', () => {
    for (const err of [new GenerationTimeoutError(), new QueueFullError()]) {
      const mapped = toHttpError(err) as HttpError;
      expect(mapped).toBeInstanceOf(HttpError);
      expect(mapped.statusCode).toBe(503);
      expect(mapped.code).toBe('UNAVAILABLE');
    }
  });

  it('passes other errors through', () => {
    const err = new Error('boom');
    expect(toHttpError(err)).toBe(err);
  });
});
