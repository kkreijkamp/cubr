// Practice scrambles the way csTimer makes them (src/js/scramble/scramble_333_edit.js and
// 2x2x2.js, GPL-3.0 like cubr, by Chen Shuang): a random state in which some pieces are pinned
// (for PLL: everything solved but the top layer's permutation), solved by cubing.js and given
// backwards, so the scramble lands on that kind of state. Pure: the solving happens in the
// scramble backend (backends.ts), which gets the state as a job string.

export type SolvePuzzle = '3x3x3' | '2x2x2';

export interface OrbitState {
  /** pieces[slot] = the piece in that slot (cubing.js slots) */
  pieces: number[];
  orientation: number[];
}

/** What the backend solves: `pre`, then the pinned-piece state, then `post` (moves from solved). */
export interface SolveState {
  pre?: string;
  post?: string;
  EDGES?: OrbitState;
  CORNERS: OrbitState;
}

export interface PracticeJob {
  puzzle: SolvePuzzle;
  state: SolveState;
  /** appended to the scramble (a whole-cube turn that hands the solver the right angle) */
  suffix?: string;
}

type Rng = () => number;
const rn = (n: number, rng: Rng) => Math.floor(rng() * n) % n;
const pick = <T>(xs: readonly T[], rng: Rng): T => xs[rn(xs.length, rng)];

// csTimer counts positions in min2phase's order; cubing.js in its own. Edges UR UF UL UB DR DF DL DB
// FR FL BL BR and corners URF UFL ULB UBR DFR DLF DBL DRB, as cubing.js slots (UF UR UB UL DF DR DB DL
// FR FL BR BL; UFR UBR UBL UFL DFR DFL DBL DBR).
const E_SLOT = [1, 0, 3, 2, 5, 4, 7, 6, 8, 9, 11, 10];
const C_SLOT = [0, 3, 2, 1, 4, 5, 6, 7];

/** a csTimer mask: hex digit i (counted from the right) is position i's value, f = free (-1) */
export function hexMask(hex: string, n: number): number[] {
  const digits = hex.replace(/^0x/, '').padStart(n, '0');
  return Array.from({ length: n }, (_, i) => {
    const d = digits[digits.length - 1 - i];
    return d === 'f' ? -1 : parseInt(d, 16);
  });
}

/** a csTimer-ordered mask in cubing.js slots (`piece`: the values are pieces, so they're mapped too) */
function toSlots(mask: number[], map: number[], piece: boolean): number[] {
  const out = new Array<number>(mask.length).fill(-1);
  mask.forEach((v, i) => {
    out[map[i]] = v < 0 ? -1 : piece ? map[v] : v;
  });
  return out;
}

function shuffle<T>(xs: T[], rng: Rng): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = rn(i + 1, rng);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/** pinned slots keep their piece; the other pieces are shuffled into the free slots */
function fillPermutation(mask: number[], rng: Rng): number[] {
  const used = new Set(mask.filter((v) => v >= 0));
  const free = shuffle(
    mask.map((_, p) => p).filter((p) => !used.has(p)),
    rng,
  );
  let k = 0;
  return mask.map((v) => (v >= 0 ? v : free[k++]));
}

export function parity(p: number[]): number {
  const seen = new Array<boolean>(p.length).fill(false);
  let par = 0;
  for (let i = 0; i < p.length; i++) {
    if (seen[i]) continue;
    let len = 0;
    for (let j = i; !seen[j]; j = p[j]) {
      seen[j] = true;
      len++;
    }
    par ^= (len - 1) & 1;
  }
  return par;
}

/** swaps the pieces in the first two free slots (flips the permutation's parity); false if < 2 free */
function swapFree(p: number[], mask: number[]): boolean {
  const free = mask.flatMap((v, i) => (v < 0 ? [i] : []));
  if (free.length < 2) return false;
  [p[free[0]], p[free[1]]] = [p[free[1]], p[free[0]]];
  return true;
}

