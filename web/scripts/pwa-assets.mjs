// Renders the installable app's images and the link preview in web/public/ with headless Chrome (DevTools protocol).
//
//   1. start Chrome with remote debugging, e.g. on macOS:
//        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//          --remote-debugging-port=9333 --user-data-dir=/tmp/cubr-chrome about:blank
//   2. icons (home screen, install dialog, app shortcuts):
//        node web/scripts/pwa-assets.mjs icons
//   3. screenshots for the install dialog, from a running app (e.g. the local stack on :8080):
//        node web/scripts/pwa-assets.mjs screenshots http://localhost:8080
//   4. the link preview image (index.html's og:image, shown next to links to cubr.dev):
//        node web/scripts/pwa-assets.mjs og
//   5. iOS launch images (what an iPhone or iPad shows while cubr opens from the home screen), a light
//      and a dark set, and their <link> tags in index.html:
//        node web/scripts/pwa-assets.mjs launch
//
// The icons follow the favicon (public/favicon.svg, lib/themes.ts faviconSvg): a 3x3 cube face in the
// white cross colours. The shortcut icons use the header's heroicons. The screenshots show the timer
// for a guest with made-up solves, so no account appears in them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(WEB, 'public');
const CDP = process.env.CDP ?? 'http://127.0.0.1:9333';

const BG = '#ffffff';
const MAIN = '#00a04d';
const CENTRE = '#1d2024';
// white cross dark (lib/themes.ts), the default theme in dark mode: the dark launch images
const DARK_BG = '#1d2024';
const DARK_CENTRE = '#f1f3f5';

/** The cube face: 3 x 3 stickers over `span` units from (x, y), as in the favicon (7.2 / 1.2 / 1.8 of 24). */
function face(x, y, span, { centre = CENTRE, fill = MAIN } = {}) {
  const k = span / 24;
  const rects = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      rects.push(
        `<rect x="${x + c * 8.4 * k}" y="${y + r * 8.4 * k}" width="${7.2 * k}" height="${7.2 * k}" rx="${1.8 * k}" fill="${r === 1 && c === 1 ? centre : fill}"/>`,
      );
  return rects.join('');
}
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%">${body}</svg>`;

// "any": the favicon tile itself (rounded, transparent corners) - desktops show it as is
const anyIcon = svg(`<rect width="100" height="100" rx="15.625" fill="${BG}"/>${face(12.5, 12.5, 75)}`);
// "maskable": full bleed; the face stays inside the safe circle (80 % across) whatever shape the
// launcher cuts: its farthest corner is 0.676 x 56 = 37.9 % from the middle (< 40 %)
const maskableIcon = svg(`<rect width="100" height="100" fill="${BG}"/>${face(22, 22, 56)}`);
// "monochrome": the shape alone, for Android's themed icons (the system colours it)
const monochromeIcon = svg(face(22, 22, 56, { centre: '#000', fill: '#000' }));
// iOS rounds the corners itself and shows transparency as black: full bleed, a little more room
const appleIcon = svg(`<rect width="100" height="100" fill="${BG}"/>${face(18, 18, 64)}`);

