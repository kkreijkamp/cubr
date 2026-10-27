// Your own keys for the virtual puzzles. csTimer's layout stays the list of moves, and a binding
// sends a key to the move another key has there ("KeyQ" -> "KeyI": q turns R), so only which key
// does what changes. Kept as swaps: giving a move a key that already does something hands that
// the move's old key, so every move keeps a key and no key does two things.
import type { VirtualModel } from './models';

/** the puzzles with a layout of their own (every cube shares one, as on csTimer) */
export const KEY_PUZZLES = [
  { id: 'cube', label: 'cube', event: '333' },
  { id: 'pyram', label: 'pyraminx', event: 'pyram' },
  { id: 'skewb', label: 'skewb', event: 'skewb' },
  { id: 'minx', label: 'megaminx', event: 'minx' },
  { id: 'sq1', label: 'square-1', event: 'sq1' },
  { id: 'clock', label: 'clock', event: 'clock' },
] as const;
export type KeyPuzzle = (typeof KEY_PUZZLES)[number]['id'];

/** a key pressed (KeyboardEvent.code) -> the key whose move it makes in csTimer's layout; a key left out makes its own */
export type KeyMap = Record<string, string>;
export type KeyMaps = Partial<Record<KeyPuzzle, KeyMap>>;

/** keys a move can go on (space, esc, tab, enter and the arrows have jobs of their own) */
export const BINDABLE = /^(Key[A-Z]|Digit\d|Numpad\d|Semicolon|Quote|Comma|Period|Slash|Backslash|BracketLeft|BracketRight|Minus|Equal|Backquote)$/;

const PUNCTUATION: Record<string, string> = {
  ';': 'Semicolon',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
};
const codes = (keys: string) => keys.split(' ').map((k) => PUNCTUATION[k] ?? (/\d/.test(k) ? `Digit${k}` : `Key${k}`));

// csTimer's moves in the order they're listed: the faces, then the wide and slice turns, then the
// whole puzzle (and a cube's depth keys)
const ORDER: Record<KeyPuzzle, string[]> = {
  cube: codes('I K D E J F S L H G W O U M V R , C Z / 5 6 X . 2 9 0 1 T Y N B ; A P Q 4 3 7 8'),
  pyram: codes('I K D E J F W O U M V R H G S L Y N B T ; A Q P'),
  skewb: codes('J F W O I K D E H G S L T Y N B ; A P Q'),
  minx: codes('I K D E J F H G W O S L C , Y N B T ; A P Q'),
  sq1: codes('I K J F H G S L W O T Y N B ; A P Q'),
  clock: codes('T Y G H Q W E R U I O P A S D F J K L ; B N'),
};

const DEPTH: Record<string, string> = {
  Digit4: 'L deeper',
  Digit3: 'L shallower',
  Digit7: 'R deeper',
  Digit8: 'R shallower',
};

/** the layout a puzzle uses */
export function keyPuzzle(model: VirtualModel): KeyPuzzle {
  if (model.kind !== 'poly') return model.kind;
  return ({ pyraminx: 'pyram', skewb: 'skewb', megaminx: 'minx' } as Record<string, KeyPuzzle>)[model.id] ?? 'cube';
}

/** the key whose move a pressed key makes */
export const actionOf = (map: KeyMap, code: string): string => map[code] ?? code;

/** the key that makes a move (given by its key in csTimer's layout) */
export function keyOf(map: KeyMap, action: string): string {
  for (const [code, a] of Object.entries(map)) if (a === action) return code;
  return action;
}

/** a move onto a key: whatever that key did goes to the move's old key */
export function bind(map: KeyMap, action: string, code: string): KeyMap {
  const old = keyOf(map, action);
  if (old === code) return map;
  const next: KeyMap = { ...map, [code]: action, [old]: actionOf(map, code) };
  for (const k of Object.keys(next)) if (next[k] === k) delete next[k];
  return next;
}

/** a stored map kept only if it is whole swaps of keys a move can go on */
function cleanKeyMap(raw: unknown): KeyMap | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.every(([k, v]) => BINDABLE.test(k) && typeof v === 'string' && BINDABLE.test(v) && k !== v)) return null;
  const from = new Set(entries.map(([k]) => k));
  const to = new Set(entries.map(([, v]) => v as string));
  if (to.size !== entries.length || [...to].some((v) => !from.has(v))) return null;
  return Object.fromEntries(entries) as KeyMap;
}

/** every puzzle's stored map, those that aren't a puzzle's or aren't whole swaps left out */
export function cleanKeyMaps(raw: unknown): KeyMaps {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: KeyMaps = {};
  for (const { id } of KEY_PUZZLES) {
    const map = cleanKeyMap((raw as Record<string, unknown>)[id]);
    if (map && Object.keys(map).length > 0) out[id] = map;
  }
  return out;
}

export interface Control {
  /** the move, as the puzzle names it */
  label: string;
  /** csTimer's keys for it (each is a key of its own to set) */
  actions: string[];
}

/** a puzzle's moves for the key lists: one each, with every csTimer key that makes it */
export function controls(model: VirtualModel): Control[] {
  const m = model as unknown as { key(c: string): { move: unknown } | { depth: true } | null; name(mv: unknown): string };
  const out: Control[] = [];
  for (const action of ORDER[keyPuzzle(model)]) {
    const r = m.key(action);
    if (!r) continue;
    const label = 'move' in r ? m.name(r.move) : DEPTH[action];
    const same = out.find((c) => c.label === label);
    if (same) same.actions.push(action);
    else out.push({ label, actions: [action] });
  }
  return out;
}

const SYMBOLS: Record<string, string> = {
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

/** what's printed on a key: from the keyboard's own layout where the browser has it, else as on a US keyboard */
export function keyLabel(code: string, layout?: ReadonlyMap<string, string> | null): string {
  const own = layout?.get(code);
  if (own) return own.toLowerCase();
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `num ${code.slice(6)}`;
  return SYMBOLS[code] ?? code;
}
