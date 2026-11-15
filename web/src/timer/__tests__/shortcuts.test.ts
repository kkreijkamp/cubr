import { describe, expect, it } from 'vitest';
import { EVENTS } from '@cubr/cubestats';
import { shortcutFor } from '../shortcuts';

const key = (code: string, mods: { alt?: boolean; ctrl?: boolean; meta?: boolean } = {}) =>
  shortcutFor({ code, altKey: !!mods.alt, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta });
const alt = (code: string) => key(code, { alt: true });
const ctrl = (code: string) => key(code, { ctrl: true });
const ctrlAlt = (code: string) => key(code, { ctrl: true, alt: true });

// csTimer's src/js/shortcut.js, key by key
describe('csTimer shortcuts', () => {
  it('alt + 1-7 / c / m / p / s switch event (csTimer scramble types sqrs, 222so, 333 ... 777wca, clkwca, mgmp, pyrso, skbso)', () => {
    const want: Record<string, string> = {
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
    for (const [code, event] of Object.entries(want)) {
      expect(alt(code), code).toEqual({ kind: 'event', event });
      expect(EVENTS.some((e) => e.id === event), event).toBe(true);
    }
    expect(alt('Digit8')).toBeNull();
  });

  it('alt + i: type your own scramble (csTimer scramble type "input")', () => {
    expect(alt('KeyI')).toEqual({ kind: 'customScramble' });
  });

  it('alt + arrows: previous / next scramble and session; alt + d clears the session; alt + z deletes the latest solve', () => {
    expect(alt('ArrowLeft')).toEqual({ kind: 'scramble', dir: -1 });
    expect(alt('ArrowRight')).toEqual({ kind: 'scramble', dir: 1 });
    // csTimer: up = stats "-" (previous session), down = "+" (next)
    expect(alt('ArrowUp')).toEqual({ kind: 'session', dir: -1 });
    expect(alt('ArrowDown')).toEqual({ kind: 'session', dir: 1 });
    expect(alt('KeyD')).toEqual({ kind: 'clearSession' });
    expect(alt('KeyZ')).toEqual({ kind: 'deleteLast' });
  });

  it('ctrl + 1 / 2 / 3: latest solve OK / +2 / DNF; ctrl + z deletes it', () => {
    expect(ctrl('Digit1')).toEqual({ kind: 'penalty', penalty: 'OK' });
    expect(ctrl('Digit2')).toEqual({ kind: 'penalty', penalty: '+2' });
    expect(ctrl('Digit3')).toEqual({ kind: 'penalty', penalty: 'DNF' });
    expect(ctrl('KeyZ')).toEqual({ kind: 'deleteLast' });
    expect(ctrl('Digit4')).toBeNull();
  });

  it("ctrl + alt + a letter: csTimer's inputs; last layer training says cubr hasn't got it", () => {
    const inputs: Record<string, string> = { KeyT: 'timer', KeyI: 'typing', KeyS: 'stackmat', KeyM: 'moyu', KeyV: 'virtual', KeyG: 'smartcube', KeyQ: 'qcube', KeyB: 'bttimer' };
    for (const [code, input] of Object.entries(inputs)) expect(ctrlAlt(code), code).toEqual({ kind: 'input', input });
    expect(ctrlAlt('KeyL')?.kind).toBe('missingInput');
    // ctrl + alt + a key csTimer doesn't use is nothing, not the alt or ctrl shortcut
    expect(ctrlAlt('KeyD')).toBeNull();
    expect(ctrlAlt('Digit1')).toBeNull();
  });
});

describe("cubr's own", () => {
  it('alt + backspace deletes, alt + n comments, alt + w toggles inspection', () => {
    expect(alt('Backspace')).toEqual({ kind: 'deleteLast' });
    expect(alt('KeyN')).toEqual({ kind: 'comment' });
    expect(alt('KeyW')).toEqual({ kind: 'inspection' });
  });

  it('plain keys and cmd (meta) combinations are not shortcuts', () => {
    expect(key('Digit1')).toBeNull();
    expect(key('KeyZ', { meta: true })).toBeNull();
    expect(key('Digit2', { alt: true, meta: true })).toBeNull();
  });
});
