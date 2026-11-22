import { describe, expect, it } from 'vitest';
import { ALL_EVENTS } from '../src/events.js';
import { RANDOM_MOVE_TYPES, randomMoveScramble } from '../src/randomMoves.js';
import { defaultScrambleType, getScrambleType, isEventReady, isPracticeScramble, scrambleSessionName, scrambleTypesFor, SCRAMBLE_TYPES } from '../src/scrambleTypes.js';

describe('scramble types', () => {
  it('gives every event at least its default, ids unique within an event', () => {
    for (const e of ALL_EVENTS) {
      const types = scrambleTypesFor(e.id);
      expect(types.length, e.id).toBeGreaterThan(0);
      expect(new Set(types.map((t) => t.id)).size, e.id).toBe(types.length);
      expect(types[0].group, e.id).toBeUndefined();
      for (const t of types) {
        // lower case, apart from move notation like <R,U>
        const words = t.label.replace(/<[^>]*>/g, '');
        expect(words, `${e.id}/${t.id}`).toBe(words.toLowerCase());
        expect(t.id, `${e.id}/${t.id}`).toMatch(/^[A-Za-z0-9_]{1,32}$/);
      }
    }
    expect(Object.keys(SCRAMBLE_TYPES).sort()).toEqual(ALL_EVENTS.map((e) => e.id).sort());
  });

  it('calls the default of every WCA event "wca"', () => {
    for (const e of ALL_EVENTS.filter((x) => x.kind === 'wca')) expect(defaultScrambleType(e.id)?.label, e.id).toBe('wca');
  });

  it('tells practice scrambles from the default', () => {
    expect(isPracticeScramble('333', 'pll')).toBe(true);
    expect(isPracticeScramble('333', '333')).toBe(false);
    expect(isPracticeScramble('333', 'nope')).toBe(false);
    expect(isPracticeScramble('pyram', 'pll')).toBe(false);
    expect(isPracticeScramble('nope', 'pll')).toBe(false);
    expect(getScrambleType('222', '222eg1')?.label).toBe('eg-1');
    expect(scrambleTypesFor('nope')).toEqual([]);
  });

  it('can scramble every event (csTimer makes what cubing.js and cubr do not); only three types wait', () => {
    for (const e of ALL_EVENTS) expect(isEventReady(e.id), e.id).toBe(true);
    expect(isEventReady('nope')).toBe(false);
    const waiting = ALL_EVENTS.flatMap((e) => scrambleTypesFor(e.id).filter((t) => t.pending).map((t) => t.id));
    expect(waiting.sort()).toEqual(['mgms2l', 'pyrtop', 'skbll']);
  });

  it('names practice sessions after the event and the type, within 40 characters', () => {
    expect(scrambleSessionName('333', 'pll')).toBe('3x3 pll');
    expect(scrambleSessionName('222', '222eg1')).toBe('2x2 eg-1');
    for (const e of ALL_EVENTS) for (const t of scrambleTypesFor(e.id)) expect(scrambleSessionName(e.id, t.id).length).toBeLessThanOrEqual(40);
  });
});

describe('random-move scrambles', () => {
  it("makes csTimer's lengths in its notation", () => {
    const moves = (id: string) => randomMoveScramble(id)!.split(/\s+/);
    expect(moves('333o')).toHaveLength(25);
    expect(moves('888')).toHaveLength(120);
    expect(moves('334')).toHaveLength(40);
    expect(moves('skb')).toHaveLength(25);
    for (const m of moves('333o')) expect(m).toMatch(/^[UDRLFB]['2]?$/);
    for (const m of moves('half')) expect(m).toMatch(/^[UDRLFB]2$/);
    for (const m of moves('2gen')) expect(m).toMatch(/^[UR]['2]?$/);
    expect(randomMoveScramble('nope')).toBeNull();
  });

  it('never turns the same layer twice in a row', () => {
    for (let i = 0; i < 20; i++) {
      const m = randomMoveScramble('333o')!.split(' ').map((x) => x[0]);
      for (let j = 1; j < m.length; j++) expect(m[j]).not.toBe(m[j - 1]);
    }
  });

  it('writes megaminx-style lines for pochmann, carrot and gigaminx', () => {
    const lines = randomMoveScramble('prcp')!.split('\n');
    expect(lines).toHaveLength(7);
    for (const l of lines) expect(l).toMatch(/^([RD](\+\+|--) ){10}U'?$/);
    expect(randomMoveScramble('klmp')!.split('\n')).toHaveLength(3);
    expect(randomMoveScramble('giga')!.split('\n')).toHaveLength(30);
    for (const l of randomMoveScramble('mgmc')!.split('\n')) expect(l).toMatch(/^([+-]{2} ){5}U'?$/);
  });

  it('covers only types the registry lists', () => {
    const listed = new Set(ALL_EVENTS.flatMap((e) => scrambleTypesFor(e.id).map((t) => t.id)));
    for (const id of RANDOM_MOVE_TYPES) expect(listed.has(id), id).toBe(true);
  });
});
