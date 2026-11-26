// Themes: cube-inspired cubr originals, as #rrggbb so charts can append an alpha byte. The picker lists them in
// this order: light themes (white cross first), then dark ones (white cross dark first), pale before bold, and round
// the colour wheel within each. Every one keeps the timer readable (text 7:1 on the background), the accent and the
// errors apart, and its own look (themes.test.ts checks them all).
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
  {"name":"white_cross","bg":"#ffffff","main":"#00a04d","caret":"#0046ad","sub":"#959aa1","subAlt":"#e5e8eb","text":"#1d2024","error":"#d0252f","errorExtra":"#8f1920","colorfulError":"#ff6a13","colorfulErrorExtra":"#b34507"},
  {"name":"square_one","bg":"#fafafa","main":"#0037f7","caret":"#ee1118","sub":"#808080","subAlt":"#e6e6e6","text":"#121212","error":"#d8151e","errorExtra":"#95000c","colorfulError":"#d8151e","colorfulErrorExtra":"#95000c"},
  {"name":"comp_day","bg":"#f6f1e4","main":"#2456c9","caret":"#2456c9","sub":"#a39d8c","subAlt":"#e8e0cc","text":"#2a2926","error":"#cf2e2e","errorExtra":"#8f1f1f","colorfulError":"#cf2e2e","colorfulErrorExtra":"#8f1f1f"},
  {"name":"pyraminx","bg":"#f0dfc0","main":"#007c7c","caret":"#b74b21","sub":"#8e755a","subAlt":"#e3cead","text":"#362517","error":"#be2323","errorExtra":"#810009","colorfulError":"#be2323","colorfulErrorExtra":"#810009"},
  {"name":"solved","bg":"#d5fae9","main":"#006f53","caret":"#e96e50","sub":"#65897c","subAlt":"#bfecd7","text":"#072d25","error":"#d02b31","errorExtra":"#940014","colorfulError":"#d02b31","colorfulErrorExtra":"#940014"},
  {"name":"frosted","bg":"#def4ff","main":"#007da3","caret":"#00b4bb","sub":"#658696","subAlt":"#c5e6f5","text":"#0b293c","error":"#d02b31","errorExtra":"#940014","colorfulError":"#d02b31","colorfulErrorExtra":"#940014"},
  {"name":"ghost_cube","bg":"#f1eefe","main":"#734ad3","caret":"#734ad3","sub":"#7f7d94","subAlt":"#e1dcf2","text":"#262339","error":"#d02b31","errorExtra":"#940014","colorfulError":"#d02b31","colorfulErrorExtra":"#940014"},
  {"name":"pocket_cube","bg":"#ffe9f3","main":"#ae1599","caret":"#ae1599","sub":"#9c7285","subAlt":"#fbd3e4","text":"#3b192a","error":"#ce3400","errorExtra":"#8c2000","colorfulError":"#ce3400","colorfulErrorExtra":"#8c2000"},
  {"name":"mirror_blocks","bg":"#c9ccd1","main":"#005dca","caret":"#005dca","sub":"#868c96","subAlt":"#b9bdc4","text":"#23262b","error":"#b3263a","errorExtra":"#7d1a28","colorfulError":"#b3263a","colorfulErrorExtra":"#7d1a28"},
  {"name":"stackmat","bg":"#a3ad94","main":"#2b3a1f","caret":"#151a10","sub":"#5f6a52","subAlt":"#949f85","text":"#151a10","error":"#7d1d1d","errorExtra":"#5a1414","colorfulError":"#8a2a00","colorfulErrorExtra":"#5e1d00"},
  {"name":"y_perm","bg":"#fcd936","main":"#5a20ab","caret":"#5a20ab","sub":"#796737","subAlt":"#eec724","text":"#211909","error":"#b00c15","errorExtra":"#6f0006","colorfulError":"#b00c15","colorfulErrorExtra":"#6f0006"},
  {"name":"z_perm","bg":"#d0f854","main":"#03379a","caret":"#03379a","sub":"#587339","subAlt":"#c1e64d","text":"#122505","error":"#b7191c","errorExtra":"#780007","colorfulError":"#b7191c","colorfulErrorExtra":"#780007"},
  {"name":"j_perm","bg":"#89edd7","main":"#8a1586","caret":"#8a1586","sub":"#46736d","subAlt":"#79ddc7","text":"#002826","error":"#b7191c","errorExtra":"#780007","colorfulError":"#b7191c","colorfulErrorExtra":"#780007"},
  {"name":"clock","bg":"#98dbff","main":"#194cb1","caret":"#194cb1","sub":"#486e88","subAlt":"#87cbef","text":"#091f3b","error":"#b71824","errorExtra":"#78000f","colorfulError":"#b71824","colorfulErrorExtra":"#78000f"},
  {"name":"h_perm","bg":"#ff8dbc","main":"#441a83","caret":"#441a83","sub":"#854760","subAlt":"#ef7cac","text":"#290d1b","error":"#901308","errorExtra":"#530200","colorfulError":"#901308","colorfulErrorExtra":"#530200"},
  {"name":"antisune","bg":"#fcaf91","main":"#841660","caret":"#841660","sub":"#8d5951","subAlt":"#eb9e84","text":"#2f182d","error":"#9e1614","errorExtra":"#610002","colorfulError":"#9e1614","colorfulErrorExtra":"#610002"},
  {"name":"plus_two","bg":"#ffa14c","main":"#123780","caret":"#123780","sub":"#865634","subAlt":"#f08f3e","text":"#291508","error":"#a20519","errorExtra":"#610009","colorfulError":"#a20519","colorfulErrorExtra":"#610009"},
  {"name":"white_cross_dark","bg":"#1d2024","main":"#00a04d","caret":"#3d7ff5","sub":"#868c94","subAlt":"#2c3036","text":"#f1f3f5","error":"#ff5c63","errorExtra":"#b3323a","colorfulError":"#ff6a13","colorfulErrorExtra":"#b34507"},
  {"name":"stickerless","bg":"#161616","main":"#ffd500","caret":"#ffd500","sub":"#6b6b6b","subAlt":"#202020","text":"#f1f1f1","error":"#e8263c","errorExtra":"#9c1426","colorfulError":"#ff6a13","colorfulErrorExtra":"#b34507"},
  {"name":"blindfolded","bg":"#0f0f0f","main":"#ffffff","caret":"#ffffff","sub":"#8f8f8f","subAlt":"#1b1b1b","text":"#e8e8e8","error":"#ff6060","errorExtra":"#c52531","colorfulError":"#ff6060","colorfulErrorExtra":"#c52531"},
  {"name":"void_cube","bg":"#0d0c12","main":"#a486ff","caret":"#a486ff","sub":"#68667c","subAlt":"#191821","text":"#ebeaf3","error":"#fe4f75","errorExtra":"#c30048","colorfulError":"#fe4f75","colorfulErrorExtra":"#c30048"},
  {"name":"superflip","bg":"#0d1215","main":"#24e9f2","caret":"#fe5ec3","sub":"#63757e","subAlt":"#161e22","text":"#e8f0f3","error":"#ff5f77","errorExtra":"#c52449","colorfulError":"#ff5f77","colorfulErrorExtra":"#c52449"},
  {"name":"sledgehammer","bg":"#212326","main":"#ff7e20","caret":"#ff7e20","sub":"#72787e","subAlt":"#2c2f33","text":"#efece8","error":"#f83b8c","errorExtra":"#b5005e","colorfulError":"#f83b8c","colorfulErrorExtra":"#b5005e"},
  {"name":"megaminx","bg":"#191f2b","main":"#a2f34d","caret":"#f84fcc","sub":"#6f7b90","subAlt":"#232b3a","text":"#ebeff5","error":"#ff4f6d","errorExtra":"#c40040","colorfulError":"#ff4f6d","colorfulErrorExtra":"#c40040"},
  {"name":"sub_10","bg":"#10172a","main":"#f2c14e","caret":"#f2c14e","sub":"#4d5a7c","subAlt":"#0c1222","text":"#e6eaf4","error":"#ff5d6c","errorExtra":"#b33f4b","colorfulError":"#ff5d6c","colorfulErrorExtra":"#b33f4b"},
  {"name":"lookahead","bg":"#1f2a35","main":"#66c6fd","caret":"#66c6fd","sub":"#728391","subAlt":"#283642","text":"#e9eff5","error":"#ff7072","errorExtra":"#c63b44","colorfulError":"#ff7072","colorfulErrorExtra":"#c63b44"},
  {"name":"zz","bg":"#29294d","main":"#c5b9ff","caret":"#faa6ce","sub":"#8082aa","subAlt":"#34345c","text":"#ecedfc","error":"#ff888e","errorExtra":"#c7565f","colorfulError":"#ff888e","colorfulErrorExtra":"#c7565f"},
  {"name":"half_bright","bg":"#20202c","main":"#8fe6c1","caret":"#f8b3d3","sub":"#7b7b92","subAlt":"#2b2b39","text":"#e6e6f5","error":"#fe8a88","errorExtra":"#c65859","colorfulError":"#fe8a88","colorfulErrorExtra":"#c65859"},
  {"name":"pll_skip","bg":"#1c1235","main":"#ff79d0","caret":"#6ef2ff","sub":"#6e5ca3","subAlt":"#160e2b","text":"#f3eeff","error":"#ffcc66","errorExtra":"#c99a3f","colorfulError":"#ffcc66","colorfulErrorExtra":"#c99a3f"},
  {"name":"sune","bg":"#2b1b2e","main":"#ffb36b","caret":"#ff7f6b","sub":"#7d5c78","subAlt":"#241626","text":"#fbe9dd","error":"#ff5c7a","errorExtra":"#b8405a","colorfulError":"#ff5c7a","colorfulErrorExtra":"#b8405a"},
  {"name":"dnf","bg":"#231113","main":"#ff5468","caret":"#ff5468","sub":"#7d4249","subAlt":"#1b0d0f","text":"#f6dfe2","error":"#ffb547","errorExtra":"#c7872a","colorfulError":"#ffb547","colorfulErrorExtra":"#c7872a"},
  {"name":"old_pochmann","bg":"#150e06","main":"#ffa82a","caret":"#ffa82a","sub":"#8c6a43","subAlt":"#24180a","text":"#f7daaa","error":"#fb594d","errorExtra":"#c11919","colorfulError":"#fb594d","colorfulErrorExtra":"#c11919"},
  {"name":"lucky_scramble","bg":"#0f2419","main":"#62e394","caret":"#62e394","sub":"#3d7556","subAlt":"#0b1c13","text":"#e0f6e9","error":"#ff6b6b","errorExtra":"#b84a4a","colorfulError":"#ff6b6b","colorfulErrorExtra":"#b84a4a"},
  {"name":"parity","bg":"#04282c","main":"#fe82b6","caret":"#58e1d1","sub":"#577f84","subAlt":"#0a3438","text":"#e0f3f3","error":"#fdbe45","errorExtra":"#c58c00","colorfulError":"#fdbe45","colorfulErrorExtra":"#c58c00"},
  {"name":"t_perm","bg":"#005c5a","main":"#ffbd98","caret":"#ffbd98","sub":"#7daca9","subAlt":"#004f4d","text":"#eaf9f7","error":"#fee657","errorExtra":"#c9b200","colorfulError":"#fee657","colorfulErrorExtra":"#c9b200"},
  {"name":"ivy_cube","bg":"#0f4f2e","main":"#cff367","caret":"#cff367","sub":"#739c80","subAlt":"#044223","text":"#ecf9ee","error":"#ffa098","errorExtra":"#c86f68","colorfulError":"#ffa098","colorfulErrorExtra":"#c86f68"},
  {"name":"u_perm","bg":"#243bbb","main":"#ffc166","caret":"#ff9c47","sub":"#899ac7","subAlt":"#1c2da5","text":"#f2f5fe","error":"#ff9bba","errorExtra":"#c86a89","colorfulError":"#ff9bba","colorfulErrorExtra":"#c86a89"},
  {"name":"skewb","bg":"#3d2c9b","main":"#65f0f0","caret":"#ffb4d7","sub":"#8789b8","subAlt":"#332385","text":"#f3f4fd","error":"#ff9fa2","errorExtra":"#c86e72","colorfulError":"#ff9fa2","colorfulErrorExtra":"#c86e72"},
  {"name":"podium","bg":"#601c9d","main":"#f6d653","caret":"#d3cedc","sub":"#9b8ab8","subAlt":"#501485","text":"#f6f3fc","error":"#ff9fa2","errorExtra":"#c86e72","colorfulError":"#ff9fa2","colorfulErrorExtra":"#c86e72"},
  {"name":"f_perm","bg":"#9b005a","main":"#85f6de","caret":"#f5e05d","sub":"#c590a3","subAlt":"#84004c","text":"#fef1f5","error":"#ffd16b","errorExtra":"#ca9e32","colorfulError":"#ffd16b","colorfulErrorExtra":"#ca9e32"},
  {"name":"petrus","bg":"#63162d","main":"#ffa18f","caret":"#f8ce73","sub":"#a27375","subAlt":"#540f24","text":"#ffedec","error":"#f6d653","errorExtra":"#c1a200","colorfulError":"#f6d653","colorfulErrorExtra":"#c1a200"},
  {"name":"roux","bg":"#86310d","main":"#fad86f","caret":"#fad86f","sub":"#bd937c","subAlt":"#742706","text":"#fdf0dc","error":"#ffb4d7","errorExtra":"#c982a4","colorfulError":"#ffb4d7","colorfulErrorExtra":"#c982a4"}
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

