import { describe, expect, it } from 'vitest';
import { ALL_EVENT_IDS, ALL_EVENTS, RELAY_EVENTS, RELAY_PARTS, DAILY_EVENTS, defaultSessionName, EVENT_IDS, EVENTS, getEvent, isEventId, isWcaEvent, OTHER_EVENTS, practiceSessionName, splitRelay } from '../src/events.js';

// the puzzle ids <twisty-player> understands for these events
const TWISTY_PUZZLES = ['2x2x2', '3x3x3', '4x4x4', '5x5x5', '6x6x6', '7x7x7', 'clock', 'megaminx', 'pyraminx', 'skewb', 'square1', 'fto', 'kilominx', 'gigaminx', 'master_tetraminx', 'redi_cube'];

describe('events', () => {
  it('lists the 17 WCA events (FTO from 2027; no multi-blind, no feet) with unique ids', () => {
    expect(EVENT_IDS).toEqual(EVENTS.map((e) => e.id));
    expect(new Set(EVENT_IDS).size).toBe(17);
    expect(EVENT_IDS.at(-1)).toBe('fto');
    expect(EVENT_IDS).not.toContain('333mbf');
    expect(EVENT_IDS).not.toContain('333ft');
    for (const e of EVENTS) {
      expect(e.kind).toBe('wca');
      expect(TWISTY_PUZZLES).toContain(e.puzzle);
    }
  });

  it("lists csTimer's other puzzles after them, every id unique, with the relays split", () => {
    expect(ALL_EVENT_IDS).toEqual([...EVENT_IDS, ...OTHER_EVENTS.map((e) => e.id)]);
    expect(new Set(ALL_EVENT_IDS).size).toBe(ALL_EVENTS.length);
    expect(OTHER_EVENTS.length).toBe(45);
    expect(OTHER_EVENTS.slice(0, 6).map((e) => e.short)).toEqual(['2-4 relay', '2-5 relay', '2-6 relay', '2-7 relay', 'Mini Guildford', '3x3 relay']);
    for (const e of OTHER_EVENTS) {
      expect(e.kind, e.id).toBe('other');
      expect(isWcaEvent(e.id), e.id).toBe(false);
      expect(isEventId(e.id), e.id).toBe(true);
      if (e.puzzle !== null) expect(TWISTY_PUZZLES).toContain(e.puzzle);
    }
    expect(isWcaEvent('333')).toBe(true);
    expect(isWcaEvent('fto')).toBe(true);
  });

  it('looks events up by id only', () => {
    expect(getEvent('pyram')?.name).toBe('Pyraminx');
    expect(getEvent('Pyraminx')).toBeUndefined();
    expect(isEventId('sq1')).toBe(true);
    for (const id of ['', '333mbf', 'SQ1', 'toString', '__proto__']) expect(isEventId(id)).toBe(false);
  });

  it('uses no inspection for blindfolded events, FMC and relays, and counts FMC in moves', () => {
    for (const e of OTHER_EVENTS) expect(e.inspection, e.id).toBe(!RELAY_EVENTS.includes(e.id));
    for (const e of EVENTS) {
      const blind = e.id.endsWith('bf');
      expect(e.blind, e.id).toBe(blind);
      expect(e.inspection, e.id).toBe(!blind && e.id !== '333fm');
      expect(e.unit, e.id).toBe(e.id === '333fm' ? 'moves' : 'time');
    }
  });

  it.each([
    ['333', '3x3', '3x3 practice'],
    ['333oh', '3x3 OH', '3x3 OH practice'],
    ['333bf', '3BLD', '3BLD practice'],
    ['minx', 'Mega', 'Mega practice'],
    ['sq1', 'SQ-1', 'SQ-1 practice'],
    ['nope', 'nope', 'nope practice'],
  ])('%s sessions are called %j and %j', (id, name, practice) => {
    expect(defaultSessionName(id)).toBe(name);
    expect(practiceSessionName(id)).toBe(practice);
  });

  it('keeps every default and practice session name within the 40-character limit, all different', () => {
    const names = ALL_EVENT_IDS.flatMap((id) => [defaultSessionName(id), practiceSessionName(id)]);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(40);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it("lists each relay's puzzles as WCA events, labelled as its scramble lines are", () => {
    expect(RELAY_EVENTS).toEqual(['r234', 'r2345', 'r23456', 'r234567', 'rmngf', 'r3']);
    for (const id of RELAY_EVENTS) {
      expect(getEvent(id)?.puzzle, id).toBeNull();
      const labels = RELAY_PARTS[id].map(([label]) => label);
      expect(new Set(labels).size, id).toBe(labels.length);
      for (const [label, ev] of RELAY_PARTS[id]) {
        expect(isWcaEvent(ev), `${id} ${ev}`).toBe(true);
        expect(label, id).not.toMatch(/[:\n]/);
      }
    }
    expect(RELAY_PARTS.rmngf.map(([, ev]) => ev)).toEqual(['222', '333', '444', '555', '333oh', 'pyram', 'skewb', 'sq1', 'clock', 'minx']);
  });

  it("splits a relay's scramble into its puzzles', a megaminx's lines kept together", () => {
    expect(splitRelay('r234', "2x2: R U F'\n3x3: D2 L\n4x4: Rw2 U")).toEqual([
      { label: '2x2', event: '222', scramble: "R U F'" },
      { label: '3x3', event: '333', scramble: 'D2 L' },
      { label: '4x4', event: '444', scramble: 'Rw2 U' },
    ]);
    const mini = splitRelay('rmngf', 'clock: UR3+ DR2- ALL1+ y2\nmega: R++ D-- U\nR-- D++ U\'\nR++ D++ U');
    expect(mini?.map((p) => p.label)).toEqual(['clock', 'mega']);
    expect(mini?.[1].scramble).toBe("R++ D-- U\nR-- D++ U'\nR++ D++ U");
    expect(splitRelay('r3', '1: R\n2: U')?.map((p) => [p.label, p.event])).toEqual([
      ['1', '333'],
      ['2', '333'],
    ]);
    // not a relay, or not a relay's scramble
    expect(splitRelay('333', '2x2: R U')).toBeNull();
    expect(splitRelay('r234', "R U R' U'")).toBeNull();
    expect(splitRelay('r234', '')).toBeNull();
  });

  it('offers the daily challenge only for known events', () => {
    for (const id of DAILY_EVENTS) expect(isEventId(id)).toBe(true);
    expect(new Set(DAILY_EVENTS).size).toBe(DAILY_EVENTS.length);
  });
});