/** A heroicons outline glyph (24 x 24, stroke 1.5) from the installed package, as an SVG path list. */
function heroicon(name) {
  const src = fs.readFileSync(path.join(WEB, 'node_modules/@heroicons/react/24/outline', `${name}.js`), 'utf8');
  const paths = [...src.matchAll(/d: "([^"]+)"/g)].map((m) => m[1]);
  if (!paths.length) throw new Error(`no paths in ${name}`);
  return paths.map((d) => `<path d="${d}" fill="none" stroke="${MAIN}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
}
// app shortcuts: the header's icon for the page on the app tile (Android puts it on a white circle,
// Windows lists it as is); the glyph covers the middle 54 %, inside every launcher's mask
const shortcut = (name) => svg(`<rect width="100" height="100" rx="15.625" fill="${BG}"/><g transform="translate(23 23) scale(2.25)">${heroicon(name)}</g>`);

const ICONS = [
  ['icons/icon-192.png', 192, anyIcon],
  ['icons/icon-512.png', 512, anyIcon],
  ['icons/icon-maskable-192.png', 192, maskableIcon],
  ['icons/icon-maskable-512.png', 512, maskableIcon],
  ['icons/icon-monochrome-512.png', 512, monochromeIcon],
  ['apple-touch-icon.png', 180, appleIcon],
  ['icons/shortcut-daily.png', 192, shortcut('CalendarDaysIcon')],
  ['icons/shortcut-race.png', 192, shortcut('FlagIcon')],
  ['icons/shortcut-leaderboards.png', 192, shortcut('TrophyIcon')],
];

// ---------------------------------------------------------------- iOS launch images

// iOS shows a launch image while a home-screen web app starts, instead of a blank white screen, but
// only one whose media query matches the screen exactly: its size in points (CSS px), pixel ratio and
// orientation. The image is that size in pixels. Rows: portrait width x height in points, the pixel
// ratio, and the devices. From Apple's device table (as pwa-asset-generator keeps it) and Apple's spec
// pages for the newer models, 2026-11-17. Duplicates of a size are listed once.
//
// A light and a dark set: white cross and white cross dark (the app's default themes in each mode)
// with the app icon's cube in the middle, coloured as the favicon is in each mode. iOS picks the set
// for the mode the device is in when cubr is added to the home screen, and keeps it when the mode
// changes later (WebKit bug 259328, open since 2023); removing cubr and adding it again picks again.
// Android's and desktops' splash screens come from the manifest instead: background_color, and
// color_scheme_dark once browsers read it.
const LAUNCH_SCREENS = [
  [320, 568, 2, 'iPhone SE (1st generation), iPod touch'],
  [375, 667, 2, 'iPhone 6, 6s, 7, 8, SE (2nd and 3rd generation)'],
  [414, 736, 3, 'iPhone 6 Plus, 6s Plus, 7 Plus, 8 Plus'],
  [375, 812, 3, 'iPhone X, XS, 11 Pro'],
  [414, 896, 2, 'iPhone XR, 11'],
  [414, 896, 3, 'iPhone XS Max, 11 Pro Max'],
  [360, 780, 3, 'iPhone 12 mini, 13 mini'],
  [390, 844, 3, 'iPhone 12, 12 Pro, 13, 13 Pro, 14, 16e, 17e'],
  [428, 926, 3, 'iPhone 12 Pro Max, 13 Pro Max, 14 Plus'],
  [393, 852, 3, 'iPhone 14 Pro, 15, 15 Pro, 16'],
  [430, 932, 3, 'iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus'],
  [402, 874, 3, 'iPhone 16 Pro, 17, 17 Pro, 18 Pro'],
  [440, 956, 3, 'iPhone 16 Pro Max, 17 Pro Max, 18 Pro Max'],
  [420, 912, 3, 'iPhone Air'],
  // Apple gives the Duo's pixels (inner 1878 x 2670, outer 1398 x 2034) but not its scale: 3x, as on
  // every iPhone since the X, is a guess. A wrong guess just matches nothing.
  [626, 890, 3, 'iPhone Duo, unfolded'],
  [466, 678, 3, 'iPhone Duo, folded'],
  [768, 1024, 2, 'iPad 9.7-inch, iPad Air 9.7-inch, iPad Pro 9.7-inch, iPad mini 7.9-inch'],
  [810, 1080, 2, 'iPad 10.2-inch'],
  [834, 1112, 2, 'iPad Pro 10.5-inch, iPad Air 10.5-inch'],
  [820, 1180, 2, 'iPad 10.9 and 11-inch, iPad Air 10.9 and 11-inch'],
  [834, 1194, 2, 'iPad Pro 11-inch (1st to 4th generation)'],
  [834, 1210, 2, 'iPad Pro 11-inch (M4, M5)'],
  [1024, 1366, 2, 'iPad Pro 12.9-inch, iPad Air 13-inch'],
  [1032, 1376, 2, 'iPad Pro 13-inch (M4, M5)'],
  [744, 1133, 2, 'iPad mini 8.3-inch'],
  [756, 1158, 2, 'iPad mini 8.5-inch (A20 Pro)'],
];
/** The cube's size on a launch image, in points: the same physical size on every iPhone and iPad. */
const LAUNCH_CUBE = 96;

/**
 * Every launch image: [file, pixel width, pixel height, media query, pixel ratio, mode]; per screen,
 * portrait then landscape, each light then dark.
 */
function launchImages() {
  return LAUNCH_SCREENS.flatMap(([w, h, ratio]) =>
    ['portrait', 'landscape'].flatMap((orientation) =>
      ['light', 'dark'].map((mode) => {
        const [pw, ph] = orientation === 'portrait' ? [w * ratio, h * ratio] : [h * ratio, w * ratio];
        const media = `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: ${orientation}) and (prefers-color-scheme: ${mode})`;
        return [`launch/apple-launch-${pw}x${ph}${mode === 'dark' ? '-dark' : ''}.png`, pw, ph, media, ratio, mode];
      }),
    ),
  );
}

const LINKS_START = '<!-- iOS launch images: node web/scripts/pwa-assets.mjs launch writes these -->';
const LINKS_END = '<!-- /iOS launch images -->';

async function launch() {
  const { send, ev, close } = await connect();
  try {
    for (const [file, pw, ph, , ratio, mode] of launchImages()) {
      await send('Emulation.setDeviceMetricsOverride', { width: pw, height: ph, deviceScaleFactor: 1, mobile: false });
      const size = LAUNCH_CUBE * ratio;
      const [bg, centre] = mode === 'dark' ? [DARK_BG, DARK_CENTRE] : [BG, CENTRE];
      // the icon's face (24 units of its 32) at LAUNCH_CUBE points, in the middle
      const page = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pw} ${ph}" width="${pw}" height="${ph}"><rect width="${pw}" height="${ph}" fill="${bg}"/>${face((pw - size) / 2, (ph - size) / 2, size, { centre })}</svg>`;
      const html = `<!doctype html><html><body style="margin:0;width:${pw}px;height:${ph}px">${page}</body></html>`;
      await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
      await waitFor(ev, `document.readyState === 'complete'`);
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: pw, height: ph, scale: 1 } });
      save(file, data);
      console.log(`${file} (${pw} x ${ph})`);
    }
  } finally {
    await close();
  }
  // the <link> tags, between the markers in index.html
  const indexFile = path.join(WEB, 'index.html');
  const html = fs.readFileSync(indexFile, 'utf8');
  const start = html.indexOf(LINKS_START);
  const end = html.indexOf(LINKS_END);
  if (start < 0 || end < start) throw new Error(`index.html needs the markers ${LINKS_START} and ${LINKS_END}`);
  const indent = html.slice(html.lastIndexOf('\n', start) + 1, start);
  const links = launchImages().map(([file, , , media]) => `${indent}<link rel="apple-touch-startup-image" media="${media}" href="/${file}" />`);
  fs.writeFileSync(indexFile, `${html.slice(0, start + LINKS_START.length)}\n${links.join('\n')}\n${indent}${html.slice(end)}`);
  console.log(`index.html: ${links.length} launch image links`);
}

