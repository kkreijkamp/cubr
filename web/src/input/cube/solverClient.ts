// Asks the solver worker for a scramble that gives a cube state, or the turns from one state to
// another. One worker, started on first use; answers come back by request id.
import type { SolverRequest } from './solver.worker';

type Pending = (moves: string | null) => void;
type Ask = { kind: 'scramble'; facelet: string } | { kind: 'between'; from: string; to: string; corners: boolean };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; moves: string | null }>) => {
    pending.get(e.data.id)?.(e.data.moves);
    pending.delete(e.data.id);
  };
  worker.onerror = () => {
    for (const p of pending.values()) p(null);
    pending.clear();
  };
  return worker;
}

function ask(a: Ask): Promise<string | null> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    getWorker().postMessage({ id, ...a } as SolverRequest);
  });
}

/** build the tables in the background now so the first real answer is quick */
export const warmSolver = () => void getWorker();

/** a scramble that takes a solved cube to these facelets */
export const scrambleFor = (facelet: string) => ask({ kind: 'scramble', facelet });

/** the turns from one cube state to another (facelets; only the corners for a 2x2) */
export const movesBetween = (from: string, to: string, corners = false) => ask({ kind: 'between', from, to, corners });