/** random orientations for the free slots, the last free one making the twist add up to 0 */
function fillOrientation(mask: number[], mod: number, rng: Rng): number[] | null {
  const o = mask.map((v) => (v >= 0 ? v : rn(mod, rng)));
  const sum = o.reduce((a, b) => a + b, 0) % mod;
  if (sum === 0) return o;
  const free = mask.flatMap((v, i) => (v < 0 ? [i] : []));
  if (free.length === 0) return null;
  const last = free[free.length - 1];
  o[last] = (((o[last] - sum) % mod) + mod) % mod;
  return o;
}

export interface Masks {
  /** per cubing.js slot: the piece pinned there, or -1 */
  ep?: number[];
  eo?: number[];
  cp: number[];
  co: number[];
}

/** A random legal state for the masks (3x3: edge and corner parity match; 2x2: corners only). */
export function randomState(m: Masks, rng: Rng = Math.random): { EDGES?: OrbitState; CORNERS: OrbitState } {
  for (;;) {
    const c = fillPermutation(m.cp, rng);
    const co = fillOrientation(m.co, 3, rng);
    if (!co) throw new Error('corner twists can never add up');
    if (!m.ep || !m.eo) return { CORNERS: { pieces: c, orientation: co } };
    const e = fillPermutation(m.ep, rng);
    const eo = fillOrientation(m.eo, 2, rng);
    if (!eo) throw new Error('edge flips can never add up');
    if (parity(e) !== parity(c) && !swapFree(e, m.ep) && !swapFree(c, m.cp)) throw new Error('parity can never match');
    const solved = e.every((p, i) => p === i) && eo.every((x) => x === 0) && c.every((p, i) => p === i) && co.every((x) => x === 0);
    if (!solved) return { EDGES: { pieces: e, orientation: eo }, CORNERS: { pieces: c, orientation: co } };
  }
}

/** csTimer masks (ep, eo, cp, co as in scramble_333_edit.js) in cubing.js slots */
const cs = (ep: string, eo: string, cp: string, co: string): Masks => ({
  ep: toSlots(hexMask(ep, 12), E_SLOT, true),
  eo: toSlots(hexMask(eo, 12), E_SLOT, false),
  cp: toSlots(hexMask(cp, 8), C_SLOT, true),
  co: toSlots(hexMask(co, 8), C_SLOT, false),
});

const AUF = ['', 'U', 'U2', "U'"];
const DAUF = ['', 'D', 'D2', "D'"];
/** Roux: R and L turned against each other, then a whole-cube x hands the blocks back (csTimer's rlpresuff) */
const RL = ['', "R L'", 'R2 L2', "R' L"];
const RL_TURN = ['', "x'", 'x2', 'x'];
const D_TURN = ['', 'y', 'y2', "y'"];

interface Recipe333 {
  masks: (rng: Rng) => Masks;
  pre?: 'auf' | 'rl' | 'aufrl' | 'dauf';
  post?: 'auf';
}

const fixed = (m: Masks) => () => m;
const LL = cs('0xba987654ffff', '0x00000000ffff', '0x7654ffff', '0x0000ffff');
const ZB = cs('0xba987654ffff', '0x000000000000', '0x7654ffff', '0x0000ffff');
const LSLL = cs('0xba9f7654ffff', '0x000f0000ffff', '0x765fffff', '0x000fffff');
const EDGES_ONLY = cs('0xffffffffffff', '0xffffffffffff', '0x76543210', '0x00000000');
const CORNERS_ONLY = cs('0xba9876543210', '0x000000000000', '0xffffffff', '0xffffffff');
/** Mehta's EOLE: the belt solved but one of its four edges (at random) */
const eole = (rng: Rng): Masks => {
  const skip = rn(4, rng);
  const ep = hexMask('0xba98765fffff', 12);
  const eo = hexMask('0x0000000fffff', 12);
  ep[8 + skip] = -1;
  eo[8 + skip] = -1;
  return {
    ep: toSlots(ep, E_SLOT, true),
    eo: toSlots(eo, E_SLOT, false),
    cp: toSlots(hexMask('0xf65fffff', 8), C_SLOT, true),
    co: toSlots(hexMask('0xf00fffff', 8), C_SLOT, false),
  };
};

