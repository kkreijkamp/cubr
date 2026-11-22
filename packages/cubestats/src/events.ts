/** 'wca': an official WCA event (leaderboards, races, the daily challenge); 'other': csTimer's other puzzles and relays. */
export type EventKind = 'wca' | 'other';

export interface EventInfo {
  /** WCA event id (WCA events), or csTimer's scramble id for the puzzle (other events) */
  id: string;
  name: string;
  short: string;
  /** cubing.js puzzle id for <twisty-player puzzle="...">; null when cubing.js can't draw it (no preview) */
  puzzle: string | null;
  /** WCA inspection applies */
  inspection: boolean;
  unit: 'time' | 'moves';
  /** blindfolded events: no inspection, results are often reported as mo3 */
  blind: boolean;
  kind: EventKind;
}

const wca = (id: string, name: string, short: string, puzzle: string, opts: { inspection?: boolean; unit?: 'time' | 'moves'; blind?: boolean } = {}): EventInfo => ({
  id,
  name,
  short,
  puzzle,
  inspection: opts.inspection ?? true,
  unit: opts.unit ?? 'time',
  blind: opts.blind ?? false,
  kind: 'wca',
});

/** The WCA events, in WCA order. FTO is official from 2 January 2027 (WCA, June 2026). */
export const EVENTS: EventInfo[] = [
  wca('333', '3x3x3 Cube', '3x3', '3x3x3'),
  wca('222', '2x2x2 Cube', '2x2', '2x2x2'),
  wca('444', '4x4x4 Cube', '4x4', '4x4x4'),
  wca('555', '5x5x5 Cube', '5x5', '5x5x5'),
  wca('666', '6x6x6 Cube', '6x6', '6x6x6'),
  wca('777', '7x7x7 Cube', '7x7', '7x7x7'),
  wca('333oh', '3x3x3 One-Handed', '3x3 OH', '3x3x3'),
  wca('333bf', '3x3x3 Blindfolded', '3BLD', '3x3x3', { inspection: false, blind: true }),
  wca('333fm', '3x3x3 Fewest Moves', 'FMC', '3x3x3', { inspection: false, unit: 'moves' }),
  wca('444bf', '4x4x4 Blindfolded', '4BLD', '4x4x4', { inspection: false, blind: true }),
  wca('555bf', '5x5x5 Blindfolded', '5BLD', '5x5x5', { inspection: false, blind: true }),
  wca('clock', 'Clock', 'Clock', 'clock'),
  wca('minx', 'Megaminx', 'Mega', 'megaminx'),
  wca('pyram', 'Pyraminx', 'Pyra', 'pyraminx'),
  wca('skewb', 'Skewb', 'Skewb', 'skewb'),
  wca('sq1', 'Square-1', 'SQ-1', 'square1'),
  wca('fto', 'Face-Turning Octahedron', 'FTO', 'fto'),
];

const other = (id: string, name: string, short: string, puzzle: string | null = null, inspection = true): EventInfo => ({
  id,
  name,
  short,
  puzzle,
  inspection,
  unit: 'time',
  blind: false,
  kind: 'other',
});

/**
 * csTimer's other puzzles (its "other" and "special" groups, without the jokes), in the timer's
 * "other events" list. A csTimer group of different puzzles (LxMxN, Cmetrick, Helicopter, Siamese,
 * Square, Bandaged, Relays) is split into one event per puzzle; the different ways of scrambling
 * one puzzle are its scramble types (scrambleTypes.ts). The relays use WCA scrambles.
 */
export const OTHER_EVENTS: EventInfo[] = [
  other('r234', '2x2x2-4x4x4 Relay', '2-4 relay', null, false),
  other('r2345', '2x2x2-5x5x5 Relay', '2-5 relay', null, false),
  other('r23456', '2x2x2-6x6x6 Relay', '2-6 relay', null, false),
  other('r234567', '2x2x2-7x7x7 Relay', '2-7 relay', null, false),
  other('rmngf', 'Mini Guildford', 'Mini Guildford', null, false),
  other('r3', '3x3x3 Relay of 5', '3x3 relay', null, false),
  other('133', 'Floppy Cube (1x3x3)', 'Floppy'),
  other('223', 'Tower Cube (2x2x3)', 'Tower'),
  other('233', 'Domino (2x3x3)', 'Domino'),
  other('334', '3x3x4 Cuboid', '3x3x4'),
  other('335', '3x3x5 Cuboid', '3x3x5'),
  other('336', '3x3x6 Cuboid', '3x3x6'),
  other('337', '3x3x7 Cuboid', '3x3x7'),
  other('888', '8x8x8 Cube', '8x8'),
  other('999', '9x9x9 Cube', '9x9'),
  other('101010', '10x10x10 Cube', '10x10'),
  other('111111', '11x11x11 Cube', '11x11'),
  other('mrbl', 'Mirror Blocks', 'Mirror blocks'),
  other('crz3a', 'Crazy 3x3x3', 'Crazy 3x3'),
  other('sia113', 'Siamese Cube (1x1x3 block)', 'Siamese 1x1x3'),
  other('sia123', 'Siamese Cube (1x2x3 block)', 'Siamese 1x2x3'),
  other('sia222', 'Siamese Cube (2x2x2 block)', 'Siamese 2x2x2'),
  other('bic', 'Bicube', 'Bicube'),
  other('sfl', 'Super Floppy', 'Super floppy'),
  other('klm', 'Kilominx', 'Kilominx', 'kilominx'),
  other('giga', 'Gigaminx', 'Gigaminx', 'gigaminx'),
  other('prc', 'Pyraminx Crystal', 'Pyra crystal'),
  other('mpyr', 'Master Pyraminx', 'Master pyra', 'master_tetraminx'),
  other('dmd', 'Diamond', 'Diamond'),
  other('gear', 'Gear Cube', 'Gear cube'),
  other('redi', 'Redi Cube', 'Redi cube', 'redi_cube'),
  other('dino', 'Dino Cube', 'Dino cube'),
  other('ivy', 'Ivy Cube', 'Ivy cube'),
  other('heli', 'Helicopter Cube', 'Helicopter'),
  other('helicv', 'Curvy Copter', 'Curvy copter'),
  other('heli2x2', '2x2 Helicopter Cube', '2x2 heli'),
  other('sq2', 'Square-2', 'Square-2'),
  other('ssq1', 'Super Square-1', 'Super SQ-1'),
  other('bsq', 'Bandaged Square-1', 'Bandaged SQ-1'),
  other('cm3', 'Cmetrick', 'Cmetrick'),
  other('cm2', 'Cmetrick Mini', 'Cmetrick mini'),
  other('ufo', 'UFO', 'UFO'),
  other('ctico', 'Icosamate', 'Icosamate'),
  other('15p', '15 Puzzle', '15 puzzle'),
  other('8p', '8 Puzzle', '8 puzzle'),
];

