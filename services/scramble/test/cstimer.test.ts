import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCsTimerHost } from '../src/cstimer.js';
import { CSTIMER_LENGTHS, CSTIMER_TYPES } from '../src/kinds.js';

// csTimer's real scramblers (cstimer_module) in their worker thread.
describe("csTimer's scramblers", () => {
  const host = createCsTimerHost({ timeoutMs: 30_000, maxQueue: 100 });
  afterAll(() => host.close());

  it('has every type cubr asks it for', () => {
    const cs = createRequire(import.meta.url)('cstimer_module') as { getScrambleTypes(): string[] };
    const known = new Set(cs.getScrambleTypes());
    for (const t of CSTIMER_TYPES) expect(known.has(t), t).toBe(true);
    expect(CSTIMER_TYPES.size).toBeGreaterThan(80);
  });

  it('makes a scramble of every one of them', async () => {
    for (const t of CSTIMER_TYPES) {
      const s = await host.scramble(t, CSTIMER_LENGTHS[t] ?? 0);
      expect(s.length, t).toBeGreaterThan(2);
      expect(s, t).not.toMatch(/undefined|NaN|N\/A/);
    }
    expect(host.stats()).toMatchObject({ failed: 0, timeouts: 0 });
  }, 120_000);

  it('makes the move subsets in their own moves only', async () => {
    for (let i = 0; i < 5; i++) {
      for (const m of (await host.scramble('2gen', 0)).split(' ')) expect(m).toMatch(/^[RU]['2]?$/);
      for (const m of (await host.scramble('roux', 0)).split(' ')) expect(m).toMatch(/^[MU]['2]?$/);
    }
  }, 60_000);

  it("draws the puzzles cubr can't, and says so when it can't either", async () => {
    for (const [type, scramble] of [
      ['15prp', await host.scramble('15prp', 0)],
      ['gearso', await host.scramble('gearso', 0)],
      ['r234w', '2) R U R\\n3) R U F\\n4) Rw2 U'],
      ['888', await host.scramble('888', 120)],
    ]) {
      expect((await host.image(type, scramble))?.startsWith('<svg'), type).toBe(true);
    }
    expect(await host.image('334', 'R2 U')).toBeNull();
  }, 60_000);
});

describe('the csTimer worker thread', () => {
  it('kills and replaces a scrambler that runs away, failing only what was waiting on it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cubr-cstimer-'));
    const path = join(dir, 'stuck.cjs');
    writeFileSync(path, "module.exports = { getScramble: (t) => { if (t === 'stuck') for (;;); return t + ' ok'; }, getImage: () => null };\n");
    const host = createCsTimerHost({ timeoutMs: 300, maxQueue: 2, path });
    try {
      await expect(host.scramble('stuck', 0)).rejects.toThrow(/timed out/);
      expect(await host.scramble('fine', 0)).toBe('fine ok'); // a fresh thread
      expect(host.stats()).toMatchObject({ timeouts: 1, restarts: 1 });
      const many = [host.scramble('a', 0), host.scramble('b', 0), host.scramble('c', 0)];
      const settled = await Promise.allSettled(many);
      expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']); // queue of 2
    } finally {
      await host.close();
    }
  }, 30_000);
});

describe("the version of csTimer's scramblers", () => {
  it('is pinned, the same in the package and in the image', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(pkg.dependencies.cstimer_module).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toContain(`ARG CSTIMER_VERSION=${pkg.dependencies.cstimer_module}`);
    expect(dockerfile).toMatch(/--ignore-scripts cubing@\$\{CUBING_VERSION\} cstimer_module@\$\{CSTIMER_VERSION\}/);
  });
});