const RECIPES_333: Record<string, Recipe333> = {
  edges: { masks: fixed(EDGES_ONLY) },
  corners: { masks: fixed(CORNERS_ONLY) },
  ll: { masks: fixed(LL) },
  oll: { masks: fixed(LL), pre: 'auf', post: 'auf' },
  cll: { masks: fixed(LL), pre: 'auf', post: 'auf' },
  pll: { masks: fixed(cs('0xba987654ffff', '0x000000000000', '0x7654ffff', '0x00000000')), pre: 'auf', post: 'auf' },
  zbll: { masks: fixed(ZB), pre: 'auf', post: 'auf' },
  coll: { masks: fixed(ZB), pre: 'auf', post: 'auf' },
  ell: { masks: fixed(cs('0xba987654ffff', '0x00000000ffff', '0x76543210', '0x00000000')) },
  '2gll': { masks: fixed(cs('0xba987654ffff', '0x000000000000', '0x76543210', '0x0000ffff')), post: 'auf' },
  zzll: { masks: fixed(cs('0xba9876543f1f', '0x000000000000', '0x7654ffff', '0x0000ffff')), post: 'auf' },
  lsll2: { masks: fixed(LSLL), post: 'auf' },
  zbls: { masks: fixed(LSLL), post: 'auf' },
  eols: { masks: fixed(cs('0xba9f7654ffff', '0x000000000000', '0x765fffff', '0x000fffff')), post: 'auf' },
  f2l: { masks: fixed(cs('0xffff7654ffff', '0xffff0000ffff', '0xffffffff', '0xffffffff')) },
  eoline: { masks: fixed(cs('0xffff7f5fffff', '0x000000000000', '0xffffffff', '0xffffffff')) },
  eocross: { masks: fixed(cs('0xffff7654ffff', '0x000000000000', '0xffffffff', '0xffffffff')) },
  sbrx: { masks: fixed(cs('0xfa9ff6ffffff', '0xf00ff0ffffff', '0xf65fffff', '0xf00fffff')), pre: 'rl' },
  cmll: { masks: fixed(cs('0xba98f6f4ffff', '0x0000f0f0ffff', '0x7654ffff', '0x0000ffff')), pre: 'aufrl', post: 'auf' },
  lse: { masks: fixed(cs('0xba98f6f4ffff', '0x0000f0f0ffff', '0x76543210', '0x00000000')), pre: 'rl', post: 'auf' },
  mt3qb: { masks: fixed(cs('0xffff765fffff', '0xffff000fffff', '0xf65fffff', '0xf00fffff')), pre: 'dauf' },
  mteole: { masks: eole, pre: 'dauf' },
  mttdr: { masks: fixed(cs('0xba98765fffff', '0x000000000000', '0xf65fffff', '0xf00fffff')) },
  mt6cp: { masks: fixed(cs('0xba98765fffff', '0x000000000000', '0xf65fffff', '0x00000000')) },
  mtl5ep: { masks: fixed(cs('0xba98765fffff', '0x000000000000', '0x76543210', '0x00000000')) },
  mtcdrll: { masks: fixed(cs('0xba98765fffff', '0x000000000000', '0x7654ffff', '0x0000ffff')) },
};

