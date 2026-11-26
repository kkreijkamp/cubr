/// <reference lib="webworker" />
// cubr's service worker: lets the app open and work without a connection, and makes it installable.
// Built after the app by plugins/serviceWorker.ts, which fills in the list of files and the version.
//
// - install: caches every file of this build. Hashed files that an older version already cached are
//   copied from there instead of downloaded again.
// - activate: deletes the app caches older than the previous version, then takes over open pages.
// - fetch: see Route in policy.ts. The API, live races and health checks are never touched.
// - an update waits until a page asks for it (the "update ready" notice, or a click on a link), so a
//   running solve or race is never reloaded from under someone.
import { cacheNameFor, isHashedAsset, routeFor, SHELL_URL, staleCaches } from './policy';

declare const self: ServiceWorkerGlobalScope;
declare const __CUBR_PRECACHE__: string[];
declare const __CUBR_SW_VERSION__: string;

const VERSION = __CUBR_SW_VERSION__;
const CACHE = cacheNameFor(VERSION);
/** parallel downloads while installing */
const PARALLEL = 6;

/** A response the cache can hand to a navigation (one that went through a redirect can't be). */
async function plain(res: Response): Promise<Response> {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function precache(): Promise<void> {
  const cache = await caches.open(CACHE);
  const queue = [...__CUBR_PRECACHE__];
  const next = async (): Promise<void> => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      if (isHashedAsset(url)) {
        const copy = await caches.match(url, { ignoreVary: true });
        if (copy) {
          await cache.put(url, copy);
          continue;
        }
      }
      // index.html and the other unhashed files are revalidated, never taken from the HTTP cache as is
      const res = await fetch(url, { cache: isHashedAsset(url) ? 'default' : 'no-cache' });
      if (!res.ok) throw new Error(`could not cache ${url}: HTTP ${res.status}`);
      await cache.put(url, await plain(res));
    }
  };
  // one failed download fails the install: the browser keeps the old version and tries again later
  await Promise.all(Array.from({ length: PARALLEL }, next));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(staleCaches(await caches.keys(), CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

async function shell(): Promise<Response> {
  const cached = (await caches.match(SHELL_URL, { cacheName: CACHE, ignoreVary: true })) ?? (await caches.match(SHELL_URL, { ignoreVary: true }));
  return cached ?? fetch(SHELL_URL);
}

async function asset(event: FetchEvent): Promise<Response> {
  const cached = await caches.match(event.request, { ignoreVary: true });
  if (cached) return cached;
  const res = await fetch(event.request);
  if (res.ok && res.type === 'basic') {
    const copy = res.clone();
    event.waitUntil(
      caches
        .open(CACHE)
        .then((cache) => cache.put(event.request, copy))
        .catch(() => undefined),
    );
  }
  return res;
}

async function file(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch (err) {
    const cached = await caches.match(request, { ignoreVary: true, ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const route = routeFor(event.request, self.location.origin);
  if (route === 'pass') return;
  event.respondWith(route === 'shell' ? shell() : route === 'asset' ? asset(event) : file(event.request));
});

self.addEventListener('message', (event) => {
  const type = (event.data as { type?: unknown } | null)?.type;
  if (type === 'SKIP_WAITING') void self.skipWaiting();
  else if (type === 'GET_VERSION') event.ports[0]?.postMessage({ version: VERSION, files: __CUBR_PRECACHE__.length });
});

// ---- daily-challenge reminders (Web Push) ------------------------------------------------------------
// The solve service sends them to browsers that turned them on in settings (lib/reminders.ts): one
// notification, replaced by the next if unread; a click opens (or focuses) cubr on the daily page.
const REMINDER = { title: 'cubr: daily challenge', body: "today's five scrambles are up - one try each", url: '/daily' };

self.addEventListener('push', (event) => {
  let msg = REMINDER;
  try {
    msg = { ...REMINDER, ...(event.data?.json() as Partial<typeof REMINDER> | undefined) };
  } catch {
    // not JSON: the usual words
  }
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-monochrome-512.png',
      tag: 'daily-reminder',
      data: { url: msg.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // only a page of this site, whatever the message says
  const asked = new URL(String(event.notification.data?.url ?? REMINDER.url), self.location.origin);
  const url = asked.origin === self.location.origin ? asked.href : new URL(REMINDER.url, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const here = open.find((c) => new URL(c.url).origin === self.location.origin);
      if (!here) {
        await self.clients.openWindow(url);
        return;
      }
      await here.focus();
      await here.navigate(url).catch(() => undefined); // a page the worker doesn't control yet just comes forward
    })(),
  );
});
