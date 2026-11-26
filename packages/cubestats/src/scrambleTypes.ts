// The kinds of scramble each event offers (csTimer's second scramble menu, without the jokes and
// the tools that need their own screens). The first one is the event's default: the only one
// whose solves count for personal bests and leaderboards. A session made for any other type is a
// practice session (the timer's scramble menu, between the event and the session).
//
// Ids are csTimer's scramble ids, so they read the same as in csTimer and its exports. `pending`
// types are listed but can't be scrambled yet: csTimer added them after the version of its
// scramblers cubr uses (cstimer_module 0.1.5).
import { getEvent, isEventId } from './events.js';

export interface ScrambleType {
  id: string;
  label: string;
  /** the heading it's listed under (none for the default) */
  group?: string;
  /** listed, but not scrambled yet */
  pending?: true;
}

const T = (id: string, label: string, group?: string): ScrambleType => (group ? { id, label, group } : { id, label });
const P = (id: string, label: string, group?: string): ScrambleType => ({ ...T(id, label, group), pending: true });

const C = 'whole cube';
const CFOP = 'cfop';
const ROUX = 'roux';
const MEHTA = 'mehta';
const SUB = 'move subsets';
const EDGES = 'edges and centres';
const NOTATION = 'notation';

/** 3x3 practice scrambles, shared by 3x3 and 3x3 one-handed */
const PRACTICE_333: ScrambleType[] = [
  T('333o', 'random move', C),
  T('edges', 'edges only', C),
  T('corners', 'corners only', C),
  T('pll', 'pll', CFOP),
  T('oll', 'oll', CFOP),
  T('ll', 'last layer', CFOP),
  T('lsll2', 'last slot + last layer', CFOP),
  T('zbll', 'zbll', CFOP),
  T('coll', 'coll', CFOP),
  T('cll', 'cll', CFOP),
  T('ell', 'ell', CFOP),
  T('2gll', '2gll', CFOP),
  T('zzll', 'zzll', CFOP),
  T('zbls', 'zbls', CFOP),
  T('eols', 'eols', CFOP),
  T('wvls', 'wvls', CFOP),
  T('vls', 'vls', CFOP),
  T('f2l', 'cross solved', CFOP),
  T('eoline', 'eoline', CFOP),
  T('eocross', 'eocross', CFOP),
  T('easyc', 'easy cross', CFOP),
  T('easyxc', 'easy xcross', CFOP),
  T('sbrx', '2nd block', ROUX),
  T('cmll', 'cmll', ROUX),
  T('lse', 'lse', ROUX),
  T('lsemu', 'lse <M,U>', ROUX),
  T('mt3qb', '3qb', MEHTA),
  T('mteole', 'eole', MEHTA),
  T('mttdr', 'tdr', MEHTA),
  T('mt6cp', '6cp', MEHTA),
  T('mtcdrll', 'cdrll', MEHTA),
  T('mtl5ep', 'l5ep', MEHTA),
  T('ttll', 'ttll', MEHTA),
  T('2gen', '<R,U>', SUB),
  T('2genl', '<L,U>', SUB),
  T('roux', '<M,U>', SUB),
  T('3gen_F', '<F,R,U>', SUB),
  T('3gen_L', '<R,U,L>', SUB),
  T('RrU', '<R,r,U>', SUB),
  T('333drud', 'domino subgroup', SUB),
  T('half', 'half turns only', SUB),
  T('lsll', 'last slot + last layer (old)', SUB),
];