// ---------------------------------------------------------------- DevTools protocol

async function connect() {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (m) => {
    const x = JSON.parse(m.data);
    if (x.id && waiting.has(x.id)) {
      waiting.get(x.id)(x);
      waiting.delete(x.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      waiting.set(n, (x) => (x.error ? rej(new Error(`${method}: ${x.error.message}`)) : res(x.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.text}`);
    return r.result.value;
  };
  const close = async () => {
    await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
    ws.close();
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return { send, ev, close };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(ev, expression, ms = 15000) {
  for (let i = 0; i < ms / 100; i++) {
    if (await ev(expression)) return;
    await sleep(100);
  }
  throw new Error(`timed out: ${expression}`);
}

function save(file, base64) {
  const out = path.join(PUBLIC, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(base64, 'base64'));
}

async function icons() {
  const { send, ev, close } = await connect();
  try {
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (const [file, size, image] of ICONS) {
      await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
      const html = `<!doctype html><html><body style="margin:0;background:transparent;width:${size}px;height:${size}px">${image}</body></html>`;
      await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
      await waitFor(ev, `document.readyState === 'complete'`);
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
      save(file, data);
      console.log(`${file} (${size} x ${size})`);
    }
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------- link preview

// What chat apps and social sites show next to a link to cubr.dev (index.html: og:image): the
// header's logo, centred on white cross's white. Same drawing as components/CubeLogo.tsx (26-unit
// face, 7.25 stickers 8.25 apart, rx 1.8, the centre in the text colour) and the same proportions
// as global.css .logo (icon 1.7, text 1.95, gap 0.375, letter-spacing -0.02em), at `scale` px per
// rem: about 580 px wide, so a square crop of the middle still shows all of it.
const OG = { file: 'og.png', width: 1200, height: 630, scale: 92, text: '#1d2024' };

function lockup(scale) {
  const stickers = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      stickers.push(`<rect x="${1 + c * 8.25}" y="${1 + r * 8.25}" width="7.25" height="7.25" rx="1.8" fill="${r === 1 && c === 1 ? OG.text : MAIN}"/>`);
  return `<div style="display:flex;align-items:center;gap:${0.375 * scale}px;color:${OG.text};font-family:'Lexend Deca';white-space:nowrap">
    <svg viewBox="0 0 26 26" style="width:${1.7 * scale}px;height:${1.7 * scale}px;flex-shrink:0">${stickers.join('')}</svg>
    <span style="font-size:${1.95 * scale}px;line-height:1;letter-spacing:-0.02em">cubr</span>
  </div>`;
}

async function og() {
  const font = fs.readFileSync(path.join(WEB, 'node_modules/@fontsource/lexend-deca/files/lexend-deca-latin-400-normal.woff2')).toString('base64');
  const { send, ev, close } = await connect();
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: OG.width, height: OG.height, deviceScaleFactor: 1, mobile: false });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face { font-family: 'Lexend Deca'; font-weight: 400; src: url(data:font/woff2;base64,${font}) format('woff2'); }
      html, body { margin: 0 }
      body { width: ${OG.width}px; height: ${OG.height}px; background: ${BG}; display: grid; place-items: center }
    </style></head><body>${lockup(OG.scale)}</body></html>`;
    await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
    await waitFor(ev, `document.readyState === 'complete'`);
    await ev(`document.fonts.ready.then(() => true)`);
    // the word must be in Lexend Deca, not a fallback font
    if (!(await ev(`[...document.fonts].some((f) => f.family.includes('Lexend Deca') && f.status === 'loaded')`))) throw new Error('Lexend Deca did not load');
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: OG.width, height: OG.height, scale: 1 } });
    save(OG.file, data);
    console.log(`${OG.file} (${OG.width} x ${OG.height})`);
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------- screenshots

/** Made-up guest solves (a seeded random walk around 11 s), so the stats and the list look lived in. */
function guestData() {
  let seed = 20261116;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const moves = ['R', 'L', 'U', 'D', 'F', 'B'];
  const scramble = () => {
    const out = [];
    let last = -1;
    while (out.length < 20) {
      const m = Math.floor(rand() * 6);
      if (m === last) continue;
      last = m;
      out.push(moves[m] + ['', "'", '2'][Math.floor(rand() * 3)]);
    }
    return out.join(' ');
  };
  const now = Date.now();
  const solves = [];
  for (let i = 0; i < 140; i++) {
    const ms = Math.round(9800 + rand() * 2600 + (rand() < 0.08 ? 1800 : 0) - i * 6);
    const pen = rand() < 0.03 ? 1 : rand() < 0.01 ? 2 : 0;
    solves.push([`shot-${i}`, ms, pen, scramble(), null, now - (140 - i) * 95_000]);
  }
  const at = new Date(now - 30 * 86_400_000).toISOString();
  return {
    v: 1,
    sessions: [
      { id: 'shot-333', name: '3x3', event: '333', createdAt: at, updatedAt: at },
      { id: 'shot-333p', name: '3x3 practice', event: '333', practice: true, createdAt: at, updatedAt: at },
    ],
    solves: { 'shot-333': solves, 'shot-333p': [] },
    current: 'shot-333',
    lastByEvent: { 333: 'shot-333' },
  };
}

// the default theme with the 2D preview, and its dark twin with the 3D preview (a theme saved on its own,
// so the pictures don't depend on the screenshot browser's light or dark mode)
const LIGHT = { theme: 'white_cross', autoSwitchTheme: false };
const DARK = { theme: 'white_cross_dark', autoSwitchTheme: false, scramblePreview: '3D' };
const SHOTS = [
  // [file, css width, css height, device pixel ratio, mobile, settings]
  ['screenshots/timer-wide.png', 1280, 800, 1, false, LIGHT],
  ['screenshots/timer-wide-dark.png', 1280, 800, 1, false, DARK],
  ['screenshots/timer-narrow.png', 390, 844, 2, true, LIGHT],
  ['screenshots/timer-narrow-dark.png', 390, 844, 2, true, DARK],
];

async function screenshots(base) {
  const { send, ev, close } = await connect();
  try {
    for (const [file, width, height, dpr, mobile, settings] of SHOTS) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
      // a clean browser: an earlier visit's service worker would serve the build it cached (and announce the new one)
      await send('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'all' });
      // seed from a page that doesn't run the app: the app would save its own fresh guest data over it
      await send('Page.navigate', { url: `${base}/favicon.svg` });
      await waitFor(ev, `document.readyState === 'complete'`);
      await ev(
        `localStorage.clear(); localStorage.setItem('cubr.local.v1', ${JSON.stringify(JSON.stringify(guestData()))}); localStorage.setItem('cubr.settings', ${JSON.stringify(JSON.stringify(settings))}); true`,
      );
      await send('Page.navigate', { url: `${base}/` });
      await waitFor(ev, `!!document.querySelector('.tp-session-btn') && !!document.querySelector('.scramble-text, .tp-scramble') && document.fonts.status === 'loaded'`);
      await sleep(3000); // the scramble, its preview and the stats settle
      // the footer's version (a local stack says "vdev") would date the picture: leave it out
      await ev(`(() => { const v = [...document.querySelectorAll('.footer-right button')].pop(); if (v) v.style.visibility = 'hidden'; return true; })()`);
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
      save(file, data);
      console.log(`${file} (${width * dpr} x ${height * dpr})`);
    }
  } finally {
    await close();
  }
}

const [what, base] = process.argv.slice(2);
if (what === 'icons') await icons();
else if (what === 'og') await og();
else if (what === 'launch') await launch();
else if (what === 'screenshots' && base) await screenshots(base.replace(/\/$/, ''));
else {
  console.error('usage: node web/scripts/pwa-assets.mjs icons | og | launch | screenshots <app url>');
  process.exit(1);
}
