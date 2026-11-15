// Colours for drawing a virtual puzzle: the sticker scheme (with your own colours, settings: sticker
// colours) and a dark plastic that sits with the theme.
import { SCHEMES } from '../../lib/scrambleNet';
import type { Settings } from '../../lib/settings';
import type { ClockColors } from './renderClock';
import type { Palette } from './render3d';

const HEX = /^#[0-9a-f]{6}$/i;

export function stickerColors(scheme: 'cube' | 'skewb' | 'pyraminx' | 'megaminx' | 'square1', s: Pick<Settings, 'stickerColours' | 'customStickers'>): string[] {
  const sc = SCHEMES.find((x) => x.id === scheme)!;
  const own = s.stickerColours === 'custom' ? s.customStickers[sc.id] : undefined;
  return sc.faces.map((f, i) => {
    const c = own?.[i];
    return typeof c === 'string' && HEX.test(c) ? c : f.colour;
  });
}

function rgb(css: string): [number, number, number] | null {
  const c = css.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16)) as [number, number, number];
  m = /^#([0-9a-f]{6})/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as [number, number, number];
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

const hex = (v: [number, number, number]) => '#' + v.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');

/** a theme colour (a CSS variable on the page) */
export function themeColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return rgb(v) ? hex(rgb(v)!) : fallback;
}

/** the plastic: the page background, three quarters of the way to black (as the scramble preview's face plates) */
export function bodyColor(): string {
  const bg = rgb(themeColor('--bg-color', '#222222')) ?? [34, 34, 34];
  return hex([bg[0] * 0.25, bg[1] * 0.25, bg[2] * 0.25]);
}

export function puzzlePalette(scheme: 'cube' | 'skewb' | 'pyraminx' | 'megaminx' | 'square1', s: Pick<Settings, 'stickerColours' | 'customStickers'>): Palette {
  return { faces: stickerColors(scheme, s), body: bodyColor(), hidden: '#7f7f7f' };
}

export function clockColors(): ClockColors {
  return {
    faces: ['#24508c', '#8eb0dc'],
    dial: '#f1f1f1',
    hand: '#d4313b',
    handDone: '#2b9a48',
    pinUp: themeColor('--main-color', '#ffd500'),
    pinDown: '#3a3a3a',
  };
}
