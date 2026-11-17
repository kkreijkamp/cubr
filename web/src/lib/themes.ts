// Themes: cube-inspired cubr originals, as #rrggbb so charts can append an alpha byte.
export interface Theme {
  name: string;
  bg: string;
  main: string;
  caret: string;
  sub: string;
  subAlt: string;
  text: string;
  error: string;
  errorExtra: string;
  colorfulError: string;
  colorfulErrorExtra: string;
}

export const THEMES: Theme[] = [
  {"name":"stickerless","bg":"#161616","main":"#ffd500","caret":"#ffd500","sub":"#6b6b6b","subAlt":"#202020","text":"#f1f1f1","error":"#e8263c","errorExtra":"#9c1426","colorfulError":"#ff6a13","colorfulErrorExtra":"#b34507"},
  {"name":"white_cross","bg":"#ffffff","main":"#00a04d","caret":"#0046ad","sub":"#959aa1","subAlt":"#e5e8eb","text":"#1d2024","error":"#d0252f","errorExtra":"#8f1920","colorfulError":"#ff6a13","colorfulErrorExtra":"#b34507"},
  {"name":"white_cross_dark","bg":"#1d2024","main":"#00a04d","caret":"#3d7ff5","sub":"#868c94","subAlt":"#2c3036","text":"#f1f3f5","error":"#ff5c63","errorExtra":"#b3323a","colorfulError":"#ff6a13","colorfulErrorExtra":"#b34507"},
  {"name":"stackmat","bg":"#a3ad94","main":"#2b3a1f","caret":"#151a10","sub":"#5f6a52","subAlt":"#949f85","text":"#151a10","error":"#7d1d1d","errorExtra":"#5a1414","colorfulError":"#8a2a00","colorfulErrorExtra":"#5e1d00"},
  {"name":"sub_10","bg":"#10172a","main":"#f2c14e","caret":"#f2c14e","sub":"#4d5a7c","subAlt":"#0c1222","text":"#e6eaf4","error":"#ff5d6c","errorExtra":"#b33f4b","colorfulError":"#ff5d6c","colorfulErrorExtra":"#b33f4b"},
  {"name":"pll_skip","bg":"#1c1235","main":"#ff79d0","caret":"#6ef2ff","sub":"#6e5ca3","subAlt":"#160e2b","text":"#f3eeff","error":"#ffcc66","errorExtra":"#c99a3f","colorfulError":"#ffcc66","colorfulErrorExtra":"#c99a3f"},
  {"name":"comp_day","bg":"#f6f1e4","main":"#2456c9","caret":"#2456c9","sub":"#a39d8c","subAlt":"#e8e0cc","text":"#2a2926","error":"#cf2e2e","errorExtra":"#8f1f1f","colorfulError":"#cf2e2e","colorfulErrorExtra":"#8f1f1f"},
  {"name":"dnf","bg":"#231113","main":"#ff5468","caret":"#ff5468","sub":"#7d4249","subAlt":"#1b0d0f","text":"#f6dfe2","error":"#ffb547","errorExtra":"#c7872a","colorfulError":"#ffb547","colorfulErrorExtra":"#c7872a"},
  {"name":"lucky_scramble","bg":"#0f2419","main":"#62e394","caret":"#62e394","sub":"#3d7556","subAlt":"#0b1c13","text":"#e0f6e9","error":"#ff6b6b","errorExtra":"#b84a4a","colorfulError":"#ff6b6b","colorfulErrorExtra":"#b84a4a"},
  {"name":"sune","bg":"#2b1b2e","main":"#ffb36b","caret":"#ff7f6b","sub":"#7d5c78","subAlt":"#241626","text":"#fbe9dd","error":"#ff5c7a","errorExtra":"#b8405a","colorfulError":"#ff5c7a","colorfulErrorExtra":"#b8405a"},
  {"name":"mirror_blocks","bg":"#c9ccd1","main":"#4f5866","caret":"#23262b","sub":"#868c96","subAlt":"#b9bdc4","text":"#23262b","error":"#b3263a","errorExtra":"#7d1a28","colorfulError":"#b3263a","colorfulErrorExtra":"#7d1a28"}
];

