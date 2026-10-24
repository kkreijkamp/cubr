import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, faviconSvg, getTheme, isLightTheme, randomTheme, THEMES } from '../themes';
import shippedFavicon from '../../../public/favicon.svg?raw';

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

describe('themes', () => {
  it('has unique snake_case names and includes the default', () => {
    const names = THEMES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9_]+$/);
    expect(names).toContain(DEFAULT_THEME);
    expect(THEMES.filter((t) => t.original).length).toBeGreaterThanOrEqual(10);
  });

  it('uses #rrggbb everywhere (charts append an alpha byte)', () => {
    for (const t of THEMES) for (const k of COLORS) expect(t[k], `${t.name}.${k}`).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps the timer readable (text vs background contrast)', () => {
    // vaporwave keeps Monkeytype's pastel text on purpose (low contrast is part of its look)
    for (const t of THEMES.filter((x) => x.name !== 'vaporwave')) expect(contrast(t.text, t.bg), t.name).toBeGreaterThanOrEqual(2.5);
    // originals are ours, so hold them to WCAG AA for large text
    for (const t of THEMES.filter((x) => x.original)) expect(contrast(t.text, t.bg), t.name).toBeGreaterThanOrEqual(4.5);
  });

  it('falls back to the default theme for unknown names', () => {
    expect(getTheme('no_such_theme').name).toBe(DEFAULT_THEME);
  });

  it('classifies light and dark themes', () => {
    expect(isLightTheme(getTheme('serika'))).toBe(true);
    expect(isLightTheme(getTheme('serika_dark'))).toBe(false);
    expect(isLightTheme(getTheme('stackmat'))).toBe(true);
  });

  it('draws the favicon in the theme colours (the default theme gives public/favicon.svg)', () => {
    expect(faviconSvg(getTheme(DEFAULT_THEME))).toBe(shippedFavicon.trim());
    const t = getTheme('8008');
    const svg = faviconSvg(t);
    expect(svg).toContain(`rx="7" fill="${t.bg}"`);
    expect(svg).toContain(`<g fill="${t.main}">`);
    expect(svg.match(/<rect x=/g)).toHaveLength(9);
    expect(svg.match(new RegExp(`fill="${t.text}"`, 'g'))).toHaveLength(1);
  });

  it('picks a different random theme of the requested kind', () => {
    for (let i = 0; i < 50; i++) {
      const t = randomTheme('serika_dark', 'light');
      expect(t.name).not.toBe('serika_dark');
      expect(isLightTheme(t)).toBe(true);
    }
  });
});