// ---- 2x2: corners only, in cubing.js slots (UFR UBR UBL UFL DFR DFL DBL DBR). DBL stays put, as in
// csTimer, so every other arrangement and twist is reachable.
const FREE = -1;
const D_LAYER = (perm: number[], twist: number[] = [0, 0, 0, 0]): Masks => ({
  cp: [FREE, FREE, FREE, FREE, ...perm],
  co: [FREE, FREE, FREE, FREE, ...twist],
});
const RECIPES_222: Record<string, (rng: Rng) => Masks> = {
  '222o': () => ({ cp: [FREE, FREE, FREE, FREE, FREE, FREE, 6, FREE], co: [FREE, FREE, FREE, FREE, FREE, FREE, 0, FREE] }),
  // CLL: the bottom layer solved; EG-1: two adjacent bottom corners swapped; EG-2: two diagonal ones
  '222eg0': () => D_LAYER([4, 5, 6, 7]),
  '222eg1': (rng) =>
    D_LAYER(
      pick(
        [
          [5, 4, 6, 7],
          [7, 5, 6, 4],
        ],
        rng,
      ),
    ),
  '222eg2': () => D_LAYER([4, 7, 6, 5]),
  // EG: CLL, EG-1 and EG-2 as often as the bottom layer gives them (1 : 4 : 1)
  '222eg': (rng) => {
    const r = rn(6, rng);
    return r === 0
      ? D_LAYER([4, 5, 6, 7])
      : r === 5
        ? D_LAYER([4, 7, 6, 5])
        : D_LAYER(
            pick(
              [
                [5, 4, 6, 7],
                [7, 5, 6, 4],
              ],
              rng,
            ),
          );
  },
  // TCLL: the bottom layer solved but one corner twisted (either way)
  '222tc': (rng) => D_LAYER([4, 5, 6, 7], [1 + rn(2, rng), 0, 0, 0]),
  // last slot: one bottom corner anywhere in the top layer or its slot
  '222lsall': () => ({ cp: [FREE, FREE, FREE, FREE, FREE, 5, 6, 7], co: [FREE, FREE, FREE, FREE, FREE, 0, 0, 0] }),
};

// ---- easy cross: every state of the four cross edges with its fewest moves (csTimer's tools/cross.js)
/** cubing.js's edge permutation and flips for U D R L F B (piece in slot i comes from slot perm[i]) */
// prettier-ignore
const EDGE_MOVES: Record<string, [number[], number[]]> = {
  U: [[1, 2, 3, 0, 4, 5, 6, 7, 8, 9, 10, 11], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  D: [[0, 1, 2, 3, 7, 4, 5, 6, 8, 9, 10, 11], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  R: [[0, 8, 2, 3, 4, 10, 6, 7, 5, 9, 1, 11], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  L: [[0, 1, 2, 11, 4, 5, 6, 9, 8, 3, 10, 7], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  F: [[9, 1, 2, 3, 8, 5, 6, 7, 0, 4, 10, 11], [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]],
  B: [[0, 1, 10, 3, 4, 5, 11, 7, 8, 9, 6, 2], [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1]],
};
const CROSS = [4, 5, 6, 7]; // DF DR DB DL
let crossDistance: Uint8Array | null = null;

/** where one edge (slot*2 + flip) goes for each of the 18 face turns */
function edgeTurnTable(): number[][] {
  const table: number[][] = [];
  for (const [perm, flip] of Object.values(EDGE_MOVES)) {
    // a quarter turn: the piece in slot s ends in the slot that takes from s
    const quarter = Array.from({ length: 24 }, (_, code) => {
      const s = code >> 1;
      const to = perm.indexOf(s);
      return (to << 1) | ((code & 1) ^ flip[to]);
    });
    let t = quarter;
    for (let k = 0; k < 3; k++) {
      table.push(t);
      const prev = t;
      t = prev.map((c) => quarter[c]);
    }
  }
  return table;
}

const crossIndex = (codes: number[]) => ((codes[0] * 24 + codes[1]) * 24 + codes[2]) * 24 + codes[3];

function crossTable(): Uint8Array {
  if (crossDistance) return crossDistance;
  const turns = edgeTurnTable();
  const dist = new Uint8Array(24 ** 4).fill(255);
  let frontier = [CROSS.map((s) => s << 1)];
  dist[crossIndex(frontier[0])] = 0;
  for (let d = 0; frontier.length; d++) {
    const next: number[][] = [];
    for (const codes of frontier) {
      for (const t of turns) {
        const moved = codes.map((c) => t[c]);
        const i = crossIndex(moved);
        if (dist[i] === 255) {
          dist[i] = d + 1;
          next.push(moved);
        }
      }
    }
    frontier = next;
  }
  crossDistance = dist;
  return dist;
}

/** A random cross state solvable in `min`-`max` moves, as edge masks (the rest of the cube free). */
export function easyCrossMasks(min: number, max: number, rng: Rng = Math.random): Masks {
  const dist = crossTable();
  let count = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i] >= min && dist[i] <= max) count++;
  let target = rn(count, rng);
  let found = -1;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] >= min && dist[i] <= max && target-- === 0) {
      found = i;
      break;
    }
  }
  const codes = [Math.floor(found / 24 ** 3) % 24, Math.floor(found / 24 ** 2) % 24, Math.floor(found / 24) % 24, found % 24];
  const ep = new Array<number>(12).fill(FREE);
  const eo = new Array<number>(12).fill(FREE);
  codes.forEach((code, k) => {
    ep[code >> 1] = CROSS[k];
    eo[code >> 1] = code & 1;
  });
  return { ep, eo, cp: new Array<number>(8).fill(FREE), co: new Array<number>(8).fill(FREE) };
}

