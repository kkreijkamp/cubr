import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInProcessBackend } from '../src/backends.js';
import { ScrambleGenerator } from '../src/generator.js';

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
      // random-state 3x3x3 scrambles are usually 18–21 moves (rarely 17 or fewer)
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

  it('rejects events cubing.js does not know', async () => {
    await expect(gen.generate('bogus')).rejects.toThrow();
  }, 60_000);
});
