// Writes web/src/lib/__tests__/fixtures/cstimer/preview3d.json, what the web tests check the 3D
// previews' translations (web/src/lib/cubing3d.ts) against: for each scramble type translated there,
// the solved puzzle and three scrambles made as the scramble service makes them, each with the
// colours of csTimer's own drawing of it, sticker by sticker (as indexes into the type's palette).
// Run it again after upgrading cstimer_module:
//
//   npx tsx scripts/cstimer-fixtures.ts
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ALL_EVENTS, scrambleTypesFor } from '@cubr/cubestats';
import { makeScramble } from '../services/scramble/src/kinds.js';
import { PREVIEW_3D_TYPES } from '../web/src/lib/cubing3d.js';
import { parseDrawing } from '../web/src/lib/drawnNet.js';

const cs = createRequire(import.meta.url)('cstimer_module') as {
  getScramble(type: string, length: number): string;
  getImage(scramble: string, type: string): string | false;
};
const OUT = new URL('../web/src/lib/__tests__/fixtures/cstimer/preview3d.json', import.meta.url);
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const none = () => Promise.reject(new Error('not a csTimer or random-move type'));
const deps = { generate: none, wca: none, cstimer: async (type: string, length: number) => String(cs.getScramble(type, length)) };

const out: Record<string, { event: string; palette: string[]; drawings: [scramble: string, colours: string][] }> = {};
for (const type of PREVIEW_3D_TYPES) {
  const event = ALL_EVENTS.find((e) => scrambleTypesFor(e.id).some((t) => t.id === type))?.id;
  if (!event) throw new Error(`no event has scramble type ${type}`);
  const palette: string[] = [];
  const drawings: [string, string][] = [];
  for (let i = 0; i < 4; i++) {
    const scramble = i === 0 ? '' : await makeScramble(event, type, deps);
    const svg = cs.getImage(scramble, type);
    if (!svg) throw new Error(`csTimer drew no ${type}`);
    const colours = parseDrawing(svg).shapes.map((s) => {
      const k = palette.includes(s.fill) ? palette.indexOf(s.fill) : palette.push(s.fill) - 1;
      return DIGITS[k];
    });
    drawings.push([scramble, colours.join('')]);
  }
  out[type] = { event, palette, drawings };
}
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${Object.keys(out).length} types to ${OUT.pathname}`);