export const DEFAULT_THEME = 'white_cross';
/** white cross in the dark: the default theme while the device is in dark mode (settings.autoSwitchTheme) */
export const DEFAULT_DARK_THEME = 'white_cross_dark';

const BY_NAME = new Map(THEMES.map((t) => [t.name, t]));

export function getTheme(name: string): Theme {
  return BY_NAME.get(name) ?? BY_NAME.get(DEFAULT_THEME)!;
}

/** WCAG relative luminance of '#rrggbb'. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Light theme = dark text on a lighter background (works for mid-tone backgrounds too). */
export function isLightTheme(t: Theme): boolean {
  return luminance(t.text) < luminance(t.bg);
}

/** A random theme other than `current`, optionally limited to light or dark ones. */
export function randomTheme(current: string, kind?: 'light' | 'dark'): Theme {
  const pool = THEMES.filter((t) => t.name !== current && (!kind || isLightTheme(t) === (kind === 'light')));
  return pool[Math.floor(Math.random() * pool.length)] ?? getTheme(current);
}

/** "white_cross" -> "white cross" */
export function themeLabel(name: string): string {
  return name.replace(/_/g, ' ');
}

const VARS: [Exclude<keyof Theme, 'name'>, string][] = [
  ['bg', '--bg-color'],
  ['main', '--main-color'],
  ['caret', '--caret-color'],
  ['sub', '--sub-color'],
  ['subAlt', '--sub-alt-color'],
  ['text', '--text-color'],
  ['error', '--error-color'],
  ['errorExtra', '--error-extra-color'],
  ['colorfulError', '--colorful-error-color'],
  ['colorfulErrorExtra', '--colorful-error-extra-color'],
];

/**
 * The favicon (a 3x3 cube face, as in public/favicon.svg) in a theme's colours: main-colour stickers and a
 * text-colour centre on the theme's background, which fills the whole icon. With `dark`, the icon switches
 * to that theme's colours while the browser is in dark mode (public/favicon.svg, before the app has
 * started; the app then draws the theme in use).
 */
export function faviconSvg(theme: Theme, dark?: Theme): string {
  // the cube spans 24 of the 32 units (gap = 1/6 of a sticker, like the header logo)
  const at = [4, 12.4, 20.8];
  const cls = (name: string) => (dark ? ` class="${name}"` : '');
  const stickers = at.flatMap((y) =>
    at.map((x) => `<rect x="${x}" y="${y}" width="7.2" height="7.2" rx="1.8"${x === at[1] && y === at[1] ? `${cls('c')} fill="${theme.text}"` : ''}/>`),
  );
  // a CSS rule beats a fill attribute, so the dark colours win inside the media query
  const style = dark ? `<style>@media (prefers-color-scheme:dark){.b{fill:${dark.bg}}.m{fill:${dark.main}}.c{fill:${dark.text}}}</style>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${style}<rect${cls('b')} width="32" height="32" rx="5" fill="${theme.bg}"/><g${cls('m')} fill="${theme.main}">${stickers.join('')}</g></svg>`;
}

/**
 * A theme as the page's CSS: its colour variables, and `color-scheme` so the browser draws its own parts
 * (scrollbars, dropdown lists, date and colour pickers, autofill) light or dark to match.
 */
export function themeColors(theme: Theme): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const [k, v] of VARS) colors[v] = theme[k];
  colors['color-scheme'] = isLightTheme(theme) ? 'light' : 'dark';
  return colors;
}

/**
 * Applies a theme to the page: its colours on :root, the browser's colour for its own bar around the page
 * (both theme-color tags in index.html, the light-mode and the dark-mode one) and the favicon.
 * lib/settings.ts picks the theme and stores it for the pre-paint script in index.html.
 */
export function applyTheme(name: string): void {
  const theme = getTheme(name);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeColors(theme))) root.style.setProperty(k, v);
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute('content', theme.bg));
  document.querySelector('link[rel="icon"]')?.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(faviconSvg(theme))}`);
  window.dispatchEvent(new CustomEvent('cubr:theme'));
}

/** Reads the current value of a theme CSS variable (for canvas/chart colours). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
