import { describe, expect, it } from 'vitest';
import { OTHER_EVENTS, scrambleTypesFor } from '@cubr/cubestats';
import barSource from '../ConfigBar.tsx?raw';
import pageSource from '../../../pages/TimerPage.tsx?raw';

// The timer bar's event and scramble menus (no DOM in these tests: what the source wires up).

describe('the timer bar', () => {
  it('puts the scramble menu between the event and the session', () => {
    const at = (s: string) => barSource.indexOf(s);
    expect(at('<EventMenu ')).toBeGreaterThan(0);
    expect(at('<ScrambleMenu ')).toBeGreaterThan(at('<EventMenu '));
    expect(at('<SessionMenu')).toBeGreaterThan(at('<ScrambleMenu '));
  });

  it('says only the default scramble counts, on the bar and in the menu', () => {
    expect(barSource).toContain('practice scrambles: no pbs or leaderboards');
    expect(barSource).toContain("'counts for pbs and leaderboards'");
    expect(barSource).toContain('practice scramble: no pbs or leaderboards');
    expect(barSource).toMatch(/practice \? <BeakerIcon/);
  });

  it('lists the other events under the WCA ones, the ones without scrambles yet marked "soon"', () => {
    expect(barSource).toContain('other events');
    expect(barSource).toMatch(/OTHER_EVENTS\.map\(/);
    expect(barSource).toMatch(/soon=\{!isEventReady\(e\.id\)\}/);
    expect(OTHER_EVENTS.length).toBeGreaterThan(40);
  });

  it('shows each session list for its own scramble type, and switches with the queue', () => {
    expect(barSource).toMatch(/s\.event === p\.event && \(s\.scramble \?\? null\) === scramble/);
    expect(pageSource).toContain('useScrambleQueue(event, scrambleType)');
    expect(pageSource).toContain('onScramble={changeScramble}');
    expect(pageSource).toMatch(/createSession\(name, event, scrambleType \? \{ scramble: scrambleType \} : \{\}\)/);
  });

  it('offers practice types for the main events', () => {
    expect(scrambleTypesFor('333').length).toBeGreaterThan(30);
    expect(scrambleTypesFor('222').map((t) => t.label)).toContain('eg-1');
  });
});
