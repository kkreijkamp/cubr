// Timer page keyboard shortcuts: all of csTimer's (its src/js/shortcut.js), so csTimer habits carry
// over, plus cubr's own on keys csTimer leaves free. Space, Esc and Tab are handled elsewhere.
import type { Penalty } from '@cubr/cubestats';
import type { InputMode } from '../input/inputMode';

export type ShortcutAction =
  | { kind: 'event'; event: string }
  | { kind: 'penalty'; penalty: Penalty }
  | { kind: 'deleteLast' }
  | { kind: 'clearSession' }
  | { kind: 'session'; dir: 1 | -1 }
  | { kind: 'scramble'; dir: 1 | -1 }
  | { kind: 'customScramble' }
  | { kind: 'input'; input: InputMode }
  /** a csTimer input that cubr doesn't have (last layer training) */
  | { kind: 'missingInput'; name: string }
  | { kind: 'comment' }
  | { kind: 'inspection' };

/** alt + key: switch event (csTimer's scramble types) */
const ALT_EVENTS: Record<string, string> = {
  Digit1: 'sq1',
  Digit2: '222',
  Digit3: '333',
  Digit4: '444',
  Digit5: '555',
  Digit6: '666',
  Digit7: '777',
  KeyC: 'clock',
  KeyM: 'minx',
  KeyP: 'pyram',
  KeyS: 'skewb',
};

const ALT: Record<string, ShortcutAction> = {
  ArrowLeft: { kind: 'scramble', dir: -1 },
  ArrowRight: { kind: 'scramble', dir: 1 },
  ArrowUp: { kind: 'session', dir: -1 },
  ArrowDown: { kind: 'session', dir: 1 },
  // csTimer's "input" scramble type: type your own scramble
  KeyI: { kind: 'customScramble' },
  KeyD: { kind: 'clearSession' },
  KeyZ: { kind: 'deleteLast' },
  // cubr's own
  Backspace: { kind: 'deleteLast' },
  KeyN: { kind: 'comment' },
  KeyW: { kind: 'inspection' },
};

const CTRL: Record<string, ShortcutAction> = {
  Digit1: { kind: 'penalty', penalty: 'OK' },
  Digit2: { kind: 'penalty', penalty: '+2' },
  Digit3: { kind: 'penalty', penalty: 'DNF' },
  KeyZ: { kind: 'deleteLast' },
};

/** ctrl + alt + key: how times are entered */
const CTRL_ALT: Record<string, ShortcutAction> = {
  KeyT: { kind: 'input', input: 'timer' },
  KeyI: { kind: 'input', input: 'typing' },
  KeyS: { kind: 'input', input: 'stackmat' },
  KeyM: { kind: 'input', input: 'moyu' },
  KeyV: { kind: 'input', input: 'virtual' },
  KeyG: { kind: 'input', input: 'smartcube' },
  KeyQ: { kind: 'input', input: 'qcube' },
  KeyB: { kind: 'input', input: 'bttimer' },
  KeyL: { kind: 'missingInput', name: 'last layer training' },
};

/** The timer page action for a key press, or null. Keys are matched by position (`code`), like csTimer. */
export function shortcutFor(e: Pick<KeyboardEvent, 'code' | 'altKey' | 'ctrlKey' | 'metaKey'>): ShortcutAction | null {
  if (e.metaKey) return null;
  if (e.ctrlKey && e.altKey) return CTRL_ALT[e.code] ?? null;
  if (e.ctrlKey) return CTRL[e.code] ?? null;
  if (!e.altKey) return null;
  const event = ALT_EVENTS[e.code];
  return event ? { kind: 'event', event } : (ALT[e.code] ?? null);
}