/** Fewest moves for the cross in a state (for tests). */
export function crossMoves(edges: OrbitState): number {
  const codes = CROSS.map((piece) => {
    const slot = edges.pieces.indexOf(piece);
    return (slot << 1) | edges.orientation[slot];
  });
  return crossTable()[crossIndex(codes)];
}

/** Practice types made from a random pinned state (3x3 and 2x2), and how. */
export const PRACTICE_STATE_TYPES: ReadonlySet<string> = new Set([...Object.keys(RECIPES_333), 'easyc', ...Object.keys(RECIPES_222)]);

/** The job for a practice scramble of type `id`, or null if it isn't one of these. */
export function practiceJob(id: string, rng: Rng = Math.random): PracticeJob | null {
  if (id === 'easyc') return { puzzle: '3x3x3', state: randomState(easyCrossMasks(1, 3, rng), rng) as SolveState };
  const r2 = RECIPES_222[id];
  if (r2) return { puzzle: '2x2x2', state: randomState(r2(rng), rng) as SolveState };
  const r = RECIPES_333[id];
  if (!r) return null;
  const state: SolveState = randomState(r.masks(rng), rng) as SolveState;
  let suffix: string | undefined;
  const k = rn(4, rng);
  if (r.pre === 'auf') state.pre = pick(AUF, rng);
  else if (r.pre === 'dauf') {
    state.pre = DAUF[k];
    suffix = D_TURN[k];
  } else if (r.pre === 'rl' || r.pre === 'aufrl') {
    state.pre = `${r.pre === 'aufrl' ? pick(AUF, rng) : ''} ${RL[k]}`.trim();
    suffix = RL_TURN[k];
  }
  if (r.post === 'auf') state.post = pick(AUF, rng);
  if (!state.pre) delete state.pre;
  if (!state.post) delete state.post;
  return suffix ? { puzzle: '3x3x3', state, suffix } : { puzzle: '3x3x3', state };
}

const SOLVE_PREFIX = 'solve:';

/** The backend job string for a practice state ("solve:3x3x3:{...}"). */
export function encodeSolveJob(puzzle: SolvePuzzle, state: SolveState): string {
  return `${SOLVE_PREFIX}${puzzle}:${JSON.stringify(state)}`;
}

/** Undoes encodeSolveJob; null for a plain cubing.js event id. */
export function decodeSolveJob(job: string): { puzzle: SolvePuzzle; state: SolveState } | null {
  if (!job.startsWith(SOLVE_PREFIX)) return null;
  const at = job.indexOf(':', SOLVE_PREFIX.length);
  return { puzzle: job.slice(SOLVE_PREFIX.length, at) as SolvePuzzle, state: JSON.parse(job.slice(at + 1)) as SolveState };
}

/** What a job is called in the generator's timings ("333", "solve:3x3x3"). */
export const jobLabel = (job: string) => (job.startsWith(SOLVE_PREFIX) ? job.slice(0, job.indexOf(':', SOLVE_PREFIX.length)) : job);
