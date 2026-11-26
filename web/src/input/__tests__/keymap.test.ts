import { describe, expect, it } from 'vitest';
import { actionOf, bind, BINDABLE, cleanKeyMaps, controls, KEY_PUZZLES, keyLabel, keyOf, keyPuzzle, type KeyMap } from '../virtual/keymap';
import { modelFor, newModel } from '../virtual/models';
import { VirtualSession } from '../virtual/session';

const ALL = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
  .map((c) => `Key${c}`)
  .concat(
    [...'0123456789'].map((d) => `Digit${d}`),
    ['Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backslash', 'BracketLeft', 'BracketRight', 'Minus', 'Equal', 'Backquote'],
  );

/** every key makes one move and every move has one key */
const isSwaps = (map: KeyMap) => {
  const made = ALL.map((k) => actionOf(map, k));
  return new Set(made).size === ALL.length && ALL.every((a) => actionOf(map, keyOf(map, a)) === a);
};

describe('your own virtual puzzle keys', () => {
  it("lists every move of csTimer's layout, once each, with all its keys", () => {
    for (const p of KEY_PUZZLES) {
      const m = newModel(p.event)!;
      expect(keyPuzzle(m)).toBe(p.id);
      const listed = controls(m).flatMap((c) => c.actions);
      const answered = ALL.filter((k) => (m as unknown as { key(c: string): unknown }).key(k) !== null);
      expect(listed.sort()).toEqual(answered.sort());
    }
    const cube = controls(newModel('333')!);
    expect(cube.slice(0, 4).map((c) => c.label)).toEqual(['R', "R'", 'L', "L'"]);
    expect(cube.find((c) => c.label === 'x')?.actions).toEqual(['KeyT', 'KeyY']);
    // the middle layer by its 3x3 name
    expect(cube.find((c) => c.label === 'M')?.actions).toEqual(['Digit5', 'Digit6']);
    expect(cube.find((c) => c.label === "M'")?.actions).toEqual(['KeyX', 'Period']);
    expect(cube.find((c) => c.label === 'E')?.actions).toEqual(['Digit2']);
    expect(cube.find((c) => c.label === "S'")?.actions).toEqual(['Digit1']);
    expect(cube.at(-1)).toEqual({ label: 'R shallower', actions: ['Digit8'] });
  });

  it('swaps: a move put on a key that did something hands that its old key', () => {
    const map = bind({}, 'KeyI', 'KeyJ');
    expect(actionOf(map, 'KeyJ')).toBe('KeyI');
    expect(actionOf(map, 'KeyI')).toBe('KeyJ');
    expect(keyOf(map, 'KeyI')).toBe('KeyJ');
    // back where it was: nothing kept
    expect(bind(map, 'KeyI', 'KeyI')).toEqual({});
    // a free key: the old one does nothing (it makes the free key's no-move)
    const free = bind({}, 'KeyI', 'Quote');
    expect(actionOf(free, 'Quote')).toBe('KeyI');
    expect(actionOf(free, 'KeyI')).toBe('Quote');
    expect(bind(free, 'KeyI', 'KeyI')).toEqual({});
  });

  it('stays whole swaps however many keys are moved', () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
    let map: KeyMap = {};
    for (let i = 0; i < 500; i++) {
      map = bind(map, ALL[rnd(ALL.length)], ALL[rnd(ALL.length)]);
      expect(isSwaps(map)).toBe(true);
      expect(Object.entries(map).every(([k, v]) => k !== v)).toBe(true);
    }
  });

  it('keeps only stored maps that are whole swaps of usable keys', () => {
    const good = bind(bind({}, 'KeyI', 'KeyJ'), 'KeyD', 'Quote');
    expect(cleanKeyMaps({ cube: good, skewb: {} })).toEqual({ cube: good });
    // a key doing two moves, a move with no key, a key with a job of its own, a puzzle that isn't one
    expect(cleanKeyMaps({ cube: { KeyJ: 'KeyI', KeyK: 'KeyI' } })).toEqual({});
    expect(cleanKeyMaps({ cube: { KeyJ: 'KeyI' } })).toEqual({});
    expect(cleanKeyMaps({ cube: { Space: 'KeyI', KeyI: 'Space' } })).toEqual({});
    expect(cleanKeyMaps({ c3: good, pyram: 'x' })).toEqual({});
    expect(cleanKeyMaps(null)).toEqual({});
    expect(cleanKeyMaps([good])).toEqual({});
    expect(BINDABLE.test('ArrowLeft') || BINDABLE.test('Space') || BINDABLE.test('Tab') || BINDABLE.test('Enter')).toBe(false);
  });

  it('turns the puzzle by your keys', () => {
    const model = modelFor('333')!;
    const s = new VirtualSession(model, { speed: 0, blind: false, inspection: false });
    // R on j (U goes to i)
    const map = bind({}, 'KeyI', 'KeyJ');
    s.scramble("R'", 0);
    expect(s.key(actionOf(map, 'KeyI'), 10).solved).toBeUndefined();
    expect(s.key(actionOf(map, 'KeyI'), 20).solved).toBeUndefined();
    expect(s.key(actionOf(map, 'KeyF'), 30).solved).toBeUndefined();
    expect(s.key(actionOf(map, 'KeyF'), 40).solved).toBeUndefined();
    expect(s.key(actionOf(map, 'KeyJ'), 50).solved?.timeMs).toBe(40);
  });

  it('names a key as printed on it', () => {
    expect(keyLabel('KeyQ')).toBe('q');
    expect(keyLabel('KeyQ', new Map([['KeyQ', 'A']]))).toBe('a');
    expect(keyLabel('Digit5')).toBe('5');
    expect(keyLabel('Semicolon')).toBe(';');
    expect(keyLabel('Numpad7')).toBe('num 7');
  });
});
