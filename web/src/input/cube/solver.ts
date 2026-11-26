// Kociemba's two-phase 3x3 solver, the job csTimer's min2phase does for its smart cube tools: a
// scramble that gives the state the cube is in (when it was scrambled by hand), and the shortest
// way back onto the scramble after a wrong turn. Phase 1 brings the cube into <U, D, R2, L2, F2, B2>
// (corners twisted and edges flipped right, the four middle-layer edges in the middle layer), phase 2
// solves it with those moves. Pruning tables are built on first use (about half a second), so the
// browser runs this in a worker.
import { CubieCube, MOVE_CUBE, moveName } from './cubie';

const N_TWIST = 2187;
const N_FLIP = 2048;
const N_SLICE = 495;
const N_PERM = 40320;
const N_SPERM = 24;
/** phase 2 moves: U U2 U' D D2 D' R2 L2 F2 B2, as indexes into the 18 face turns */
const P2_MOVES = [0, 1, 2, 9, 10, 11, 4, 13, 7, 16];

const Cnk: number[][] = Array.from({ length: 13 }, (_, n) => {
  const row = [1];
  for (let k = 1; k <= n; k++) row[k] = (row[k - 1] * (n - k + 1)) / k;
  return row;
});
const choose = (n: number, k: number) => (k > n ? 0 : Cnk[n][k]);

function getTwist(c: CubieCube): number {
  let t = 0;
  for (let i = 0; i < 7; i++) t = t * 3 + (c.ca[i] >> 3);
  return t;
}
function setTwist(c: CubieCube, t: number) {
  let sum = 0;
  for (let i = 6; i >= 0; i--) {
    const o = t % 3;
    sum += o;
    c.ca[i] = (c.ca[i] & 7) | (o << 3);
    t = Math.floor(t / 3);
  }
  c.ca[7] = (c.ca[7] & 7) | (((3 - (sum % 3)) % 3) << 3);
}

function getFlip(c: CubieCube): number {
  let f = 0;
  for (let i = 0; i < 11; i++) f = (f << 1) | (c.ea[i] & 1);
  return f;
}
function setFlip(c: CubieCube, f: number) {
  let sum = 0;
  for (let i = 10; i >= 0; i--) {
    const o = f & 1;
    sum ^= o;
    c.ea[i] = (c.ea[i] & ~1) | o;
    f >>= 1;
  }
  c.ea[11] = (c.ea[11] & ~1) | sum;
}

/** where the four middle-layer edges (FR FL BL BR) are, as a combination of 4 of the 12 places */
function getSlice(c: CubieCube): number {
  let idx = 0;
  let r = 4;
  for (let i = 11; i >= 0 && r > 0; i--) {
    if (c.ea[i] >> 1 >= 8) {
      idx += choose(i, r);
      r--;
    }
  }
  return idx;
}
function setSlice(c: CubieCube, idx: number) {
  let r = 4;
  let slice = 8;
  let other = 0;
  for (let i = 11; i >= 0; i--) {
    if (r > 0 && idx >= choose(i, r)) {
      idx -= choose(i, r);
      r--;
      c.ea[i] = slice++ << 1;
    } else c.ea[i] = other++ << 1;
  }
}

function permIndex(p: ArrayLike<number>, n: number): number {
  let idx = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i + 1; j < n; j++) if (p[j] < p[i]) s++;
    idx = idx * (n - i) + s;
  }
  return idx;
}
function permFrom(idx: number, n: number): number[] {
  const digits: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    digits[i] = idx % (n - i);
    idx = Math.floor(idx / (n - i));
  }
  const left = Array.from({ length: n }, (_, i) => i);
  return digits.map((d) => left.splice(d, 1)[0]);
}

const getCPerm = (c: CubieCube) =>
  permIndex(
    c.ca.map((x) => x & 7),
    8,
  );
const getEPerm = (c: CubieCube) =>
  permIndex(
    c.ea.slice(0, 8).map((x) => x >> 1),
    8,
  );
const getSPerm = (c: CubieCube) =>
  permIndex(
    c.ea.slice(8).map((x) => (x >> 1) - 8),
    4,
  );

interface Tables {
  twistMove: Uint16Array;
  flipMove: Uint16Array;
  sliceMove: Uint16Array;
  cpermMove: Uint16Array;
  epermMove: Uint16Array;
  spermMove: Uint8Array;
  prunTwist: Int8Array;
  prunFlip: Int8Array;
  prunCPerm: Int8Array;
  prunEPerm: Int8Array;
}

/** a coordinate's move table: value * moves + move -> value */
function moveTable<T extends Uint16Array | Uint8Array>(
  out: T,
  n: number,
  moves: number[],
  set: (c: CubieCube, v: number) => void,
  get: (c: CubieCube) => number,
): T {
  const c = new CubieCube();
  const d = new CubieCube();
  for (let v = 0; v < n; v++) {
    set(c, v);
    for (let m = 0; m < moves.length; m++) out[v * moves.length + m] = get(CubieCube.mult(c, MOVE_CUBE[moves[m]], d));
  }
  return out;
}

