import { describe, expect, it } from 'vitest';
import { ALL_EVENTS, scrambleTypesFor } from '@cubr/cubestats';
import { canMake, cstimerImageRequest, CSTIMER_TYPES, makeScramble, ScrambleTypeUnavailableError, type MakeDeps } from '../src/kinds.js';

// Which scramble types the service makes, and how: every listed type that isn't pending has a
// maker, and the pending ones say so. The cubing.js parts are faked here (cubing.test.ts runs them).

function fakeDeps() {
  const calls: string[] = [];
  const deps: MakeDeps = {
    generate: async (job) => {
      calls.push(job.startsWith('solve:') ? job.slice(0, 12) : job);
      return "R U R' F2 D L'";
    },
    wca: async (event) => {
      calls.push(`wca:${event}`);
      return `<${event}>`;
    },
    cstimer: async (type, length) => {
      calls.push(`cstimer:${type}:${length}`);
      return `${type} from csTimer`;
    },
  };
  return { deps, calls };
}

describe('the scramble types the service can make', () => {
  it('matches the registry: everything listed and not pending has a maker, pending ones throw', async () => {
    for (const e of ALL_EVENTS) {
      for (const t of scrambleTypesFor(e.id)) {
        const { deps } = fakeDeps();
        if (t.pending) {
          await expect(makeScramble(e.id, t.id, deps), `${e.id}/${t.id}`).rejects.toBeInstanceOf(ScrambleTypeUnavailableError);
        } else {
          expect(canMake(e.id, t.id), `${e.id}/${t.id}`).toBe(true);
          const s = await makeScramble(e.id, t.id, deps);
          expect(s.trim().length, `${e.id}/${t.id}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("takes a WCA event's default from the pool and makes its practice types with a solve", async () => {
    const a = fakeDeps();
    expect(await makeScramble('333', undefined, a.deps)).toBe('<333>');
    expect(await makeScramble('333', '333', a.deps)).toBe('<333>');
    await makeScramble('333', 'pll', a.deps);
    await makeScramble('222', '222eg1', a.deps);
    expect(a.calls).toEqual(['wca:333', 'wca:333', 'solve:3x3x3:', 'solve:2x2x2:']);
  });

  it('adds the whole-cube turn the roux and mehta types end with', async () => {
    const turns = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const s = await makeScramble('333', 'sbrx', fakeDeps().deps);
      turns.add(s.slice("R U R' F2 D L'".length).trim());
    }
    expect([...turns].sort()).toEqual(['', 'x', "x'", 'x2']);
  });

  it('builds relays and cuboids from WCA scrambles', async () => {
    const { deps } = fakeDeps();
    expect(await makeScramble('r234', undefined, deps)).toBe('2x2: <222>\n3x3: <333>\n4x4: <444>');
    expect((await makeScramble('r234567', undefined, deps)).split('\n')).toHaveLength(6);
    const mini = await makeScramble('rmngf', undefined, deps);
    expect(mini.split('\n').map((l) => l.split(':')[0])).toEqual(['2x2', '3x3', '4x4', '5x5', '3x3 oh', 'pyra', 'skewb', 'sq-1', 'clock', 'mega']);
    expect((await makeScramble('r3', undefined, deps)).split('\n')).toEqual(['1: <333>', '2: <333>', '3: <333>', '4: <333>', '5: <333>']);
    expect(await makeScramble('335', undefined, deps)).toMatch(/^[UDRLFB' 2]+ \/ <333>$/);
    expect(await makeScramble('mrbl', undefined, deps)).toBe('<333>');
  });

  it('asks cubing.js for the other puzzles it scrambles', async () => {
    const { deps, calls } = fakeDeps();
    for (const event of ['klm', 'redi', 'mpyr']) await makeScramble(event, undefined, deps);
    expect(calls).toEqual(['kilominx', 'redi_cube', 'master_tetraminx']);
  });

  it('refuses types an event does not have, and the ones newer than the csTimer scramblers cubr has', async () => {
    const { deps } = fakeDeps();
    await expect(makeScramble('333', 'nope', deps)).rejects.toBeInstanceOf(ScrambleTypeUnavailableError);
    await expect(makeScramble('pyram', 'pll', deps)).rejects.toBeInstanceOf(ScrambleTypeUnavailableError);
    for (const [event, type] of [
      ['minx', 'mgms2l'],
      ['pyram', 'pyrtop'],
      ['skewb', 'skbll'],
    ]) {
      await expect(makeScramble(event, type, deps)).rejects.toBeInstanceOf(ScrambleTypeUnavailableError);
    }
  });

  it("asks csTimer for what cubr doesn't make itself, at csTimer's own lengths", async () => {
    const { deps, calls } = fakeDeps();
    expect(await makeScramble('15p', undefined, deps)).toBe('15prp from csTimer');
    await makeScramble('15p', '15p', deps);
    await makeScramble('sq1', 'sqrcsp', deps);
    await makeScramble('heli', undefined, deps);
    expect(calls).toEqual(['cstimer:15prp:0', 'cstimer:15p:80', 'cstimer:sqrcsp:0', 'cstimer:heli:40']);
    // the 3x3 move subsets: csTimer's random state on the server (cubr's random moves only offline)
    for (const t of ['2gen', 'roux', 'half', '333drud']) expect(CSTIMER_TYPES.has(t), t).toBe(true);
    // and never what cubr makes: wca scrambles, pinned states, relays
    for (const t of ['333', 'pll', '222eg1', 'r234w', '333o', 'klmso']) expect(CSTIMER_TYPES.has(t), t).toBe(false);
  });

  it("writes relays the way csTimer's drawing wants them, and asks for any known event's type", () => {
    expect(cstimerImageRequest('r234', undefined, '2x2: R U\n3x3: F2\n4x4: Rw2 U')).toEqual({ type: 'r234w', scramble: '2) R U\n3) F2\n4) Rw2 U' });
    expect(cstimerImageRequest('rmngf', undefined, '3x3 oh: R\npyra: U\nsq-1: (1,0) /\nmega: R++ D--\nU')?.scramble).toBe(
      '3oh) R\npyr) U\nsq1) (1,0) /\nmgm) R++ D--\nU',
    );
    expect(cstimerImageRequest('r3', undefined, '1: R\n2: U')?.scramble).toBe('1) R\n2) U');
    expect(cstimerImageRequest('15p', '15p', 'R D L')).toEqual({ type: '15p', scramble: 'R D L' });
    // a puzzle cubing.js draws, for a scramble it can't read (csTimer's own notation)
    expect(cstimerImageRequest('giga', undefined, 'R++ d-- y')).toEqual({ type: 'giga', scramble: 'R++ d-- y' });
    expect(cstimerImageRequest('minx', 'mgmc', '+- ++ U')).toEqual({ type: 'mgmc', scramble: '+- ++ U' });
    expect(cstimerImageRequest('333', undefined, 'R U')).toEqual({ type: '333', scramble: 'R U' });
    expect(cstimerImageRequest('nope', undefined, 'R')).toBeNull();
    expect(cstimerImageRequest('333', 'nope', 'R')).toBeNull();
  });
});
