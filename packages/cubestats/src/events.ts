export interface EventInfo {
  /** WCA event id */
  id: string;
  name: string;
  short: string;
  /** cubing.js puzzle id for <twisty-player puzzle="..."> */
  puzzle: string;
  /** WCA inspection applies */
  inspection: boolean;
  unit: 'time' | 'moves';
  /** blindfolded events: no inspection, results are often reported as mo3 */
  blind: boolean;
}

export const EVENTS: EventInfo[] = [
  { id: '333', name: '3x3x3 Cube', short: '3x3', puzzle: '3x3x3', inspection: true, unit: 'time', blind: false },
  { id: '222', name: '2x2x2 Cube', short: '2x2', puzzle: '2x2x2', inspection: true, unit: 'time', blind: false },
  { id: '444', name: '4x4x4 Cube', short: '4x4', puzzle: '4x4x4', inspection: true, unit: 'time', blind: false },
  { id: '555', name: '5x5x5 Cube', short: '5x5', puzzle: '5x5x5', inspection: true, unit: 'time', blind: false },
  { id: '666', name: '6x6x6 Cube', short: '6x6', puzzle: '6x6x6', inspection: true, unit: 'time', blind: false },
  { id: '777', name: '7x7x7 Cube', short: '7x7', puzzle: '7x7x7', inspection: true, unit: 'time', blind: false },
  { id: '333oh', name: '3x3x3 One-Handed', short: '3x3 OH', puzzle: '3x3x3', inspection: true, unit: 'time', blind: false },
  { id: '333bf', name: '3x3x3 Blindfolded', short: '3BLD', puzzle: '3x3x3', inspection: false, unit: 'time', blind: true },
  { id: '333fm', name: '3x3x3 Fewest Moves', short: 'FMC', puzzle: '3x3x3', inspection: false, unit: 'moves', blind: false },
  { id: '444bf', name: '4x4x4 Blindfolded', short: '4BLD', puzzle: '4x4x4', inspection: false, unit: 'time', blind: true },
  { id: '555bf', name: '5x5x5 Blindfolded', short: '5BLD', puzzle: '5x5x5', inspection: false, unit: 'time', blind: true },
  { id: 'clock', name: 'Clock', short: 'Clock', puzzle: 'clock', inspection: true, unit: 'time', blind: false },
  { id: 'minx', name: 'Megaminx', short: 'Mega', puzzle: 'megaminx', inspection: true, unit: 'time', blind: false },
  { id: 'pyram', name: 'Pyraminx', short: 'Pyra', puzzle: 'pyraminx', inspection: true, unit: 'time', blind: false },
  { id: 'skewb', name: 'Skewb', short: 'Skewb', puzzle: 'skewb', inspection: true, unit: 'time', blind: false },
  { id: 'sq1', name: 'Square-1', short: 'SQ-1', puzzle: 'square1', inspection: true, unit: 'time', blind: false },
];

export const EVENT_IDS = EVENTS.map((e) => e.id);
const BY_ID = new Map(EVENTS.map((e) => [e.id, e]));

export function getEvent(id: string): EventInfo | undefined {
  return BY_ID.get(id);
}

export function isEventId(id: string): boolean {
  return BY_ID.has(id);
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