/** distance to solved over a pair of coordinates (a * nb + b), breadth first */
function pruneTable(na: number, nb: number, nMoves: number, aMove: ArrayLike<number>, bMove: ArrayLike<number>, solved: number): Int8Array {
  const t = new Int8Array(na * nb).fill(-1);
  t[solved] = 0;
  let filled = 1;
  for (let depth = 0; filled < na * nb; depth++) {
    for (let i = 0; i < na * nb; i++) {
      if (t[i] !== depth) continue;
      const a = Math.floor(i / nb);
      const b = i % nb;
      for (let m = 0; m < nMoves; m++) {
        const j = aMove[a * nMoves + m] * nb + bMove[b * nMoves + m];
        if (t[j] === -1) {
          t[j] = depth + 1;
          filled++;
        }
      }
    }
  }
  return t;
}

const ALL = Array.from({ length: 18 }, (_, i) => i);
const SOLVED_SLICE = getSlice(new CubieCube());
let tables: Tables | null = null;

function init(): Tables {
  if (tables) return tables;
  const twistMove = moveTable(new Uint16Array(N_TWIST * 18), N_TWIST, ALL, setTwist, getTwist);
  const flipMove = moveTable(new Uint16Array(N_FLIP * 18), N_FLIP, ALL, setFlip, getFlip);
  const sliceMove = moveTable(new Uint16Array(N_SLICE * 18), N_SLICE, ALL, setSlice, getSlice);
  const cpermMove = moveTable(
    new Uint16Array(N_PERM * 10),
    N_PERM,
    P2_MOVES,
    (c, v) => {
      const p = permFrom(v, 8);
      for (let i = 0; i < 8; i++) c.ca[i] = p[i];
    },
    getCPerm,
  );
  const epermMove = moveTable(
    new Uint16Array(N_PERM * 10),
    N_PERM,
    P2_MOVES,
    (c, v) => {
      const p = permFrom(v, 8);
      for (let i = 0; i < 8; i++) c.ea[i] = p[i] << 1;
      for (let i = 8; i < 12; i++) c.ea[i] = i << 1;
    },
    getEPerm,
  );
  const spermMove = moveTable(
    new Uint8Array(N_SPERM * 10),
    N_SPERM,
    P2_MOVES,
    (c, v) => {
      const p = permFrom(v, 4);
      for (let i = 0; i < 8; i++) c.ea[i] = i << 1;
      for (let i = 0; i < 4; i++) c.ea[8 + i] = (p[i] + 8) << 1;
    },
    getSPerm,
  );
  tables = {
    twistMove,
    flipMove,
    sliceMove,
    cpermMove,
    epermMove,
    spermMove,
    prunTwist: pruneTable(N_TWIST, N_SLICE, 18, twistMove, sliceMove, SOLVED_SLICE),
    prunFlip: pruneTable(N_FLIP, N_SLICE, 18, flipMove, sliceMove, SOLVED_SLICE),
    prunCPerm: pruneTable(N_PERM, N_SPERM, 10, cpermMove, spermMove, 0),
    prunEPerm: pruneTable(N_PERM, N_SPERM, 10, epermMove, spermMove, 0),
  };
  return tables;
}

/** build the tables now (the worker does this as soon as it starts) */
export const initSolver = () => void init();

/** after a turn of `last`, a turn of face `face` is worth trying: never the same face twice, and of two opposite faces only U before D (R before L, F before B) */
const allowed = (last: number, face: number) => face !== last && face !== last - 3;

class Search {
  private t = init();
  private sol: number[] = [];
  private nodes = 0;
  private cube = new CubieCube();
  constructor(
    private maxLen: number,
    private budget: number,
  ) {}

  run(c: CubieCube): number[] | null {
    this.cube = c;
    const tw = getTwist(c);
    const fl = getFlip(c);
    const sl = getSlice(c);
    for (let d1 = 0; d1 <= Math.min(12, this.maxLen); d1++) {
      if (this.phase1(tw, fl, sl, d1, -1)) return this.sol;
      if (this.nodes > this.budget) return null;
    }
    return null;
  }

  private phase1(tw: number, fl: number, sl: number, depth: number, last: number): boolean {
    if (depth === 0) {
      if (tw !== 0 || fl !== 0 || sl !== SOLVED_SLICE) return false;
      // a phase 1 that ends in a phase 2 move was already tried shorter
      const lm = this.sol[this.sol.length - 1];
      if (lm !== undefined && P2_MOVES.includes(lm)) return false;
      return this.startPhase2();
    }
    const { twistMove, flipMove, sliceMove, prunTwist, prunFlip } = this.t;
    if (Math.max(prunTwist[tw * N_SLICE + sl], prunFlip[fl * N_SLICE + sl]) > depth) return false;
    for (let m = 0; m < 18; m++) {
      const face = Math.floor(m / 3);
      if (last >= 0 && !allowed(last, face)) continue;
      if (++this.nodes > this.budget) return false;
      this.sol.push(m);
      if (this.phase1(twistMove[tw * 18 + m], flipMove[fl * 18 + m], sliceMove[sl * 18 + m], depth - 1, face)) return true;
      this.sol.pop();
    }
    return false;
  }

