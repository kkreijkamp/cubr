import { describe, expect, it } from 'vitest';
import { CACHE_PREFIX, cacheNameFor, isAppPath, precacheUrls, routeFor, shouldPrecache, staleCaches } from '../policy';

const ORIGIN = 'https://cubr.dev';
const req = (path: string, mode = 'cors', method = 'GET') => ({ url: path.startsWith('http') ? path : `${ORIGIN}${path}`, mode, method });

describe('shouldPrecache', () => {
  it('caches the page, the code, the styles, the fonts the browser uses and the small site files', () => {
    for (const f of ['index.html', 'assets/index-d3oOLUDV.js', 'assets/index-BxQ1.css', 'assets/lexend-deca-latin-400-normal-Cs_IAxDy.woff2', 'favicon.svg', 'manifest.webmanifest']) {
      expect(shouldPrecache(f), f).toBe(true);
    }
  });
  it('leaves out the worker, source maps, the .woff fallbacks, the icons, the screenshots and the files for other sites', () => {
    for (const f of ['sw.js', 'assets/index-d3oOLUDV.js.map', 'assets/lexend-deca-latin-400-normal-x.woff', 'icons/icon-512.png', 'screenshots/timer-wide.png', 'launch/apple-launch-1179x2556.png', 'apple-touch-icon.png', 'og.png', 'robots.txt', 'sitemap.xml', '.well-known/security.txt', '.DS_Store']) {
      expect(shouldPrecache(f), f).toBe(false);
    }
  });
  it('lists URLs from the site root, sorted (a stable list makes a stable version)', () => {
    expect(precacheUrls(['index.html', 'sw.js', 'assets/b.js', 'assets/a.js', 'icons/icon-192.png'])).toEqual(['/assets/a.js', '/assets/b.js', '/index.html']);
  });
});

describe('routeFor', () => {
  it('answers every page of the app with the cached app', () => {
    for (const p of ['/', '/daily', '/race/abcd1234', '/profile/koen_k', '/settings?tab=app', '/reset', '/no/such/page', '/apiary']) {
      expect(routeFor(req(p, 'navigate'), ORIGIN), p).toBe('shell');
    }
  });
  it('never touches the API, live races, health and version checks, or the worker script', () => {
    for (const p of ['/api', '/api/solves', '/api/auth/me', '/internal/x', '/socket.io/?EIO=4&transport=polling', '/_info', '/healthz', '/readyz', '/sw.js']) {
      expect(routeFor(req(p), ORIGIN), p).toBe('pass');
      expect(routeFor(req(p, 'navigate'), ORIGIN), `${p} (navigation)`).toBe('pass');
    }
  });
  it('leaves other methods, other sites and navigations to files alone', () => {
    expect(routeFor(req('/', 'navigate', 'POST'), ORIGIN)).toBe('pass');
    expect(routeFor(req('/api/solves', 'cors', 'PATCH'), ORIGIN)).toBe('pass');
    expect(routeFor(req('https://www.worldcubeassociation.org/api/v0/x'), ORIGIN)).toBe('pass');
    expect(routeFor(req('/robots.txt', 'navigate'), ORIGIN)).toBe('pass');
    expect(routeFor(req('/sitemap.xml', 'navigate'), ORIGIN)).toBe('pass');
    expect(routeFor(req('/.well-known/security.txt', 'navigate'), ORIGIN)).toBe('pass');
  });
  it("leaves /.well-known/ to the server: a password manager's change-password link is a redirect there, not a page of the app", () => {
    for (const p of ['/.well-known/change-password', '/.well-known/resource-that-should-not-exist-whose-status-code-should-not-be-200', '/.well-known/security.txt']) {
      expect(routeFor(req(p, 'navigate'), ORIGIN), p).toBe('pass');
      expect(routeFor(req(p), ORIGIN), `${p} (fetch)`).toBe('pass');
    }
    expect(routeFor(req('/well-known', 'navigate'), ORIGIN)).toBe('shell'); // an app path that merely looks alike
  });
  it('serves hashed assets from the cache first and other files from the network first', () => {
    expect(routeFor(req('/assets/index-d3oOLUDV.js', 'cors'), ORIGIN)).toBe('asset');
    expect(routeFor(req('/assets/lexend-deca-latin-400-normal-Cs_IAxDy.woff2', 'cors'), ORIGIN)).toBe('asset');
    expect(routeFor(req('/favicon.svg', 'no-cors'), ORIGIN)).toBe('file');
    expect(routeFor(req('/manifest.webmanifest', 'cors'), ORIGIN)).toBe('file');
  });
  it('knows app paths from file paths', () => {
    expect(isAppPath('/')).toBe(true);
    expect(isAppPath('/profile/koen_k')).toBe(true);
    expect(isAppPath('/licenses.txt')).toBe(false);
  });
});

describe('staleCaches', () => {
  const c = cacheNameFor;
  it("keeps the current cache and the newest older one, and ignores caches that are not the app's", () => {
    expect(staleCaches([c('a'), 'images', c('b'), c('c'), c('d')], c('d'))).toEqual([c('a'), c('b')]);
  });
  it('deletes nothing on the first install or the first update', () => {
    expect(staleCaches([c('a')], c('a'))).toEqual([]);
    expect(staleCaches([c('a'), c('b')], c('b'))).toEqual([]);
  });
  it('handles going back to a version whose cache still exists', () => {
    expect(staleCaches([c('a'), c('b')], c('a'))).toEqual([]);
  });
  it('names caches after the build', () => {
    expect(c('b69232be70d19e07')).toBe(`${CACHE_PREFIX}b69232be70d19e07`);
  });
});
