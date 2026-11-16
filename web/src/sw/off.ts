/// <reference lib="webworker" />
// The emergency replacement for sw.ts, built instead of it with VITE_SW=off (see deploy/vps/README.md).
// Browsers find it on their next update check (every page load, as sw.js is never cached) and it
// removes cubr's service worker and caches, then reloads open pages from the network. The app built
// with VITE_SW=off doesn't register a worker either.
import { CACHE_PREFIX } from './policy';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX)) await caches.delete(name);
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: 'window' })) void client.navigate(client.url);
    })(),
  );
});
