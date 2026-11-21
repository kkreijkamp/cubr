import { describe, expect, it } from 'vitest';
import { DEFAULT_DARK_THEME, DEFAULT_THEME, faviconSvg, getTheme, isLightTheme, randomTheme, READY_GREEN, readyColor, themeColors, THEMES } from '../themes';
import shippedFavicon from '../../../public/favicon.svg?raw';
import globalCss from '../../styles/global.css?raw';
import indexHtml from '../../../index.html?raw';

const COLORS = ['bg', 'main', 'caret', 'sub', 'subAlt', 'text', 'error', 'errorExtra', 'colorfulError', 'colorfulErrorExtra'] as const;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** OKLab, a space where distance follows how different two colours look */
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const apart = (a: string, b: string) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]));

describe('themes', () => {
  it('has unique snake_case names and includes the default', () => {
    const names = THEMES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9_]+$/);
    expect(names).toContain(DEFAULT_THEME);
    expect(names).toHaveLength(42);
  });

  it('lists the light themes first, white cross leading, then the dark ones, white cross dark leading', () => {
    const light = THEMES.filter(isLightTheme);
    expect(THEMES.slice(0, light.length)).toEqual(light);
    expect(THEMES[0].name).toBe(DEFAULT_THEME);
    expect(THEMES[light.length].name).toBe(DEFAULT_DARK_THEME);
    // a real choice for each of the device's modes
    expect(light.length).toBeGreaterThanOrEqual(15);
    expect(THEMES.length - light.length).toBeGreaterThanOrEqual(15);
  });

  it('defaults to white cross: pure white, a vivid green that stays readable on it', () => {
    const t = getTheme(DEFAULT_THEME);
    expect(t.name).toBe('white_cross');
    expect(t.bg).toBe('#ffffff');
    expect(contrast(t.main, t.bg)).toBeGreaterThanOrEqual(3);
  });

  it('uses #rrggbb everywhere (charts append an alpha byte)', () => {
    for (const t of THEMES) for (const k of COLORS) expect(t[k], `${t.name}.${k}`).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps the timer readable (text vs background contrast)', () => {
    // WCAG AAA for normal text: the time, and every number beside it
    for (const t of THEMES) expect(contrast(t.text, t.bg), t.name).toBeGreaterThanOrEqual(7);
  });

  it('keeps the accent, the labels, the errors and the cards readable', () => {
    for (const t of THEMES) {
      // the running time, links and buttons (WCAG's 3:1 for large text and controls)
      expect(contrast(t.main, t.bg), `${t.name} main`).toBeGreaterThanOrEqual(3);
      // a dnf, the holding timer and error messages
      expect(contrast(t.error, t.bg), `${t.name} error`).toBeGreaterThanOrEqual(4);
      // labels stay quieter than the text but legible (raising them to WCAG AA is an open decision)
      expect(contrast(t.sub, t.bg), `${t.name} sub`).toBeGreaterThanOrEqual(2);
      expect(contrast(t.text, t.bg), `${t.name} text over sub`).toBeGreaterThan(contrast(t.sub, t.bg));
      // cards one step off the background: visible, never loud
      expect(contrast(t.subAlt, t.bg), `${t.name} subAlt`).toBeGreaterThanOrEqual(1.04);
      expect(contrast(t.subAlt, t.bg), `${t.name} subAlt`).toBeLessThanOrEqual(1.4);
    }
  });

  it('keeps a dnf apart from a pb: the error colour never looks like the accent', () => {
    for (const t of THEMES) expect(apart(t.error, t.main), t.name).toBeGreaterThanOrEqual(0.1);
  });

  it('gives every theme its own look (background and accent)', () => {
    for (const [i, a] of THEMES.entries())
      for (const b of THEMES.slice(i + 1)) {
        const distance = apart(a.bg, b.bg) + apart(a.main, b.main) + 0.3 * apart(a.text, b.text);
        expect(distance, `${a.name} ~ ${b.name}`).toBeGreaterThanOrEqual(0.1);
      }
  });

  it("makes the timer's ready green readable on every background, as is wherever it reads", () => {
    // the stylesheet's default: white cross and white cross dark keep #3ec46d
    expect(readyColor(getTheme(DEFAULT_THEME))).toBe(READY_GREEN);
    expect(readyColor(getTheme(DEFAULT_DARK_THEME))).toBe(READY_GREEN);
    expect(readyColor(getTheme('stackmat'))).not.toBe(READY_GREEN); // #3ec46d was nearly invisible on its olive
    for (const t of THEMES) {
      const ready = readyColor(t);
      expect(ready, t.name).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(ready, t.bg), t.name).toBeGreaterThanOrEqual(ready === READY_GREEN ? 2 : 3);
      // still green: the green channel leads
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(ready.slice(i, i + 2), 16));
      expect(g, t.name).toBeGreaterThan(r);
      expect(g, t.name).toBeGreaterThan(b);
    }
  });

  it('falls back to the default theme for unknown names', () => {
    expect(getTheme('no_such_theme').name).toBe(DEFAULT_THEME);
  });

  it('classifies light and dark themes', () => {
    expect(isLightTheme(getTheme('white_cross'))).toBe(true);
    expect(isLightTheme(getTheme('stickerless'))).toBe(false);
    expect(isLightTheme(getTheme('stackmat'))).toBe(true);
  });

  it('draws the favicon in the theme colours (the default themes give public/favicon.svg)', () => {
    // the shipped icon: white cross, and white cross dark while the browser is in dark mode
    expect(faviconSvg(getTheme(DEFAULT_THEME), getTheme(DEFAULT_DARK_THEME))).toBe(shippedFavicon.trim());
    const dark = getTheme(DEFAULT_DARK_THEME);
    expect(shippedFavicon).toContain(`<style>@media (prefers-color-scheme:dark){.b{fill:${dark.bg}}.m{fill:${dark.main}}.c{fill:${dark.text}}}</style>`);
    expect(faviconSvg(getTheme(DEFAULT_THEME))).not.toContain('<style>'); // the app's own icon is the theme in use
    const t = getTheme('pll_skip');
    const svg = faviconSvg(t);
    expect(svg).toContain(`<rect width="32" height="32" rx="5" fill="${t.bg}"/>`); // the theme's background fills the icon
    expect(svg).toContain(`<g fill="${t.main}">`);
    expect(svg.match(/<rect x=/g)).toHaveLength(9);
    expect(svg.match(new RegExp(`fill="${t.text}"`, 'g'))).toHaveLength(1);
  });

  it('has white cross dark: white cross with ink and white swapped, the same green, readable labels and errors', () => {
    const light = getTheme(DEFAULT_THEME);
    const dark = getTheme(DEFAULT_DARK_THEME);
    expect(dark.name).toBe('white_cross_dark');
    expect(isLightTheme(dark)).toBe(false);
    expect(dark.bg).toBe(light.text); // the logo's ink
    expect(dark.main).toBe(light.main);
    // WCAG AA for text: the green links, the grey labels and the errors on the ink background
    for (const k of ['main', 'sub', 'error', 'text'] as const) expect(contrast(dark[k], dark.bg), k).toBeGreaterThanOrEqual(4.5);
    // cards sit one step off the background, as in white cross
    expect(contrast(dark.subAlt, dark.bg)).toBeCloseTo(contrast(light.subAlt, light.bg), 1);
  });

  it("gives each theme's colours with the color-scheme the browser should draw its own parts in", () => {
    expect(themeColors(getTheme('white_cross'))).toMatchObject({ '--bg-color': '#ffffff', '--main-color': '#00a04d', 'color-scheme': 'light' });
    expect(themeColors(getTheme('white_cross_dark'))).toMatchObject({ '--bg-color': '#1d2024', 'color-scheme': 'dark' });
    expect(themeColors(getTheme('stackmat'))['color-scheme']).toBe('light'); // a mid-tone background with dark text
    expect(themeColors(getTheme('stackmat'))['--timer-ready']).toBe(readyColor(getTheme('stackmat')));
    // the ten colours, the ready green and the color-scheme
    for (const t of THEMES) expect(Object.keys(themeColors(t))).toHaveLength(COLORS.length + 2);
  });

  it('starts the page in white cross, or white cross dark in dark mode, before the app runs', () => {
    const vars = (block: string) => Object.fromEntries([...block.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
    const root = /^:root \{([\s\S]*?)\n\}/m.exec(globalCss)![1];
    const darkRoot = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\}/.exec(globalCss)![1];
    const expected = (name: string) => Object.fromEntries(Object.entries(themeColors(getTheme(name))).filter(([k]) => k.startsWith('--')));
    expect(vars(root)).toMatchObject(expected('white_cross'));
    expect(root).toContain('color-scheme: light;');
    expect(vars(darkRoot)).toEqual(expected('white_cross_dark'));
    expect(darkRoot).toContain('color-scheme: dark;');
    // the browser's colours around the page, and its own parts, before the first paint
    expect(indexHtml).toContain('<meta name="color-scheme" content="light dark" />');
    expect(indexHtml).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${getTheme('white_cross').bg}" />`);
    expect(indexHtml).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${getTheme('white_cross_dark').bg}" />`);
  });

  it('picks a different random theme of the requested kind', () => {
    for (let i = 0; i < 50; i++) {
      const t = randomTheme('white_cross', 'light');
      expect(t.name).not.toBe('white_cross');
      expect(isLightTheme(t)).toBe(true);
    }
  });
});

