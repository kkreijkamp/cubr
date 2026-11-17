import { describe, expect, it } from 'vitest';
import sprite from '../assets/country-flags.png?inline';
import { FLAG_SLOTS, flagSlot } from '../components/Flag';
import { COUNTRIES } from '../components/social/countries';

/** a PNG's width and height, from its IHDR chunk */
function size(dataUrl: string): [number, number] {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (ch) => ch.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return [view.getUint32(16), view.getUint32(20)];
}

describe('country flags', () => {
  it('has a 44 x 30 px slot in the sprite for every code, and the placeholder', () => {
    expect(size(sprite)).toEqual([44, FLAG_SLOTS * 30]);
  });

  it("finds each code's slot (alphabetical from 1, the sprite's own order), GB as its uk", () => {
    expect(flagSlot('ad')).toBe(1);
    // the sprite's stylesheet put au at 5.785124% of 242 slot-heights: slot 14
    expect(flagSlot('AU')).toBe(14);
    expect(flagSlot('zw')).toBe(FLAG_SLOTS - 1);
    expect(flagSlot('GB')).toBe(flagSlot('uk'));
    expect(flagSlot('gb')).toBeDefined();
    for (const bad of [null, undefined, '', 'A', 'AUS', '1a']) expect(flagSlot(bad)).toBeUndefined();
  });

  it('has a flag for every country in the list but a known few, which keep their emoji', () => {
    const missing = COUNTRIES.filter((c) => flagSlot(c.code) === undefined).map((c) => c.code);
    expect(missing.sort()).toEqual(['AX', 'BL', 'BQ', 'CW', 'GG', 'IM', 'JE', 'MF', 'PS', 'SX', 'XK', 'YT']);
  });
});
