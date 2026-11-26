import type { FastifyBaseLogger } from 'fastify';
import type { ScrambleGenerator } from './generator.js';
import { encodeSolveJob, jobLabel, practiceJob } from './practice.js';
import { errorMessage, sleep } from './util.js';

/**
 * Events whose first scramble is slow because cubing.js builds search tables (4x4x4 ~1-3 s,
 * 333fm/sq1 up to ~2 s, kilominx ~4.5 s). The other events reuse these tables or are random-move
 * scramblers. The two practice solves warm the 3x3 and 2x2 solvers (practice.ts).
 */
export const WARMUP_EVENTS = [
  '333',
  '222',
  '444',
  'sq1',
  '333fm',
  'pyram',
  'skewb',
  'clock',
  'minx',
  'fto',
  'kilominx',
  'master_tetraminx',
  'redi_cube',
  warmupSolve('pll'),
  warmupSolve('222eg0'),
];

function warmupSolve(type: string): string {
  const job = practiceJob(type);
  if (!job) throw new Error(`no practice job for ${type}`);
  return encodeSolveJob(job.puzzle, job.state);
}

export interface WarmupState {
  done: boolean;
  totalMs: number | null;
  /** ms per event (from worker 0) */
  timings: Record<string, number>;
  failures: string[];
}

export function newWarmupState(): WarmupState {
  return { done: false, totalMs: null, timings: {}, failures: [] };
}

/**
 * Generates one scramble per WARMUP_EVENTS event, sequentially, on every backend slot so the
 * first real request does not pay the table-initialisation cost. Readiness stays 503 until this
 * finishes. If every event fails (cubing.js broken), it retries instead of reporting ready.
 */
export async function warmUp(generator: ScrambleGenerator, state: WarmupState, log: FastifyBaseLogger): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    state.failures = [];
    let succeeded = 0;
    await Promise.all(
      Array.from({ length: generator.size }, async (_, slot) => {
        for (const event of WARMUP_EVENTS) {
          const t0 = performance.now();
          try {
            await generator.generate(event, 'request', slot);
            const ms = Math.round(performance.now() - t0);
            succeeded++;
            if (slot === 0) state.timings[jobLabel(event)] = ms;
            log.info({ event: jobLabel(event), ms, slot }, 'warm-up scramble generated');
          } catch (err) {
            state.failures.push(`${jobLabel(event)}: ${errorMessage(err)}`);
            log.error({ event: jobLabel(event), slot, err: errorMessage(err) }, 'warm-up scramble failed');
          }
        }
      }),
    );
    state.totalMs = Math.round(performance.now() - started);
    if (succeeded > 0) {
      state.done = true;
      const rssMB = Math.round(process.memoryUsage().rss / 1048576);
      log.info({ totalMs: state.totalMs, timings: state.timings, failures: state.failures.length, rssMB }, 'warm-up complete');
      return;
    }
    log.error({ attempt }, 'warm-up failed for every event, retrying in 5 s');
    await sleep(5000);
  }
}
