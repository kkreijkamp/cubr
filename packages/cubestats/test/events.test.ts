import { describe, expect, it } from 'vitest';
import { DAILY_EVENTS, defaultSessionName, EVENT_IDS, EVENTS, getEvent, isEventId, practiceSessionName } from '../src/events.js';

// the puzzle ids <twisty-player> understands for these events
const TWISTY_PUZZLES = ['2x2x2', '3x3x3', '4x4x4', '5x5x5', '6x6x6', '7x7x7', 'clock', 'megaminx', 'pyraminx', 'skewb', 'square1'];

describe('events', () => {
  it('lists the 16 current WCA events (no multi-blind, no feet) with unique ids', () => {
    expect(EVENT_IDS).toEqual(EVENTS.map((e) => e.id));
    expect(new Set(EVENT_IDS).size).toBe(16);
    expect(EVENT_IDS).not.toContain('333mbf');
    expect(EVENT_IDS).not.toContain('333ft');
    for (const e of EVENTS) expect(TWISTY_PUZZLES).toContain(e.puzzle);
  });

  it('looks events up by id only', () => {
    expect(getEvent('pyram')?.name).toBe('Pyraminx');
    expect(getEvent('Pyraminx')).toBeUndefined();
    expect(isEventId('sq1')).toBe(true);
    for (const id of ['', '333mbf', 'SQ1', 'toString', '__proto__']) expect(isEventId(id)).toBe(false);
  });

  it('uses no inspection for blindfolded events and FMC, and counts FMC in moves', () => {
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
    const names = EVENT_IDS.flatMap((id) => [defaultSessionName(id), practiceSessionName(id)]);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(40);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it('offers the daily challenge only for known events', () => {
    for (const id of DAILY_EVENTS) expect(isEventId(id)).toBe(true);
    expect(new Set(DAILY_EVENTS).size).toBe(DAILY_EVENTS.length);
  });
});
