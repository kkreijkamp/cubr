// Prerenders each public page's content into its page file (dist/pages/<path>.html, plugins/pageFiles.ts)
// for crawlers that don't run JavaScript: AI search engines, link previews and Bing at times. A headless
// Chromium renders the built app from dist/; the API is never answered, so data stays in its loading
// state and is left out, and what's kept is each page's own text and links (no icons, controls or
// attributes but links). It goes inside the page's visually hidden summary in #root, which the app
// replaces as it starts: people see nothing of it, and nothing moves.
//
// Runs in the web image's build stage (Dockerfile; Chromium from apk). CHROMIUM may point at another
// browser (on a Mac: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"). A page that
// doesn't render keeps its summary only, with a warning: the build doesn't fail over it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const PAGE_TIMEOUT_MS = 30_000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The public pages: the files plugins/pageFiles.ts wrote, as paths ("pages/about.html" -> "/about"). */
async function publicPages() {
  const out = [];
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${prefix}/${entry.name}`);
      else if (entry.name.endsWith('.html')) out.push(`${prefix}/${entry.name.slice(0, -5)}`);
    }
  };
  await walk(join(DIST, 'pages'), '');
  return out.sort();
}

/** dist/ over HTTP, as nginx serves it; the API, live races and /_info are held open, never answered. */
function serve() {
  const held = [];
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (path.startsWith('/api/') || path.startsWith('/socket.io') || path === '/_info') {
      held.push(res);
      return;
    }
    let file = normalize(join(DIST, path));
    if (!file.startsWith(DIST)) return void res.writeHead(403).end();
    const isFile = await stat(file).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!isFile) file = existsSync(join(DIST, 'pages', `${path}.html`)) ? join(DIST, 'pages', `${path}.html`) : join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          for (const res of held) res.destroy();
          server.closeAllConnections();
          server.close();
        },
      }),
    ),
  );
}

/** A headless Chromium with the DevTools protocol on a free port. */
async function launch() {
  const candidates = [process.env.CHROMIUM, '/usr/bin/chromium-browser', '/usr/bin/chromium'].filter(Boolean);
  const binary = candidates.find((p) => existsSync(p));
  if (!binary) throw new Error(`no Chromium (tried ${candidates.join(', ')}; set CHROMIUM)`);
  const profile = await mkdtemp(join(tmpdir(), 'cubr-prerender-'));
  const proc = spawn(
    binary,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const port = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`Chromium didn't start: ${err.slice(-500)}`)), 30_000);
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.on('exit', (code) => reject(new Error(`Chromium exited (${code}): ${err.slice(-500)}`)));
  });
  return {
    port,
    close: async () => {
      proc.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** A page target and a minimal DevTools client for it (Node's own WebSocket). */
async function openPage(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Page.enable');
  return {
    send,
    evaluate,
    close: async () => {
      ws.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined);
    },
  };
}

// In the page: <main>'s content as plain, meaningful HTML. Out go the h1 (the summary has the page's
// heading), icons and images, controls, loading rows (a spinner and its label), live regions, what's
// hidden from screen readers or marked data-nosnippet (the app's live parts: scrambles, room lists, the
// countdown, which search results shouldn't quote either), stand-ins (.reserve), every attribute but a
// link's href, and what's left empty. A section that's still loading keeps its own text.
const CAPTURE = `(() => {
  const main = document.querySelector('main');
  if (!main) return '';
  const copy = main.cloneNode(true);
  copy.querySelectorAll('h1, svg, img, picture, video, canvas, script, style, noscript, input, select, textarea, button, dialog, .empty:has(.spinner), [data-nosnippet], [aria-hidden="true"], [role="status"], [role="alert"], [role="progressbar"], .reserve, .skip-link').forEach((n) => n.remove());
  for (const el of copy.querySelectorAll('*')) for (const a of [...el.attributes]) if (!(el.tagName === 'A' && a.name === 'href')) el.removeAttribute(a.name);
  for (let again = true; again; ) {
    again = false;
    for (const el of copy.querySelectorAll('*')) if (!el.textContent.trim()) { el.remove(); again = true; }
  }
  return copy.innerHTML.replace(/\\s+/g, ' ').replace(/> </g, '><').trim();
})()`;

async function render(port, origin, path) {
  const page = await openPage(port);
  try {
    await page.send('Page.navigate', { url: `${origin}${path}` });
    const deadline = Date.now() + PAGE_TIMEOUT_MS;
    while (!(await page.evaluate(`document.readyState === 'complete' && !!document.querySelector('main h1')`).catch(() => false))) {
      if (Date.now() > deadline) throw new Error('no <main> with its h1');
      await sleep(200);
    }
    await sleep(1_500); // the page's own lazy parts
    return await page.evaluate(CAPTURE);
  } finally {
    await page.close();
  }
}

/** The page file with `html` added to its hidden summary, after the summary's links. */
export function withContent(file, html) {
  const summary = /(<div id="page-summary"[^>]*>[\s\S]*?<\/nav>)/g;
  const found = file.match(summary)?.length ?? 0;
  if (found !== 1) throw new Error(`a page file should have one summary with its links, and has ${found}`);
  return file.replace(summary, (block) => `${block}\n        <div id="page-content">${html}</div>`);
}

async function main() {
  const pages = await publicPages();
  const site = await serve();
  const browser = await launch();
  let done = 0;
  try {
    for (const path of pages) {
      try {
        const html = await render(browser.port, site.origin, path);
        // an app-like page (the race lobby) has little text past its heading and line, which the summary has
        if (html.replace(/<[^>]+>/g, '').trim().length < 80) {
          console.log(`${path}: little text past its summary, left as it is`);
          continue;
        }
        const file = join(DIST, 'pages', `${path}.html`);
        await writeFile(file, withContent(await readFile(file, 'utf8'), html));
        done++;
        console.log(`prerendered ${path}: ${html.length} characters`);
      } catch (e) {
        console.warn(`warning: ${path} keeps its summary only (${e.message})`);
      }
    }
  } finally {
    await browser.close();
    site.close();
  }
  console.log(`prerendered ${done} of ${pages.length} public pages`);
}

// run directly (the Dockerfile), not when a test imports withContent
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
