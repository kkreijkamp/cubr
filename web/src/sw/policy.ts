// What cubr's service worker (sw.ts) caches and how it answers each request. Pure functions, shared
// by the worker, the build step that lists the files to cache (plugins/serviceWorker.ts) and the tests.

/** Every cache the worker makes starts with this; there is one per build, named after its version. */
export const CACHE_PREFIX = 'cubr-app-';

export function cacheNameFor(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** The app's page: every navigation inside the app gets it (the router picks the page). */
export const SHELL_URL = '/index.html';

/**
 * Whether a built file (a path inside dist/, e.g. "assets/index-abc.js") is cached when the worker
 * installs, so that every page of the app opens offline. Left out: the worker itself, source maps,
 * the .woff copies of the fonts (every browser with service workers uses the .woff2 ones), the
 * icons and screenshots, which only the browser's install screens and the home screen use, and the
 * files for other sites and crawlers (the link preview image, robots.txt, the sitemap, security.txt).
 */
export function shouldPrecache(file: string): boolean {
  if (file === 'sw.js' || file.endsWith('.map') || file.endsWith('.woff')) return false;
  if (file.startsWith('icons/') || file.startsWith('screenshots/') || file.startsWith('apple-touch-icon')) return false;
  if (file === 'og.png' || file === 'robots.txt' || file === 'sitemap.xml' || file.startsWith('.well-known/')) return false;
  return /\.(html|js|css|woff2|svg|png|webp|json|webmanifest|txt)$/.test(file);
}

/** The URLs the worker caches for a build's files, sorted so the list (and the version) is stable. */
export function precacheUrls(files: readonly string[]): string[] {
  return files
    .filter(shouldPrecache)
    .map((f) => `/${f}`)
    .sort();
}

/** Files whose name carries a content hash: they never change, so any cached copy is good. */
export function isHashedAsset(path: string): boolean {
  return path.startsWith('/assets/');
}

/**
 * How the worker answers a request:
 * - shell: a page of the app (a navigation): the cached index.html, so the app opens offline
 * - asset: a hashed build file: the cache first (it never changes), else the network
 * - file: another file of the site (favicon, manifest): the network first, else the cache
 * - pass: not answered at all, as if there were no worker: anything but GET, other sites, the API,
 *   live races (Socket.IO), the health and version checks, the worker script, and navigations to
 *   files (e.g. /robots.txt)
 */
export type Route = 'shell' | 'asset' | 'file' | 'pass';

/** Paths the worker never answers (always the network). */
const NETWORK_ONLY = /^\/(?:api|internal|socket\.io)(?:\/|$)|^\/(?:_info|healthz|readyz|sw\.js)$/;

export function routeFor(request: { url: string; method: string; mode: string }, origin: string): Route {
  if (request.method !== 'GET') return 'pass';
  const url = new URL(request.url);
  if (url.origin !== origin || NETWORK_ONLY.test(url.pathname)) return 'pass';
  if (request.mode === 'navigate') return isAppPath(url.pathname) ? 'shell' : 'pass';
  return isHashedAsset(url.pathname) ? 'asset' : 'file';
}

/**
 * A path the app's router handles: no file extension in its last part ("/", "/daily",
 * "/profile/koen_k"; usernames and race room ids have no dots).
 */
export function isAppPath(path: string): boolean {
  return !path.slice(path.lastIndexOf('/') + 1).includes('.');
}

/**
 * The app caches to delete once `current` is active: every other one except the newest. Tabs still open
 * on the previous version can keep loading its lazily loaded pages from that one. `names` is in creation
 * order, as caches.keys() returns them.
 */
export function staleCaches(names: readonly string[], current: string): string[] {
  return names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== current).slice(0, -1);
}
