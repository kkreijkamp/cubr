import { Worker } from 'node:worker_threads';
import type { FastifyBaseLogger } from 'fastify';
import { GenerationTimeoutError } from './errors.js';
import { errorMessage, withTimeout } from './util.js';

/**
 * Something that can run scramble searches. `size` = how many can run in parallel; the
 * generator queue (generator.ts) hands each search to a free `slot` (0 ... size-1).
 */
export interface ScrambleBackend {
  readonly kind: 'in-process' | 'worker-pool';
  readonly size: number;
  run(slot: number, event: string, timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

// Prefetching would make cubing.js search for the *next* scramble in advance (doubling CPU
// for us); logPerf prints timing noise to stdout.
const SEARCH_DEBUG = { logPerf: false, scramblePrefetchLevel: 'none' } as const;

/**
 * Default backend: cubing.js in the main thread. cubing.js itself runs every search on ONE
 * internal worker thread, so the HTTP event loop stays responsive while the CPU work happens
 * off-thread - but searches are effectively sequential (size = 1).
 */
export async function createInProcessBackend(): Promise<ScrambleBackend> {
  // Dynamic import: cubing is an *external* of the esbuild bundle (it spawns its own worker
  // files), so it is resolved from node_modules at runtime.
  const [{ randomScrambleForEvent }, { setSearchDebug }] = await Promise.all([
    import('cubing/scramble'),
    import('cubing/search'),
  ]);
  setSearchDebug(SEARCH_DEBUG);
  return {
    kind: 'in-process',
    size: 1,
    run: (_slot, event, timeoutMs) =>
      withTimeout(
        randomScrambleForEvent(event).then((alg) => alg.toString()),
        timeoutMs,
        () => new GenerationTimeoutError(),
      ),
    close: async () => {},
  };
}

// Code for each pool thread (evaluated as CommonJS, so no extra file has to survive bundling).
// It imports cubing.js by absolute URL - each thread gets its own cubing instance + search worker.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { setSearchDebug } = await import(workerData.searchUrl);
  setSearchDebug(workerData.searchDebug);
  const { randomScrambleForEvent } = await import(workerData.scrambleUrl);
  parentPort.on('message', async (msg) => {
    try {
      const alg = await randomScrambleForEvent(msg.event);
      parentPort.postMessage({ type: 'result', id: msg.id, scramble: alg.toString() });
    } catch (err) {
      parentPort.postMessage({ type: 'result', id: msg.id, error: String((err && err.message) || err) });
    }
  });
  parentPort.postMessage({ type: 'ready' });
})();
`;

interface Pending {
  id: number;
  resolve: (s: string) => void;
  reject: (e: Error) => void;
}

/** One pool thread. Handles one search at a time (the generator guarantees that). */
class PoolThread {
  private worker!: Worker;
  private ready!: Promise<void>;
  private pending: Pending | null = null;
  private seq = 0;
  private closing = false;
  restarts = 0;

  constructor(
    private readonly index: number,
    private readonly data: Record<string, unknown>,
    private readonly log: FastifyBaseLogger,
  ) {
    this.spawn();
  }

  private spawn() {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: this.data });
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      worker.on('message', (msg: { type: string; id?: number; scramble?: string; error?: string }) => {
        if (msg.type === 'ready') return resolve();
        if (msg.type !== 'result' || !this.pending || msg.id !== this.pending.id) return;
        const p = this.pending;
        this.pending = null;
        if (msg.error !== undefined) p.reject(new Error(msg.error));
        else p.resolve(msg.scramble ?? '');
      });
      worker.on('error', (err) => {
        this.log.error({ err: err.message, thread: this.index }, 'scramble worker crashed');
        reject(err);
      });
      worker.on('exit', (code) => {
        reject(new Error(`worker exited (${code})`));
        if (this.worker !== worker) return; // replaced on purpose (timeout)
        this.pending?.reject(new Error(`scramble worker exited with code ${code}`));
        this.pending = null;
        if (!this.closing) {
          this.restarts++;
          setTimeout(() => !this.closing && this.spawn(), 1000).unref();
        }
      });
    });
    this.ready.catch(() => {}); // surfaced through run()
  }

  async run(event: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    await withTimeout(this.ready, timeoutMs, () => new GenerationTimeoutError('scramble worker not ready'));
    const id = ++this.seq;
    const result = new Promise<string>((resolve, reject) => {
      this.pending = { id, resolve, reject };
    });
    this.worker.postMessage({ id, event });
    try {
      return await withTimeout(result, deadline - Date.now(), () => new GenerationTimeoutError());
    } catch (err) {
      if (err instanceof GenerationTimeoutError) {
        // A stuck search can only be stopped by killing its thread; start a fresh one
        // (its first search re-initialises cubing.js tables, ~1-3 s for 4x4x4).
        this.log.warn({ thread: this.index, event }, 'scramble search timed out, restarting worker');
        this.pending = null;
        const old = this.worker;
        this.restarts++;
        this.spawn();
        void old.terminate();
      }
      throw err;
    }
  }

  async close() {
    this.closing = true;
    await this.worker.terminate().catch(() => {});
  }
}

/**
 * Optional backend (SCRAMBLE_WORKERS > 1): N worker threads, each with its own cubing.js, so a
 * pod can use N cores. On Kubernetes, scaling out (more pods, HPA) is usually the better lever.
 */
export function createWorkerPoolBackend(size: number, log: FastifyBaseLogger): ScrambleBackend {
  const data = {
    scrambleUrl: import.meta.resolve('cubing/scramble'),
    searchUrl: import.meta.resolve('cubing/search'),
    searchDebug: SEARCH_DEBUG,
  };
  const threads = Array.from({ length: size }, (_, i) => new PoolThread(i, data, log));
  return {
    kind: 'worker-pool',
    size,
    run: (slot, event, timeoutMs) => threads[slot].run(event, timeoutMs),
    close: async () => {
      await Promise.all(threads.map((t) => t.close()));
    },
  };
}

export async function createBackend(workers: number, log: FastifyBaseLogger): Promise<ScrambleBackend> {
  if (workers <= 1) return createInProcessBackend();
  try {
    return createWorkerPoolBackend(workers, log);
  } catch (err) {
    log.error({ err: errorMessage(err) }, 'worker pool unavailable, falling back to in-process cubing.js');
    return createInProcessBackend();
  }
}