/** WCAG contrast ratio of two '#rrggbb' colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Light theme = dark text on a lighter background (works for mid-tone backgrounds too). */
export function isLightTheme(t: Theme): boolean {
  return luminance(t.text) < luminance(t.bg);
}

/** The timer's green for "let go to start" (--timer-ready, also the live dot and the "ok" pill). */
export const READY_GREEN = '#3ec46d';
const READY_DEEP = '#00290f';

/**
 * The ready green in a theme: #3ec46d wherever it reads at least as well as on white cross's white (2:1),
 * otherwise a deeper green that reads at 3:1, for light and bold backgrounds where #3ec46d would be faint
 * (it was nearly invisible on stackmat's olive).
 */
export function readyColor(theme: Theme): string {
  if (contrast(READY_GREEN, theme.bg) >= 2) return READY_GREEN;
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  for (let step = 1; step <= 50; step++) {
    const t = step / 50;
    const mixed = `#${[1, 3, 5].map((i) => Math.round(channel(READY_GREEN, i) + (channel(READY_DEEP, i) - channel(READY_GREEN, i)) * t).toString(16).padStart(2, '0')).join('')}`;
    if (contrast(mixed, theme.bg) >= 3) return mixed;
  }
  return READY_DEEP;
}

/** WCAG AA for text: what labels, links and errors reach with the high-contrast setting. */
export const HIGH_CONTRAST_RATIO = 4.5;