describe("index.html's pre-paint script", () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)![1];

  /** Runs the script on a fake page: what it saved, the device's mode; returns the styles and theme colours it set. */
  function prePaint(saved: unknown, dark: boolean) {
    const style = new Map<string, string>();
    const metas = [new Map<string, string>(), new Map<string, string>()];
    const document = {
      documentElement: { style: { setProperty: (k: string, v: string) => void style.set(k, v) } },
      querySelectorAll: (sel: string) => (sel === 'meta[name="theme-color"]' ? metas.map((m) => ({ setAttribute: (k: string, v: string) => void m.set(k, v) })) : []),
    };
    const localStorage = { getItem: (k: string) => (k === 'cubr.themeColors' && saved !== undefined ? (typeof saved === 'string' ? saved : JSON.stringify(saved)) : null) };
    const matchMedia = (q: string) => ({ matches: q === '(prefers-color-scheme: dark)' && dark });
    new Function('document', 'localStorage', 'matchMedia', script)(document, localStorage, matchMedia);
    return { style, themeColors: metas.map((m) => m.get('content')) };
  }

  const light = themeColors(getTheme('white_cross'));
  const dark = themeColors(getTheme('white_cross_dark'));

  it('applies the one saved set of colours in either mode', () => {
    const dnf = themeColors(getTheme('dnf'));
    for (const mode of [false, true]) {
      const { style, themeColors: tc } = prePaint(dnf, mode);
      expect(Object.fromEntries(style)).toEqual(dnf);
      expect(tc).toEqual([dnf['--bg-color'], dnf['--bg-color']]);
    }
  });

  it("applies the light or the dark set by the device's mode while the theme follows it", () => {
    expect(Object.fromEntries(prePaint({ light, dark }, false).style)).toEqual(light);
    expect(Object.fromEntries(prePaint({ light, dark }, true).style)).toEqual(dark);
    expect(prePaint({ light, dark }, true).themeColors).toEqual([dark['--bg-color'], dark['--bg-color']]);
  });

  it("leaves the stylesheet's defaults (and the browser's colours) when nothing usable is saved", () => {
    for (const saved of [undefined, 'not json', 'null']) {
      const { style, themeColors: tc } = prePaint(saved, true);
      expect(style.size).toBe(0);
      expect(tc).toEqual([undefined, undefined]);
    }
  });
});
