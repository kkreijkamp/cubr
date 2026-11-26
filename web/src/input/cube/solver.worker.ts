// The two-phase solver off the main thread: its tables take a moment to build.
import { cornersBetween, initSolver, movesBetween, scrambleForFacelet } from './solver';
import { CubieCube } from './cubie';

export type SolverRequest = { id: number; kind: 'scramble'; facelet: string } | { id: number; kind: 'between'; from: string; to: string; corners: boolean };

initSolver();

self.onmessage = (e: MessageEvent<SolverRequest>) => {
  const r = e.data;
  let moves: string | null;
  if (r.kind === 'scramble') moves = scrambleForFacelet(r.facelet);
  else {
    const from = new CubieCube().fromFacelet(r.from);
    const to = new CubieCube().fromFacelet(r.to);
    moves = from && to ? (r.corners ? cornersBetween(from, to) : movesBetween(from, to)) : null;
  }
  self.postMessage({ id: r.id, moves });
};