export const ALL_EVENTS: EventInfo[] = [...EVENTS, ...OTHER_EVENTS];

/**
 * The relays' puzzles, in order: the label each one's scramble starts with ("2x2: ...", one line
 * per puzzle) and the WCA event it is scrambled as.
 */
export const RELAY_PARTS: Readonly<Record<string, readonly (readonly [label: string, event: string])[]>> = {
  r234: [['2x2', '222'], ['3x3', '333'], ['4x4', '444']],
  r2345: [['2x2', '222'], ['3x3', '333'], ['4x4', '444'], ['5x5', '555']],
  r23456: [['2x2', '222'], ['3x3', '333'], ['4x4', '444'], ['5x5', '555'], ['6x6', '666']],
  r234567: [['2x2', '222'], ['3x3', '333'], ['4x4', '444'], ['5x5', '555'], ['6x6', '666'], ['7x7', '777']],
  rmngf: [['2x2', '222'], ['3x3', '333'], ['4x4', '444'], ['5x5', '555'], ['3x3 oh', '333oh'], ['pyra', 'pyram'], ['skewb', 'skewb'], ['sq-1', 'sq1'], ['clock', 'clock'], ['mega', 'minx']],
  r3: [['1', '333'], ['2', '333'], ['3', '333'], ['4', '333'], ['5', '333']],
};

/** the relays: one scramble line per puzzle ("2x2: ...", "3x3: ...") */
export const RELAY_EVENTS: readonly string[] = Object.keys(RELAY_PARTS);

/**
 * A relay's scramble split into its puzzles' scrambles, in order. A line that doesn't start with one
 * of the relay's labels carries on the one before (a megaminx scramble is several lines). Null for
 * an event that isn't a relay or a scramble that doesn't start with its first label.
 */
export function splitRelay(event: string, scramble: string): { label: string; event: string; scramble: string }[] | null {
  const parts = RELAY_PARTS[event];
  if (!parts) return null;
  const labels = new Map(parts.map(([label, ev]) => [label, ev]));
  const out: { label: string; event: string; scramble: string }[] = [];
  for (const line of scramble.split('\n')) {
    const m = /^\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    const ev = m ? labels.get(m[1]) : undefined;
    if (m && ev) out.push({ label: m[1], event: ev, scramble: m[2].trim() });
    else if (out.length) out[out.length - 1].scramble = `${out[out.length - 1].scramble}\n${line.trim()}`.trim();
    else if (line.trim()) return null;
  }
  return out.length ? out : null;
}

/** The WCA events' ids (leaderboards, scramble pools, races) */
export const EVENT_IDS = EVENTS.map((e) => e.id);
/** Every event's id, WCA first */
export const ALL_EVENT_IDS = ALL_EVENTS.map((e) => e.id);
const BY_ID = new Map(ALL_EVENTS.map((e) => [e.id, e]));

export function getEvent(id: string): EventInfo | undefined {
  return BY_ID.get(id);
}

/** Any event cubr times: a WCA event or one of the other events. */
export function isEventId(id: string): boolean {
  return BY_ID.has(id);
}

/** An official WCA event (leaderboards and races are for these). */
export function isWcaEvent(id: string): boolean {
  return BY_ID.get(id)?.kind === 'wca';
}

/** Name of an event's default session: its short name ("3x3", "3x3 OH", "SQ-1"). */
export function defaultSessionName(id: string): string {
  return getEvent(id)?.short ?? id;
}

/**
 * Name of an event's default practice session ("3x3 practice"). Every event gets one next to its
 * default session: the server creates the pair for a new account, the web app when you first open
 * an event, and solve migration 004 backfilled accounts that existed before.
 */
export function practiceSessionName(id: string): string {
  return `${defaultSessionName(id)} practice`;
}

/** Events that have a daily challenge (5 scrambles per day, ranked by ao5). */
export const DAILY_EVENTS = ['333', '222', '444', 'pyram', 'skewb'];
