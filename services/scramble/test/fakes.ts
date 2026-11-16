// A stand-in for the cubing.js backend (the pattern of generator.test.ts): searches take a set
// time on setTimeout, so fake timers control them, and each event can be made slow, stuck or
// failing. Scrambles come out as "<event> scramble <n>", unique per backend.
import type { ScrambleBackend } from '../src/backends.js';
import { GenerationTimeoutError } from '../src/errors.js';
import { withTimeout } from '../src/util.js';

/** How a search behaves: takes this many ms, never finishes ('hang'), or fails with the Error. */
export type Behaviour = number | 'hang' | Error;

export interface FakeBackend extends ScrambleBackend {
  calls: { slot: number; event: string }[];
  behave: (event: string) => Behaviour;
}

export function fakeBackend(size = 1, ms = 0): FakeBackend {
  let n = 0;
  const backend: FakeBackend = {
    kind: size > 1 ? 'worker-pool' : 'in-process',
    size,
    calls: [],
    behave: () => ms,
    run(slot, event, timeoutMs) {
      backend.calls.push({ slot, event });
      const id = ++n;
      const how = backend.behave(event);
      if (how instanceof Error) return Promise.reject(how);
      const search = new Promise<string>((resolve) => {
        if (how !== 'hang') setTimeout(() => resolve(`${event} scramble ${id}`), how);
      });
      return withTimeout(search, timeoutMs, () => new GenerationTimeoutError());
    },
    close: async () => {},
  };
  return backend;
}
