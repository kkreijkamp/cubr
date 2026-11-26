import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { LEXEND_DECA_400, LEXEND_DECA_400_SHA256 } from './font';
import worker, { DOWN_HEADERS, DOWN_PAGE, DOWN_STATUSES, RETRY_SEC, handle, isPageLoad } from './worker';

const req = (headers: Record<string, string>, method = 'GET', path = '/daily') => new Request(`https://cubr.dev${path}`, { method, headers });
/** What a browser sends to load a page. */
const pageLoad = (method = 'GET') => req({ 'sec-fetch-mode': 'navigate', accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, method);
const answer = (status: number, body = 'from the server') => new Response(status === 304 ? null : body, { status });
const origin = (res: Response | Error) => vi.fn(async () => (res instanceof Error ? Promise.reject(res) : res));

/** One of the web app's themes (web/src/lib/themes.ts lists them one JSON object per line). */
function webTheme(name: string): Record<string, string> {
  const src = readFileSync(new URL('../../../web/src/lib/themes.ts', import.meta.url), 'utf8');
  const found = src.match(new RegExp(`\\{"name":"${name}"[^}]*\\}`));
  if (!found) throw new Error(`no theme ${name}`);
  return JSON.parse(found[0]);
}

describe('isPageLoad', () => {
  it('is a navigation: what a browser sends to show a document', () => {
    expect(isPageLoad(pageLoad())).toBe(true);
    expect(isPageLoad(pageLoad('HEAD'))).toBe(true);
    expect(isPageLoad(req({ accept: 'text/html' }))).toBe(true); // no Sec-Fetch headers: older browsers, crawlers
  });
  it("isn't the app's own requests, files, a form post, or the uptime check", () => {
    for (const mode of ['cors', 'no-cors', 'same-origin']) expect(isPageLoad(req({ 'sec-fetch-mode': mode, accept: 'text/html' })), mode).toBe(false);
    expect(isPageLoad(req({ accept: '*/*' }))).toBe(false); // Google's uptime check and curl
    expect(isPageLoad(req({ 'sec-fetch-mode': 'navigate', accept: 'text/html' }, 'POST'))).toBe(false);
  });
});

describe('handle', () => {
  it("hands the server's answer back untouched while it's up", async () => {
    for (const status of [200, 301, 302, 304, 404, 500]) {
      const res = answer(status);
      const server = origin(res);
      const request = pageLoad();
      expect(await handle(request, server), String(status)).toBe(res);
      expect(server).toHaveBeenCalledWith(request);
    }
  });

  it("shows the down page for a page load the server can't answer: the tunnel down (530), Cloudflare's 52x, the gateway's 502-504", async () => {
    expect([...DOWN_STATUSES].sort()).toEqual([502, 503, 504, 520, 521, 522, 523, 524, 530]);
    for (const status of DOWN_STATUSES) {
      const fromServer = answer(status, '{"error":{"code":"UNAVAILABLE"}}');
      const res = await handle(pageLoad(), origin(fromServer));
      expect(res.status, String(status)).toBe(503);
      expect(Object.fromEntries(res.headers)).toMatchObject({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '30',
        'x-robots-tag': 'noindex',
      });
      expect(await res.text()).toBe(DOWN_PAGE);
      expect(fromServer.bodyUsed || fromServer.body?.locked, 'the server body is let go').toBe(true);
    }
    const unreachable = await handle(pageLoad(), origin(new Error('connection refused')));
    expect(unreachable.status).toBe(503);
    const head = await handle(pageLoad('HEAD'), origin(answer(502)));
    expect(head.status).toBe(503);
    expect(await head.text()).toBe('');
  });

  it('keeps the real answer for everything but page loads, so the app and the uptime check see the failure', async () => {
    for (const request of [
      req({ 'sec-fetch-mode': 'cors' }),
      req({ accept: '*/*' }, 'GET', '/healthz'),
      req({ 'sec-fetch-mode': 'no-cors' }, 'GET', '/favicon.svg'),
    ]) {
      const res = answer(530);
      expect(await handle(request, origin(res))).toBe(res);
    }
    // and an unreachable server for them is Cloudflare's to answer (the Worker passes through on exceptions)
    await expect(handle(req({ 'sec-fetch-mode': 'cors' }), origin(new Error('down')))).rejects.toThrow('down');
  });

  it('runs as a Worker: fetches from the server, and lets Cloudflare carry on if it throws', async () => {
    const ctx = { passThroughOnException: vi.fn() };
    vi.stubGlobal('fetch', origin(answer(530)));
    try {
      const res = await worker.fetch(pageLoad(), {}, ctx);
      expect(res.status).toBe(503);
      expect(ctx.passThroughOnException).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the down page', () => {
  it('needs nothing from the server: no scripts, every link and resource is the page itself or inline', () => {
    expect(DOWN_PAGE).not.toMatch(/<script|https?:\/\//i);
    const refs = [...DOWN_PAGE.matchAll(/(?:href|src)="([^"]*)"|url\(([^)]*)\)/g)].map((m) => m[1] ?? m[2]);
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const ref of refs) expect(['', '/'].includes(ref) || ref.startsWith('data:'), ref.slice(0, 40)).toBe(true);
    expect(DOWN_PAGE).toContain(`url(data:font/woff2;base64,${LEXEND_DECA_400}) format('woff2')`);
    expect(DOWN_HEADERS['Content-Security-Policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it('asks to try again in a couple of minutes, and reloads itself meanwhile', () => {
    expect(RETRY_SEC).toBe(30);
    expect(DOWN_PAGE).toContain('<meta http-equiv="refresh" content="30">');
    expect(DOWN_PAGE).toContain("cubr's server isn't answering right now.<br>please try again in a couple of minutes.");
    expect(DOWN_PAGE).not.toContain('tries again every');
    expect(DOWN_PAGE).toContain('<title>back in a moment | cubr</title>');
    expect(DOWN_PAGE).toContain('<html lang="en">');
  });

  it('wears the default themes: white cross, and white cross dark in dark mode', () => {
    const light = webTheme('white_cross');
    const dark = webTheme('white_cross_dark');
    expect(DOWN_PAGE).toContain(`:root { --bg: ${light.bg}; --main: ${light.main}; --sub: ${light.sub}; --sub-alt: ${light.subAlt}; --text: ${light.text};`);
    expect(DOWN_PAGE).toContain(
      `@media (prefers-color-scheme: dark) { :root { --bg: ${dark.bg}; --sub: ${dark.sub}; --sub-alt: ${dark.subAlt}; --text: ${dark.text};`,
    );
    expect(dark.main).toBe(light.main);
    // the favicon is the site's
    const favicon = readFileSync(new URL('../../../web/public/favicon.svg', import.meta.url), 'utf8').trim();
    expect(DOWN_PAGE).toContain(`<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(favicon)}">`);
  });

  it('embeds a whole WOFF2 font, the one make-font.mjs wrote', () => {
    const font = Buffer.from(LEXEND_DECA_400, 'base64');
    expect(font.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(createHash('sha256').update(font).digest('hex')).toBe(LEXEND_DECA_400_SHA256);
  });

  // where the web app's packages are installed (not in CI's backend job, which installs the root's only)
  const PACKAGE_FONT = new URL('../../../web/node_modules/@fontsource/lexend-deca/files/lexend-deca-latin-400-normal.woff2', import.meta.url);
  it.skipIf(!existsSync(PACKAGE_FONT))("embeds the app's font, Lexend Deca, as the package ships it (node deploy/cloudflare/down-page/make-font.mjs)", () => {
    expect(Buffer.from(LEXEND_DECA_400, 'base64').equals(readFileSync(PACKAGE_FONT))).toBe(true);
  });
});