export const SCRAMBLE_TYPES: Record<string, ScrambleType[]> = {
  '333': [T('333', 'wca'), ...PRACTICE_333],
  '333oh': [T('333', 'wca'), ...PRACTICE_333],
  '333bf': [T('333ni', 'wca'), T('edges', 'edges only', C), T('corners', 'corners only', C)],
  '333fm': [T('333fm', 'wca')],
  '222': [
    T('222so', 'wca'),
    T('222o', 'optimal', C),
    T('2223', '3-gen', C),
    T('222eg', 'eg', 'last layer'),
    T('222eg0', 'cll', 'last layer'),
    T('222eg1', 'eg-1', 'last layer'),
    T('222eg2', 'eg-2', 'last layer'),
    T('222tcp', 'tcll+', 'last layer'),
    T('222tcn', 'tcll-', 'last layer'),
    T('222tc', 'tcll', 'last layer'),
    T('222lsall', 'last slot', 'last layer'),
    T('222nb', 'no bar', C),
  ],
  '444': [
    T('444wca', 'wca'),
    T('444m', 'random move', NOTATION),
    T('444', 'sign', NOTATION),
    T('444yj', 'yj', NOTATION),
    T('RrUu', '<R,r,U,u>', NOTATION),
    T('4edge', '4x4 edges', EDGES),
    T('444edo', 'edges only', EDGES),
    T('444cto', 'centres only', EDGES),
    T('444ll', 'last layer', 'reduction'),
    T('444ell', 'ell', 'reduction'),
    T('444ctud', 'ud centres solved', 'yau / hoya'),
    T('444ud3c', 'ud + 3 cross edges', 'yau / hoya'),
    T('444l8e', 'last 8 dedges', 'yau / hoya'),
    T('444ctrl', 'rl centres solved', 'yau / hoya'),
    T('444rlda', 'rldx centres solved', 'yau / hoya'),
    T('444rlca', 'rldx cross solved', 'yau / hoya'),
  ],
  '555': [T('555wca', 'wca'), T('555', 'sign', NOTATION), T('5edge', '5x5 edges', EDGES)],
  '666': [T('666wca', 'wca'), T('666si', 'sign', NOTATION), T('666p', 'prefix', NOTATION), T('6edge', '6x6 edges', EDGES)],
  '777': [T('777wca', 'wca'), T('777si', 'sign', NOTATION), T('777p', 'prefix', NOTATION), T('7edge', '7x7 edges', EDGES)],
  '444bf': [T('444bld', 'wca')],
  '555bf': [T('555bld', 'wca')],
  clock: [
    T('clkwca', 'wca'),
    T('clkwcab', 'wca (old)', NOTATION),
    T('clknf', 'wca without y2', NOTATION),
    T('clk', 'jaap', NOTATION),
    T('clko', 'optimal', NOTATION),
    T('clkc', 'concise', NOTATION),
    T('clke', 'efficient pin order', NOTATION),
  ],
  minx: [
    T('mgmp', 'wca'),
    T('mgmc', 'carrot', NOTATION),
    T('mgmo', 'old style', NOTATION),
    T('minx2g', '<R,U>', NOTATION),
    T('mgmso', 'random state', NOTATION),
    T('mlsll', 'last slot + last layer', 'last layer'),
    T('mgmpll', 'pll', 'last layer'),
    T('mgmll', 'last layer', 'last layer'),
    P('mgms2l', 's2l', 'last layer'),
  ],
  pyram: [
    T('pyrso', 'wca'),
    T('pyro', 'optimal', C),
    T('pyrm', 'random move', C),
    T('pyrl4e', 'l4e', 'steps'),
    P('pyrtop', 'top first', 'steps'),
    T('pyr4c', '4 tips', 'steps'),
    T('pyrnb', 'no bar', 'steps'),
  ],
  skewb: [T('skbso', 'wca'), T('skbo', 'optimal', C), T('skb', 'random move', C), T('skbnb', 'no bar', 'steps'), P('skbll', 'last layer', 'steps')],
  sq1: [
    T('sqrs', 'wca'),
    T('sqrcsp', 'csp', 'steps'),
    T('sq1pll', 'pll', 'steps'),
    T('sq1h', 'face turn metric', NOTATION),
    T('sq1t', 'twist metric', NOTATION),
  ],
  fto: [
    T('ftoso', 'wca'),
    T('fto', 'random move', C),
    T('ftol3t', 'l3t', 'steps'),
    T('ftol4t', 'l3t + lbt', 'steps'),
    T('ftotcp', 'tcp', 'steps'),
    T('ftoedge', 'edges only', 'steps'),
    T('ftocent', 'centres only', 'steps'),
    T('ftocorn', 'corners only', 'steps'),
  ],
  r234: [T('r234w', 'wca')],
  r2345: [T('r2345w', 'wca')],
  r23456: [T('r23456w', 'wca')],
  r234567: [T('r234567w', 'wca')],
  rmngf: [T('rmngf', 'wca')],
  r3: [T('r3', '5 cubes')],
  '133': [T('133', 'random state')],
  '223': [T('223', 'random state')],
  '233': [T('233', 'random move')],
  '334': [T('334', 'random move')],
  '335': [T('335', 'random move')],
  '336': [T('336', 'random move')],
  '337': [T('337', 'random move')],
  '888': [T('888', 'sign')],
  '999': [T('999', 'sign')],
  '101010': [T('101010', 'sign')],
  '111111': [T('111111', 'sign')],
  mrbl: [T('mrbl', 'random state')],
  crz3a: [T('crz3a', 'random move')],
  sia113: [T('sia113', 'random move')],
  sia123: [T('sia123', 'random move')],
  sia222: [T('sia222', 'random move')],
  bic: [T('bic', 'random move')],
  sfl: [T('sfl', 'random move')],
  klm: [T('klmso', 'random state'), T('klmp', 'pochmann', NOTATION)],
  giga: [T('giga', 'pochmann')],
  prc: [T('prcp', 'pochmann'), T('prco', 'old style', NOTATION)],
  mpyr: [T('mpyrso', 'random state'), T('mpyr', 'random move', NOTATION)],
  dmd: [T('dmdso', 'random state')],
  gear: [T('gearso', 'random state'), T('gearo', 'optimal', C), T('gear', 'random move', C)],
  redi: [T('rediso', 'random state'), T('redim', 'moyu', NOTATION), T('redi', 'random move', NOTATION)],
  dino: [T('dinoso', 'random state'), T('dinoo', 'optimal', C)],
  ivy: [T('ivyso', 'random state'), T('ivyo', 'optimal', C), T('ivy', 'random move', C)],
  heli: [T('heli', 'random move')],
  helicv: [T('helicv', 'random move')],
  heli2x2: [T('heli2x2', 'random move'), T('heli2x2g', 'by group', C)],
  sq2: [T('sq2', 'random move')],
  ssq1: [T('ssq1t', 'twist metric')],
  bsq: [T('bsq', 'random move')],
  cm3: [T('cm3', 'random move')],
  cm2: [T('cm2', 'random move')],
  ufo: [T('ufo', 'jaap style')],
  ctico: [T('ctico', 'random move')],
  '15p': [
    T('15prp', 'random state, urld'),
    T('15prap', 'random state, arrows', NOTATION),
    T('15prmp', 'random state, blank', NOTATION),
    T('15p', 'random move, urld', NOTATION),
    T('15pat', 'random move, arrows', NOTATION),
    T('15pm', 'random move, blank', NOTATION),
  ],
  '8p': [T('8prp', 'random state, urld'), T('8prap', 'random state, arrows', NOTATION), T('8prmp', 'random state, blank', NOTATION)],
};

