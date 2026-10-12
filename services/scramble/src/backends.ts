import { GenerationTimeoutError } from './errors.js';
import { withTimeout } from './util.js';

/**
 * Something that can run scramble searches. `size` = how many can run in parallel; the
 * generator queue (generator.ts) hands each search to a free `slot` (0 … size-1).
 */
export interface ScrambleBackend {
  readonly kind: string;
  readonly size: number;
  run(slot: number, event: string, timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

// Prefetching would make cubing.js search for the *next* scramble in advance (doubling CPU
// for us); logPerf prints timing noise to stdout.
const SEARCH_DEBUG = { logPerf: false, scramblePrefetchLevel: 'none' } as const;

/**
 * cubing.js in the main thread. cubing.js itself runs every search on ONE internal worker
 * thread, so the HTTP event loop stays responsive while the CPU work happens off-thread — but
 * searches are effectively sequential (size = 1).
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
