import { describe, expect, it } from 'vitest';
import appSource from '../../App.tsx?raw';
import { browserName, createReporter, isNoise, MAX_REPORTS_PER_PAGE, routePattern, scrubText, type ErrorReport } from '../errorReports';

const ORIGIN = 'https://cubr.dev';

function reporter(over: { pathname?: string; installed?: boolean } = {}) {
  const sent: ErrorReport[] = [];
  const r = createReporter({
    origin: ORIGIN,
    pathname: () => over.pathname ?? '/profile/Koen_K',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    touchPoints: 5,
    installed: () => over.installed ?? true,
    build: 'index-D3oOLUDV.js',
    send: (report) => sent.push(report),
  });
  return { r, sent };
}

/** An error as the browser raises it from cubr's own code. */
function thrown(message: string, name = 'TypeError') {
  const error = new Error(message);
  error.name = name;
  error.stack = `${name}: ${message}\n    at Xy (${ORIGIN}/assets/index-D3oOLUDV.js:12:3456)`;
  return { message: `Uncaught ${name}: ${message}`, error, filename: `${ORIGIN}/assets/index-D3oOLUDV.js`, lineno: 12, colno: 3456 };
}

describe('front-end error reports', () => {
  it('send an uncaught error with the page type, the build, a coarse browser and nothing personal', () => {
    const { r, sent } = reporter();
    r.onError(thrown("Cannot read properties of undefined (reading 'ms')"));
    expect(sent).toEqual([
      {
        kind: 'error',
        message: "Cannot read properties of undefined (reading 'ms')",
        stack: `TypeError: Cannot read properties of undefined (reading 'ms')\n    at Xy (${ORIGIN}/assets/index-D3oOLUDV.js:12:3456)`,
        source: `${ORIGIN}/assets/index-D3oOLUDV.js:12:3456`,
        route: '/profile/:username',
        build: 'index-D3oOLUDV.js',
        browser: 'Safari 18 on iOS',
        installed: true,
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain('Koen_K');
  });

  it('send unhandled rejections: an Error, a string, and only the type of anything else', () => {
    const { r, sent } = reporter({ pathname: '/daily' });
    r.onRejection({ reason: new Error('the daily board is empty') });
    r.onRejection({ reason: 'plain text reason' });
    r.onRejection({ reason: { username: 'koen', solves: [1, 2] } });
    expect(sent.map((s) => [s.kind, s.message, s.route])).toEqual([
      ['unhandledrejection', 'the daily board is empty', '/daily'],
      ['unhandledrejection', 'plain text reason', '/daily'],
      ['unhandledrejection', 'rejected with [object Object]', '/daily'],
    ]);
  });

  it('take personal-looking text out before it leaves the browser', () => {
    const { r, sent } = reporter();
    r.onRejection({ reason: new Error('Route GET /api/users/koen_k not found for jo@example.com at https://cubr.dev/reset?token=abc') });
    expect(sent[0].message).toBe('Route GET /api/users/:id not found for <email> at https://cubr.dev/reset');
    expect(scrubText('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2ln and 3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b')).toBe('token <token> and <redacted>');
  });

  it('send each distinct error once, and at most 5 per page', () => {
    const { r, sent } = reporter();
    for (let i = 0; i < 3; i++) r.onError(thrown('same again'));
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 10; i++) r.onError(thrown(`error ${i}`));
    expect(sent).toHaveLength(MAX_REPORTS_PER_PAGE);
  });

  it('skip noise: cross-origin scripts, extensions, a new release\'s missing chunks, aborted requests, ResizeObserver', () => {
    const { r, sent } = reporter();
    r.onError({ message: 'Script error.', error: null, filename: '', lineno: 0, colno: 0 });
    r.onError({ ...thrown('beacon failed'), filename: 'https://static.cloudflareinsights.com/beacon.min.js' });
    const ext = new Error('extension broke');
    ext.stack = 'Error: extension broke\n    at chrome-extension://abcdef/content.js:1:1';
    r.onError({ message: 'Uncaught Error: extension broke', error: ext, filename: 'chrome-extension://abcdef/content.js', lineno: 1, colno: 1 });
    r.onRejection({ reason: new TypeError('Failed to fetch dynamically imported module: https://cubr.dev/assets/SettingsPage-x.js') });
    r.onRejection({ reason: Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }) });
    r.onError({ message: 'ResizeObserver loop completed with undelivered notifications.', error: null, filename: '', lineno: 0, colno: 0 });
    expect(sent).toEqual([]);
    expect(isNoise('real bug', new Error('real bug'), `${ORIGIN}/assets/index-x.js`, ORIGIN)).toBe(false);
  });

  it("name every route of the app by its pattern, and anything else '(other)'", () => {
    const routes = [...appSource.matchAll(/\{ path: '([^']+)'/g)].map((m) => m[1]).filter((p) => p !== '*');
    expect(routes.length).toBeGreaterThanOrEqual(15);
    for (const route of routes) {
      const sample = route.replace(':roomId', 'abcd1234').replace(':username', 'Koen_K');
      expect(routePattern(sample), route).toBe(route);
      expect(routePattern(`${sample.toUpperCase()}/`), `${route} in capitals with a slash`).toBe(route);
    }
    for (const p of ['/nope', '/profile/a/b', '/jo@example.com', '/race/x/y']) expect(routePattern(p), p).toBe('(other)');
  });

  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 0, 'Chrome 142 on macOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0', 0, 'Edge 142 on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0', 0, 'Firefox 145 on Windows'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36', 5, 'Chrome 142 on Android'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36', 5, 'Samsung Internet 28 on Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1', 5, 'Chrome 142 on iOS'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 0, 'Safari 18 on macOS'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 5, 'Safari 18 on iPadOS'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 0, 'Chrome 142 on ChromeOS'],
    ['curl/8.7.1', 0, 'another browser on another system'],
  ])('describe the browser coarsely: %s', (ua, touch, expected) => {
    expect(browserName(ua, touch)).toBe(expected);
  });
});
