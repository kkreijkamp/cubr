import type { FastifyBaseLogger } from 'fastify';
import type { ScrambleGenerator } from './generator.js';
import { pickRefillEvent, type ScramblePool } from './pool.js';
import { errorMessage, throttledWarn } from './util.js';

export interface RefillOptions {
  intervalMs: number;
  batch: number;
  /** stop a cycle's batch early once this much generation time was spent (keeps refill CPU low) */
  budgetMs: number;
}

export interface Refiller {
  stop(): Promise<void>;
  stats(): Record<string, unknown>;
}

/**
 * Background loop running in every replica: roughly every `intervalMs` it picks the emptiest
 * Redis pool and generates up to `batch` scrambles (within `budgetMs`) for it at low priority. It
 * stands down while user requests are being served, so it soaks up idle CPU only - and it never
 * affects correctness: an empty pool just means requests generate on the fly.
 */
export function startRefiller(deps: { pool: ScramblePool; generator: ScrambleGenerator; log: FastifyBaseLogger }, opts: RefillOptions): Refiller {
  const { pool, generator, log } = deps;
  const warn = throttledWarn(log, 15_000);
  let running = true;
  let wake: (() => void) | null = null;
  const stats = { cycles: 0, pausedCycles: 0, pushed: 0, lastEvent: null as string | null, lastError: null as string | null };

  // +/-25 % jitter so replicas started together do not refill in lock-step.
  const nap = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.intervalMs * (0.75 + Math.random() * 0.5));
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

  async function cycle() {
    if (generator.isBusy()) {
      stats.pausedCycles++;
      return;
    }
    if (!pool.available()) return;
    const pick = pickRefillEvent(await pool.sizes());
    stats.cycles++;
    if (!pick) return;
    const batch: string[] = [];
    const n = Math.min(opts.batch, pick.deficit);
    const started = performance.now();
    for (let i = 0; i < n && running && !generator.isBusy(); i++) {
      batch.push(await generator.generate(pick.event, 'refill'));
      await yieldToEventLoop();
      // a 4x4x4 batch of 5 would be ~0.75 s of CPU every 2 s - enough to skew the HPA's CPU metric
      if (performance.now() - started > opts.budgetMs) break;
    }
    if (batch.length > 0) {
      await pool.push(pick.event, batch);
      stats.pushed += batch.length;
      stats.lastEvent = pick.event;
    }
  }

  const loop = (async () => {
    while (running) {
      await nap();
      if (!running) break;
      try {
        await cycle();
        stats.lastError = null;
      } catch (err) {
        stats.lastError = errorMessage(err);
        warn('refill', { err: stats.lastError }, 'scramble pool refill failed (requests fall back to direct generation)');
      }
    }
  })();

  return {
    async stop() {
      running = false;
      wake?.();
      await loop;
    },
    stats: () => ({ enabled: true, ...opts, paused: generator.isBusy(), ...stats }),
  };
}
