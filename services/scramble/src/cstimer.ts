// csTimer's own scramblers and puzzle drawings (npm `cstimer_module`, GPL-3.0 like cubr, by Chen
// Shuang, csTimer's author) for the scramble types cubing.js and cubr's own code don't make
// (packages/cubestats/src/scrambleTypes.ts). The module runs in a worker thread of its own: a slow
// or stuck scrambler never holds up the HTTP event loop, and a stuck one is killed and replaced.
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { GenerationTimeoutError, QueueFullError } from './errors.js';

// The thread: loads the module once, then answers one message at a time (CommonJS, evaluated, so
// no extra file has to survive bundling; the module itself is resolved from node_modules).
const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const cs = require(workerData.path);
parentPort.on('message', (m) => {
  let out = null;
  let error;
  try {
    out = m.kind === 'image' ? cs.getImage(m.scramble, m.type) || null : String(cs.getScramble(m.type, m.length));
  } catch (e) {
    error = String((e && e.message) || e);
  }
  parentPort.postMessage({ id: m.id, out, error });
});
`;

export interface CsTimerStats {
  requests: number;
  failed: number;
  timeouts: number;
  rejected: number;
  restarts: number;
  inFlight: number;
}

export interface CsTimerHost {
  /** a scramble of csTimer type `type` (`length`: csTimer's length setting, 0 for its default) */
  scramble(type: string, length: number): Promise<string>;
  /** csTimer's SVG of `scramble` on the puzzle of type `type`, or null when it can't draw it */
  image(type: string, scramble: string): Promise<string | null>;
  stats(): CsTimerStats;
  close(): Promise<void>;
}

interface Pending {
  resolve: (v: string | null) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function createCsTimerHost(opts: { timeoutMs: number; maxQueue: number; path?: string }): CsTimerHost {
  const path = opts.path ?? createRequire(import.meta.url).resolve('cstimer_module');
  let worker: Worker | null = null;
  let closing = false;
  let seq = 0;
  const pending = new Map<number, Pending>();
  const stats: CsTimerStats = { requests: 0, failed: 0, timeouts: 0, rejected: 0, restarts: 0, inFlight: 0 };

  const failAll = (err: Error) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(err);
    }
  };

  const spawn = (): Worker => {
    const w = new Worker(SOURCE, { eval: true, workerData: { path } });
    w.unref();
    w.on('message', (m: { id: number; out: string | null; error?: string }) => {
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      if (m.error !== undefined) {
        stats.failed++;
        p.reject(new Error(`csTimer: ${m.error}`));
      } else p.resolve(m.out);
    });
    const gone = (why: string) => {
      if (worker !== w) return;
      worker = null; // the next request starts a fresh thread
      failAll(new Error(`csTimer worker ${why}`));
    };
    w.on('error', (err) => gone(`crashed: ${err.message}`));
    w.on('exit', (code) => gone(`exited (${code})`));
    return w;
  };

  const call = (msg: { kind: 'scramble'; type: string; length: number } | { kind: 'image'; type: string; scramble: string }): Promise<string | null> => {
    if (closing) return Promise.reject(new Error('csTimer host closed'));
    if (pending.size >= opts.maxQueue) {
      stats.rejected++;
      return Promise.reject(new QueueFullError());
    }
    if (!worker) worker = spawn();
    const w = worker;
    const id = ++seq;
    stats.requests++;
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        // a scrambler that runs away can only be stopped with its thread: replace it
        stats.timeouts++;
        stats.restarts++;
        pending.delete(id);
        reject(new GenerationTimeoutError('csTimer scramble timed out'));
        if (worker === w) {
          worker = null;
          failAll(new GenerationTimeoutError('csTimer worker restarted'));
        }
        void w.terminate();
      }, opts.timeoutMs);
      pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, ...msg });
    });
  };

  return {
    scramble: async (type, length) => {
      const s = await call({ kind: 'scramble', type, length });
      if (!s || !s.trim()) throw new Error(`csTimer made no ${type} scramble`);
      return s.trim();
    },
    image: (type, scramble) => call({ kind: 'image', type, scramble }),
    stats: () => ({ ...stats, inFlight: pending.size }),
    close: async () => {
      closing = true;
      failAll(new Error('csTimer host closed'));
      await worker?.terminate();
      worker = null;
    },
  };
}
