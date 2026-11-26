// The page cubr.dev shows while its server is down: a Cloudflare Worker (deploy.sh puts it live).
//
// Requests for pages and the site's files pass through here; the API, the race sockets, the hashed
// build files and the health check are routed around the Worker (deploy.sh), so it never stands
// between the app and its data or changes the address the server sees. Each request goes to the
// server unchanged and its answer comes back unchanged. Only when a page load (a navigation: the
// browser wants a document) gets an answer that means the server is down does a cubr-styled "back in
// a moment" (503, Retry-After) take the place of Cloudflare's error page. Down means Cloudflare's 530
// (the tunnel isn't connected: error 1033), its 52x (the origin can't be reached), or the gateway's
// 502, 503 and 504. Everything else keeps its real answer, so the uptime check and the app still see
// the failure. If this code throws, Cloudflare sends the request on as if there were no Worker.
// The installed app doesn't need this: its service worker opens it offline.

import { LEXEND_DECA_400 } from './font';

/** Answers that mean the server, not the page, is the problem. */
export const DOWN_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]);

/** How often the page tries again by itself, in seconds (and the Retry-After it sends). */
export const RETRY_SEC = 30;

/** A page load: what a browser fetches to show a document, as opposed to a script, an image or the API. */
export function isPageLoad(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const mode = request.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return (request.headers.get('accept') ?? '').includes('text/html'); // browsers without Sec-Fetch, and crawlers
}

// The logo as in the app's header (web/src/components/CubeLogo.tsx): a 3x3 face, its centre in the
// text colour.
const CUBE = [0, 1, 2]
  .flatMap((r) =>
    [0, 1, 2].map(
      (c) => `<rect x="${1 + c * 8.25}" y="${1 + r * 8.25}" width="7.25" height="7.25" rx="1.8"${r === 1 && c === 1 ? ' style="fill:var(--text)"' : ''}/>`,
    ),
  )
  .join('');

// web/public/favicon.svg
const FAVICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>@media (prefers-color-scheme:dark){.b{fill:#1d2024}.m{fill:#00a04d}.c{fill:#f1f3f5}}</style><rect class="b" width="32" height="32" rx="5" fill="#ffffff"/><g class="m" fill="#00a04d"><rect x="4" y="4" width="7.2" height="7.2" rx="1.8"/><rect x="12.4" y="4" width="7.2" height="7.2" rx="1.8"/><rect x="20.8" y="4" width="7.2" height="7.2" rx="1.8"/><rect x="4" y="12.4" width="7.2" height="7.2" rx="1.8"/><rect x="12.4" y="12.4" width="7.2" height="7.2" rx="1.8" class="c" fill="#1d2024"/><rect x="20.8" y="12.4" width="7.2" height="7.2" rx="1.8"/><rect x="4" y="20.8" width="7.2" height="7.2" rx="1.8"/><rect x="12.4" y="20.8" width="7.2" height="7.2" rx="1.8"/><rect x="20.8" y="20.8" width="7.2" height="7.2" rx="1.8"/></g></svg>';

/**
 * The page, self-contained: the server it would load anything from is the one that's down. White cross,
 * or white cross dark in dark mode (web/src/lib/themes.ts), in Lexend Deca, the app's font, with the
 * header's logo and the app's button. It asks to try again in a couple of minutes, and meanwhile reloads
 * itself every 30 seconds, so an open tab comes back on its own; once the server answers, the
 * reload is the real page.
 */
export const DOWN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="${RETRY_SEC}">
<title>back in a moment | cubr</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON)}">
<style>
@font-face { font-family: 'Lexend Deca'; font-style: normal; font-weight: 400; font-display: swap; src: url(data:font/woff2;base64,${LEXEND_DECA_400}) format('woff2'); }
:root { --bg: #ffffff; --main: #00a04d; --sub: #959aa1; --sub-alt: #e5e8eb; --text: #1d2024; --pad: 2rem; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #1d2024; --sub: #868c94; --sub-alt: #2c3036; --text: #f1f3f5; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; min-height: 100svh; display: flex; flex-direction: column; padding: 2rem var(--pad); background: var(--bg); color: var(--text); font: 16px/1.25 'Lexend Deca', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
a { -webkit-tap-highlight-color: transparent; }
a:focus-visible { outline: none; box-shadow: 0 0 0 0.1rem var(--bg), 0 0 0 0.2rem var(--text); }
.logo { display: flex; align-items: center; gap: 0.375rem; align-self: flex-start; border-radius: 0.5rem; color: var(--text); text-decoration: none; white-space: nowrap; }
.logo svg { width: 1.7rem; height: 1.7rem; fill: var(--main); }
.logo span { font-size: 1.95rem; line-height: 1; letter-spacing: -0.02em; }
main { flex: 1; display: grid; place-content: center; justify-items: center; gap: 1rem; padding-bottom: 4rem; text-align: center; }
h1 { margin: 0; font-size: 3rem; font-weight: 400; color: var(--main); }
p { margin: 0; line-height: 1.5; text-wrap: balance; color: var(--sub); }
.btn { display: inline-flex; padding: 0.5em 0.75em; border-radius: 0.5rem; line-height: 1.25; background: var(--sub-alt); color: var(--text); text-decoration: none; }
@media (hover: hover) { .btn:hover { background: var(--text); color: var(--bg); } }
@media (max-width: 720px) {
  :root { --pad: 1rem; }
  .logo svg { width: 1.5rem; height: 1.5rem; }
  .logo span { font-size: 1.4rem; }
  h1 { font-size: 2.25rem; }
  .btn { min-height: 44px; align-items: center; }
}
</style>
</head>
<body>
<a class="logo" href="/" aria-label="cubr home"><svg viewBox="0 0 26 26" aria-hidden="true">${CUBE}</svg><span>cubr</span></a>
<main>
<h1>back in a moment</h1>
<p>cubr's server isn't answering right now.<br>please try again in a couple of minutes.</p>
<a class="btn" href="">try again</a>
</main>
</body>
</html>
`;

/** The down page's headers: the site's own security headers, and a status that tells crawlers and caches it won't last. */
export const DOWN_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Retry-After': String(RETRY_SEC),
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

export function downPage(request: Request): Response {
  return new Response(request.method === 'HEAD' ? null : DOWN_PAGE, { status: 503, headers: DOWN_HEADERS });
}

/** Sends the request to the server (`origin`), and answers a page load the server can't serve with the down page. */
export async function handle(request: Request, origin: (request: Request) => Promise<Response>): Promise<Response> {
  if (!isPageLoad(request)) return origin(request);
  let res: Response;
  try {
    res = await origin(request);
  } catch {
    return downPage(request);
  }
  if (!DOWN_STATUSES.has(res.status)) return res;
  await res.body?.cancel();
  return downPage(request);
}

export default {
  fetch(request: Request, _env: unknown, ctx: { passThroughOnException(): void }): Promise<Response> {
    ctx.passThroughOnException();
    return handle(request, (r) => fetch(r));
  },
};