/** An event's scramble types, its default first (an unknown event has none). */
export function scrambleTypesFor(event: string): ScrambleType[] {
  return isEventId(event) ? (SCRAMBLE_TYPES[event] ?? []) : [];
}

/** The scramble every solve of `event` counts with. */
export function defaultScrambleType(event: string): ScrambleType | undefined {
  return scrambleTypesFor(event)[0];
}

/** One of `event`'s scramble types, the default included. */
export function getScrambleType(event: string, id: string): ScrambleType | undefined {
  return scrambleTypesFor(event).find((t) => t.id === id);
}

/** A practice scramble of `event`: known and not its default (what a session's `scramble` may hold). */
export function isPracticeScramble(event: string, id: string): boolean {
  const types = scrambleTypesFor(event);
  return types.findIndex((t) => t.id === id) > 0;
}

/** An event cubr can scramble (its default isn't pending). */
export function isEventReady(event: string): boolean {
  const d = defaultScrambleType(event);
  return !!d && !d.pending;
}

/** A session of a practice scramble: "3x3 pll", "2x2 eg-1". */
export function scrambleSessionName(event: string, id: string): string {
  const short = getEvent(event)?.short ?? event;
  const label = getScrambleType(event, id)?.label ?? id;
  return `${short} ${label}`.slice(0, 40);
}
