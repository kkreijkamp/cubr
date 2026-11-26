import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { puzzles } from 'cubing/puzzles';
import { KTransformation } from 'cubing/kpuzzle';
import { createInProcessBackend, transformationData } from '../src/backends.js';
import { ScrambleGenerator } from '../src/generator.js';
import { crossMoves, encodeSolveJob, practiceJob, PRACTICE_STATE_TYPES } from '../src/practice.js';

// Real cubing.js searches (333 and pyram are fast once their tables exist).
describe('cubing.js scrambles', () => {
  let gen: ScrambleGenerator;

  beforeAll(async () => {
    gen = new ScrambleGenerator(await createInProcessBackend(), { timeoutMs: 30_000, maxQueue: 100 });
  });
  afterAll(() => gen?.close());

  it('generates WCA random-state 3x3x3 scrambles', async () => {
    const scrambles = await gen.generateMany('333', 10);
    for (const s of scrambles) {
      const moves = s.split(' ');
      // random-state 3x3x3 scrambles are usually 18-21 moves (rarely 17 or fewer)
      expect(moves.length).toBeGreaterThanOrEqual(15);
      expect(moves.length).toBeLessThanOrEqual(25);
      for (const m of moves) expect(m).toMatch(/^[UDLRFB]['2]?$/);
    }
    expect(new Set(scrambles).size).toBe(scrambles.length);
  }, 60_000);

  it('generates pyraminx scrambles (face moves + optional tips)', async () => {
    const s = await gen.generate('pyram');
    const moves = s.split(' ');
    expect(moves.length).toBeGreaterThanOrEqual(8);
    expect(moves.length).toBeLessThanOrEqual(16);
    for (const m of moves) expect(m).toMatch(/^[ULRBulrb]'?$/);
    // tips (lower case) only ever come after the face moves
    expect(s).toMatch(/^[ULRB' ]+( [ulrb]'?)*$/);
  }, 60_000);

  it('scrambles FTO', async () => {
    for (const event of ['fto']) {
      const s = await gen.generate(event);
      expect(s.split(/\s+/).length, event).toBeGreaterThan(5);
    }
  }, 120_000);

  // last: cubing.js hands this rejection to whichever search comes next
  it('rejects events cubing.js does not know', async () => {
    await expect(gen.generate('bogus')).rejects.toThrow();
  }, 60_000);
});

// Practice scrambles: cubing.js solves the pinned state; the scramble must land exactly on it
// (centres' twist aside: the solver ignores it, and a cube can't show it).
describe('practice scrambles (real cubing.js solves)', () => {
  let gen: ScrambleGenerator;

  beforeAll(async () => {
    gen = new ScrambleGenerator(await createInProcessBackend(), { timeoutMs: 60_000, maxQueue: 100 });
  });
  afterAll(() => gen?.close());

  type Pattern = { patternData: Record<string, { pieces: number[]; orientation: number[] }> };
  const sameState = (a: Pattern, b: Pattern) =>
    Object.keys(a.patternData).every((orbit) => {
      const x = a.patternData[orbit];
      const y = b.patternData[orbit];
      const pieces = x.pieces.every((p, i) => p === y.pieces[i]);
      return orbit === 'CENTERS' ? pieces : pieces && x.orientation.every((o, i) => o === y.orientation[i]);
    });

  it('lands every practice type on its state, in plain face turns', async () => {
    for (const type of PRACTICE_STATE_TYPES) {
      const job = practiceJob(type)!;
      const scramble = await gen.generate(encodeSolveJob(job.puzzle, job.state));
      expect(scramble, type).not.toMatch(/2'/);
      for (const m of scramble.split(' ')) expect(m, `${type}: ${scramble}`).toMatch(/^[UDLRFB]['2]?$/);
      const k = await puzzles[job.puzzle].kpuzzle();
      let target = k.defaultPattern();
      if (job.state.pre) target = target.applyAlg(job.state.pre);
      target = target.applyTransformation(new KTransformation(k, transformationData(k as never, job.state)));
      if (job.state.post) target = target.applyAlg(job.state.post);
      expect(sameState(k.defaultPattern().applyAlg(scramble) as unknown as Pattern, target as unknown as Pattern), `${type}: ${scramble}`).toBe(true);
    }
  }, 120_000);

  it('gives easy crosses that really are easy', async () => {
    for (let i = 0; i < 5; i++) {
      const job = practiceJob('easyc')!;
      const scramble = await gen.generate(encodeSolveJob(job.puzzle, job.state));
      const k = await puzzles['3x3x3'].kpuzzle();
      const edges = (k.defaultPattern().applyAlg(scramble) as unknown as Pattern).patternData.EDGES;
      expect(crossMoves(edges)).toBeLessThanOrEqual(3);
    }
  }, 60_000);
});
