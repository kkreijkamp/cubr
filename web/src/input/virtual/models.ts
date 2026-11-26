// One interface over every virtual puzzle (polyhedral, square-1, clock), picked by event.
import { applyClock, clockIsRotation, clockIsSolved, clockKey, clockMoveName, clockSolved, parseClock, type ClockMove, type ClockState } from './clock';
import { cubeTwisty, megaminxTwisty, pyraminxTwisty, skewbTwisty, type PolyTwisty } from './polyTwisty';
import type { Move } from './polyPuzzle';
import { applySq1, canSlash, parseSq1, sq1IsRotation, sq1IsSolved, sq1Key, sq1MoveName, sq1Solved, type Sq1Move, type Sq1State } from './square1';

interface Base<S, M> {
  id: string;
  solved(): S;
  apply(s: S, m: M): S;
  /** a move the puzzle can't do in this state (a square-1 slash with a corner across the cut) */
  allowed(s: S, m: M): boolean;
  isSolved(s: S): boolean;
  isRotation(m: M): boolean;
  parse(alg: string): M[] | null;
  key(code: string): { move: M } | { depth: true } | null;
  name(m: M): string;
  /** moves that may be animated at the same time */
  parallel(a: M, b: M): boolean;
  /** turns counted for the move count (consecutive turns of one layer count once, rotations not at all) */
  countKey(m: M): string | null;
}

export type PolyModel = Base<Int16Array, Move> & { kind: 'poly'; twisty: PolyTwisty; canonical(m: Move): Move };
export type Sq1Model = Base<Sq1State, Sq1Move> & { kind: 'sq1' };
export type ClockModel = Base<ClockState, ClockMove> & { kind: 'clock' };
export type VirtualModel = PolyModel | Sq1Model | ClockModel;

function poly(t: PolyTwisty): PolyModel {
  const p = t.puzzle;
  // an axis's opposite (same line, other way): its layers counted from the other end
  const opposite = p.axes.map((a, i) =>
    p.axes.findIndex(
      (b, j) =>
        j < i &&
        b.order === a.order &&
        Math.abs(b.n[0] + a.n[0]) + Math.abs(b.n[1] + a.n[1]) + Math.abs(b.n[2] + a.n[2]) < 1e-6 &&
        b.cuts.length === a.cuts.length &&
        b.cuts.every((c, k) => Math.abs(c + a.cuts[a.cuts.length - 1 - k]) < 1e-6),
    ),
  );
  const canonical = (m: Move): Move => {
    const o = opposite[m.axis];
    if (o < 0) return m;
    const layers = p.axes[m.axis].cuts.length + 1;
    return { axis: o, from: layers + 1 - m.to, to: layers + 1 - m.from, amount: -m.amount };
  };
  return {
    kind: 'poly',
    id: t.id,
    twisty: t,
    canonical,
    solved: () => p.solved(),
    apply: (s, m) => p.applyMove(s, m),
    allowed: () => true,
    isSolved: (s) => p.isSolved(s),
    isRotation: (m) => t.isRotation(m),
    parse: (alg) => t.parse(alg),
    key: (code) => t.key(code),
    name: (m) => t.name(m),
    parallel(a, b) {
      const x = canonical(a);
      const y = canonical(b);
      return x.axis === y.axis && (x.to < y.from || y.to < x.from);
    },
    countKey(m) {
      if (t.isRotation(m)) return null;
      const c = canonical(m);
      return `${c.axis}:${c.from}:${c.to}`;
    },
  };
}

const sq1: Sq1Model = {
  kind: 'sq1',
  id: 'sq1',
  solved: sq1Solved,
  apply: applySq1,
  allowed: (s, m) => m.kind !== 'slash' || canSlash(s),
  isSolved: sq1IsSolved,
  isRotation: sq1IsRotation,
  parse: parseSq1,
  key: (code) => {
    const m = sq1Key(code);
    return m ? { move: m } : null;
  },
  name: sq1MoveName,
  parallel: () => false,
  countKey: (m) => (m.kind === 'rotate' ? null : m.kind === 'slash' ? '/' : m.top && m.bottom ? 'UD' : m.top ? 'U' : 'D'),
};

const clock: ClockModel = {
  kind: 'clock',
  id: 'clock',
  solved: clockSolved,
  apply: applyClock,
  allowed: () => true,
  isSolved: clockIsSolved,
  isRotation: clockIsRotation,
  parse: parseClock,
  key: (code) => {
    const m = clockKey(code);
    return m ? { move: m } : null;
  },
  name: clockMoveName,
  parallel: (a, b) => a.axis < 8 && Math.floor(a.axis / 4) === Math.floor(b.axis / 4),
  countKey: (m) => (clockIsRotation(m) ? null : `w${m.axis}`),
};

const cache = new Map<string, VirtualModel>();

const EVENT_MODEL: Record<string, string> = {
  '222': 'c2',
  '333': 'c3',
  '333oh': 'c3',
  '333bf': 'c3',
  '333fm': 'c3',
  '444': 'c4',
  '444bf': 'c4',
  '555': 'c5',
  '555bf': 'c5',
  '666': 'c6',
  '777': 'c7',
  pyram: 'pyram',
  skewb: 'skewb',
  minx: 'minx',
  sq1: 'sq1',
  clock: 'clock',
};

function build(key: string): VirtualModel {
  if (/^c\d$/.test(key)) return poly(cubeTwisty(Number(key.slice(1))));
  if (key === 'pyram') return poly(pyraminxTwisty());
  if (key === 'skewb') return poly(skewbTwisty());
  if (key === 'minx') return poly(megaminxTwisty());
  return key === 'sq1' ? sq1 : clock;
}

/** the virtual puzzle for an event (null for one there isn't one for) */
export function modelFor(event: string): VirtualModel | null {
  const key = EVENT_MODEL[event];
  if (!key) return null;
  let m = cache.get(key);
  if (!m) {
    m = build(key);
    cache.set(key, m);
  }
  return m;
}

/** one of its own, its layer depth untouched by a solve (to list its keys) */
export function newModel(event: string): VirtualModel | null {
  const key = EVENT_MODEL[event];
  return key ? build(key) : null;
}
