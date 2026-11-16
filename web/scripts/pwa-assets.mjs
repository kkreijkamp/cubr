// Renders the installable app's images in web/public/ with headless Chrome (DevTools protocol).
//
//   1. start Chrome with remote debugging, e.g. on macOS:
//        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//          --remote-debugging-port=9333 --user-data-dir=/tmp/cubr-chrome about:blank
//   2. icons (home screen, install dialog, app shortcuts):
//        node web/scripts/pwa-assets.mjs icons
//   3. screenshots for the install dialog, from a running app (e.g. the local stack on :8080):
//        node web/scripts/pwa-assets.mjs screenshots http://localhost:8080
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
const CENTRE = '#20201e';

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

// the default theme with the 2D preview, and a dark one with the 3D preview
const DARK = { theme: 'stickerless', scramblePreview: '3D' };
const SHOTS = [
  // [file, css width, css height, device pixel ratio, mobile, settings]
  ['screenshots/timer-wide.png', 1280, 800, 1, false, {}],
  ['screenshots/timer-wide-dark.png', 1280, 800, 1, false, DARK],
  ['screenshots/timer-narrow.png', 390, 844, 2, true, {}],
  ['screenshots/timer-narrow-dark.png', 390, 844, 2, true, DARK],
];

async function screenshots(base) {
  const { send, ev, close } = await connect();
  try {
    for (const [file, width, height, dpr, mobile, settings] of SHOTS) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
      await send('Page.navigate', { url: `${base}/about` });
      await waitFor(ev, `!!document.querySelector('main')`);
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
else if (what === 'screenshots' && base) await screenshots(base.replace(/\/$/, ''));
else {
  console.error('usage: node web/scripts/pwa-assets.mjs icons | screenshots <app url>');
  process.exit(1);
}