/** The colour `t` of the way from `a` to `b` (0 to 1), channel by channel. */
function mixHex(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** `colour`, moved toward `towards` only as far as it takes to read at `ratio` on every one of `on` (`towards` itself if nothing short of it does). */
function lift(colour: string, towards: string, on: string[], ratio: number): string {
  for (let step = 0; step < 50; step++) {
    const c = step === 0 ? colour : mixHex(colour, towards, step / 50);
    if (on.every((bg) => contrast(c, bg) >= ratio)) return c;
  }
  return towards;
}

/**
 * A theme as the high-contrast setting shows it: its labels and other quiet text (sub) read at 4.5:1
 * (WCAG AA) on the background and on cards (sub-alt), and so do its accent (main: links, the choice
 * that's on) and its errors on the background. Each moves toward the theme's text colour only as far as
 * that takes, so the theme keeps its look, a little crisper.
 */
export function highContrastTheme(theme: Theme): Theme {
  return {
    ...theme,
    sub: lift(theme.sub, theme.text, [theme.bg, theme.subAlt], HIGH_CONTRAST_RATIO),
    main: lift(theme.main, theme.text, [theme.bg], HIGH_CONTRAST_RATIO),
    error: lift(theme.error, theme.text, [theme.bg], HIGH_CONTRAST_RATIO),
  };
}

// The high-contrast setting, as lib/settings.ts last applied it: every theme shown from then on (the
// one in use, and the previews in settings and the command line) is drawn with it.
let highContrastOn = false;

/** Turns the high-contrast colours on or off for every theme shown from now on (lib/settings.ts calls it). */
export function setHighContrast(on: boolean): void {
  highContrastOn = on;
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
 * A theme as the page's CSS: its colour variables (with the high-contrast setting, highContrastTheme's),
 * the timer's ready green for its background, and `color-scheme` so the browser draws its own parts
 * (scrollbars, dropdown lists, date and colour pickers, autofill) light or dark to match.
 */
export function themeColors(theme: Theme, highContrast = highContrastOn): Record<string, string> {
  const shown = highContrast ? highContrastTheme(theme) : theme;
  const colors: Record<string, string> = {};
  for (const [k, v] of VARS) colors[v] = shown[k];
  colors['--timer-ready'] = readyColor(theme);
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