  private startPhase2(): boolean {
    const c = this.cube.clone();
    const d = new CubieCube();
    for (const m of this.sol) {
      CubieCube.mult(c, MOVE_CUBE[m], d);
      c.init(d.ca, d.ea);
    }
    const cp = getCPerm(c);
    const ep = getEPerm(c);
    const sp = getSPerm(c);
    const { prunCPerm, prunEPerm } = this.t;
    const limit = Math.min(18, this.maxLen - this.sol.length);
    const last = this.sol.length ? Math.floor(this.sol[this.sol.length - 1] / 3) : -1;
    for (let d2 = Math.max(prunCPerm[cp * N_SPERM + sp], prunEPerm[ep * N_SPERM + sp]); d2 <= limit; d2++) {
      if (this.phase2(cp, ep, sp, d2, last)) return true;
      if (this.nodes > this.budget) return false;
    }
    return false;
  }

  private phase2(cp: number, ep: number, sp: number, depth: number, last: number): boolean {
    if (depth === 0) return cp === 0 && ep === 0 && sp === 0;
    const { cpermMove, epermMove, spermMove, prunCPerm, prunEPerm } = this.t;
    if (Math.max(prunCPerm[cp * N_SPERM + sp], prunEPerm[ep * N_SPERM + sp]) > depth) return false;
    for (let i = 0; i < 10; i++) {
      const m = P2_MOVES[i];
      const face = Math.floor(m / 3);
      if (last >= 0 && !allowed(last, face)) continue;
      if (++this.nodes > this.budget) return false;
      this.sol.push(m);
      if (this.phase2(cpermMove[cp * 10 + i], epermMove[ep * 10 + i], spermMove[sp * 10 + i], depth - 1, face)) return true;
      this.sol.pop();
    }
    return false;
  }
}

/** face turns (0..17) that solve the cube, at most 21 when one turns up quickly; null for a cube that can't be solved */
export function solveCubie(c: CubieCube): number[] | null {
  if (!c.verify()) return null;
  for (const [maxLen, budget] of [
    [21, 3e7],
    [23, 3e6],
    [30, Infinity],
  ]) {
    const sol = new Search(maxLen, budget).run(c);
    if (sol) return sol;
  }
  return null;
}

const invert = (m: number) => m - (m % 3) + (2 - (m % 3));
const toText = (moves: number[]) => moves.map((m) => moveName(m).trim()).join(' ');

/** a scramble that takes a solved cube to these facelets (csTimer's genFacelet); null if they aren't a cube */
export function scrambleForFacelet(facelet: string): string | null {
  const c = new CubieCube().fromFacelet(facelet);
  const sol = c && solveCubie(c);
  return sol ? toText(sol.reverse().map(invert)) : null;
}

/** the turns that take cube `from` to cube `to` */
export function movesBetween(from: CubieCube, to: CubieCube): string | null {
  // from * x = to, so x = from^-1 * to: a scramble for that state
  const x = CubieCube.mult(new CubieCube().invFrom(from), to, new CubieCube());
  const sol = solveCubie(x);
  return sol ? toText(sol.reverse().map(invert)) : null;
}

let corners: { cperm: Uint16Array; prunCPerm: Int8Array; prunTwist: Int8Array } | null = null;

/** the turns that take the corners of `from` to those of `to` (a 2x2), fewest first */
export function cornersBetween(from: CubieCube, to: CubieCube): string | null {
  const { twistMove } = init();
  if (!corners) {
    const cperm = moveTable(
      new Uint16Array(N_PERM * 18),
      N_PERM,
      ALL,
      (c, v) => {
        const p = permFrom(v, 8);
        for (let i = 0; i < 8; i++) c.ca[i] = p[i];
      },
      getCPerm,
    );
    const one = new Uint16Array(18);
    corners = { cperm, prunCPerm: pruneTable(N_PERM, 1, 18, cperm, one, 0), prunTwist: pruneTable(N_TWIST, 1, 18, twistMove, one, 0) };
  }
  const { cperm, prunCPerm, prunTwist } = corners;
  const x = CubieCube.mult(new CubieCube().invFrom(from), to, new CubieCube());
  const sol: number[] = [];
  const dfs = (cp: number, tw: number, depth: number, last: number): boolean => {
    if (depth === 0) return cp === 0 && tw === 0;
    if (Math.max(prunCPerm[cp], prunTwist[tw]) > depth) return false;
    for (let m = 0; m < 18; m++) {
      const face = Math.floor(m / 3);
      if (last >= 0 && !allowed(last, face)) continue;
      sol.push(m);
      if (dfs(cperm[cp * 18 + m], twistMove[tw * 18 + m], depth - 1, face)) return true;
      sol.pop();
    }
    return false;
  };
  const cp = getCPerm(x);
  const tw = getTwist(x);
  for (let d = 0; d <= 20; d++) if (dfs(cp, tw, d, -1)) return toText(sol.reverse().map(invert));
  return null;
}
