// The installable app (PWA), page side. Registers the service worker (src/sw/sw.ts) in production
// builds and reports what it's doing: whether cubr works offline yet, and when a new version is ready.
// An update applies when the "update ready" notice is clicked, or on the next click on a link inside
// the app (that page loads fresh instead), never by itself: a running solve or race isn't reloaded.
// Also: the browser's install prompt (Chrome, Edge, Samsung Internet), keeping the data of an
// installed app, and opening an app shortcut's page in a window that is already open.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { createStore, useStore } from './store';
import { toast } from './toast';

export interface PwaState {
  /** off: no service worker (this browser, a dev build, or VITE_SW=off); saving: caching the app the
   *  first time; ready: the app opens and works offline */
  offline: 'off' | 'saving' | 'ready';
  /** a new version is downloaded and waits for a reload */
  update: boolean;
  /** the browser offers an install prompt that the page can open */
  canInstall: boolean;
  /** running as the installed app, in its own window */
  standalone: boolean;
}

/** Chrome's install prompt event (not in TypeScript's DOM types). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const ENABLED = import.meta.env.PROD && import.meta.env.VITE_SW !== 'off';
/** an installed app may stay open for days: look for a new version this often (and when it's brought back) */
const CHECK_EVERY_MS = 30 * 60_000;

function isStandalone(): boolean {
  if (typeof window === 'undefined' || typeof matchMedia !== 'function') return false;
  return ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].some((m) => matchMedia(`(display-mode: ${m})`).matches) || (navigator as { standalone?: boolean }).standalone === true;
}

export const pwaStore = createStore<PwaState>({ offline: 'off', update: false, canInstall: false, standalone: isStandalone() });
const patch = (p: Partial<PwaState>) => pwaStore.set((s) => ({ ...s, ...p }));

export function usePwa(): PwaState {
  return useStore(pwaStore);
}

let registration: ServiceWorkerRegistration | null = null;
let installPrompt: BeforeInstallPromptEvent | null = null;
let lastCheck = Date.now();
/** this page asked the waiting version to take over, and reloads (or opens `target`) once it has */
let applying = false;
let target: string | null = null;
let leaving = false;

function leave(): void {
  if (leaving) return;
  leaving = true;
  if (target) location.assign(target);
  else location.reload();
}

/** Switches to the downloaded version: reloads this page, or opens `href` instead (a clicked link). */
export function applyUpdate(href?: string): void {
  target = href ?? null;
  const waiting = registration?.waiting;
  if (!waiting) return leave(); // another tab switched already: the new version serves this load
  applying = true;
  waiting.postMessage({ type: 'SKIP_WAITING' });
  setTimeout(leave, 4000); // in case the switch never reports back
}

function updateReady(): void {
  if (pwaStore.get().update) return;
  patch({ update: true });
  toast.notice('a new version of cubr is ready - click to reload', { title: 'update ready', durationMs: 0, onClick: () => applyUpdate() });
}

/**
 * Looks for a new version now. "found": one is downloading (the notice follows once it's ready);
 * "none": this is the latest; "failed": offline, or no service worker.
 */
export async function checkForUpdate(): Promise<'found' | 'none' | 'failed'> {
  if (!registration) return 'failed';
  lastCheck = Date.now();
  try {
    await registration.update();
  } catch {
    return 'failed';
  }
  return registration.installing || registration.waiting ? 'found' : 'none';
}

function checkNow(): void {
  if (registration && Date.now() - lastCheck >= CHECK_EVERY_MS) void checkForUpdate();
}

function track(reg: ServiceWorkerRegistration): void {
  registration = reg;
  patch({ offline: reg.active ? 'ready' : 'saving' });
  if (reg.waiting && navigator.serviceWorker.controller) updateReady();
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    if (!worker) return;
    const first = !reg.active;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && !first) updateReady();
      else if (worker.state === 'activated') patch({ offline: 'ready' });
      else if (worker.state === 'redundant' && first && !reg.active) patch({ offline: 'off' }); // the first install failed
    });
  });
  void navigator.serviceWorker.ready.then(() => patch({ offline: 'ready' }));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkNow());
  window.addEventListener('online', checkNow);
  setInterval(checkNow, CHECK_EVERY_MS);
}

/** With an update waiting, a click on a link inside the app loads that page fresh, in the new version. */
function onLinkClick(e: MouseEvent): void {
  if (!pwaStore.get().update || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = (e.target as Element | null)?.closest?.('a[href]');
  if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
  e.preventDefault();
  e.stopPropagation(); // the router doesn't navigate in place
  applyUpdate(url.href);
}

/** Asks the browser to keep cubr's data (guest solves, the cached app) when space runs low. */
async function keepData(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}

function listenForInstall(): void {
  // the browser's own install UI stays (no preventDefault): the event only powers cubr's buttons
  window.addEventListener('beforeinstallprompt', (e) => {
    installPrompt = e as BeforeInstallPromptEvent;
    patch({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    patch({ canInstall: false });
    void keepData();
  });
  matchMedia('(display-mode: standalone)').addEventListener('change', () => patch({ standalone: isStandalone() }));
  if (isStandalone()) void keepData();
}

/**
 * How to install cubr when there's no prompt for the page to open: Safari and Firefox have none, and
 * Chrome only offers it after a little use of the page (or not at all once cubr is installed).
 */
export function installHint(): string {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'tap share, then add to home screen';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua)) return 'in safari: file, then add to dock';
  if (/Firefox\//.test(ua)) return /Android/.test(ua) ? "in firefox's menu: add to home screen" : "firefox can't install apps (chrome, edge and safari can)";
  return "use the install icon in the address bar, or the browser's menu";
}

/** Opens the browser's install prompt. True when cubr was installed. */
export async function promptInstall(): Promise<boolean> {
  const prompt = installPrompt;
  if (!prompt) return false;
  installPrompt = null; // a prompt opens once
  patch({ canInstall: false });
  await prompt.prompt();
  return (await prompt.userChoice).outcome === 'accepted';
}

/** Call once at start-up. */
export function startPwa(): void {
  if (typeof window === 'undefined') return;
  listenForInstall();
  if (!('serviceWorker' in navigator)) return;
  if (!ENABLED) {
    // no worker in this build: remove one an earlier build installed
    if (import.meta.env.PROD) void navigator.serviceWorker.getRegistrations().then((list) => list.forEach((r) => void r.unregister()));
    return;
  }
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const before = controlled;
    controlled = true;
    if (applying) leave();
    else if (before) updateReady(); // another tab switched to the new version; this one still runs the old one
    // else: the first install just took this page over - nothing changes for it
  });
  document.addEventListener('click', onLinkClick, true);
  const register = () =>
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(track)
      .catch(() => patch({ offline: 'off' }));
  // after the page has loaded, so caching the app doesn't compete with it
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}

/**
 * Opening an app shortcut (e.g. "daily challenge") while cubr's window is open focuses that window
 * (manifest: launch_handler focus-existing); this takes it to the shortcut's page. The app icon itself
 * (start_url "/") just brings the window back as it was.
 */
export function useLaunchQueue(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const queue = (window as { launchQueue?: { setConsumer(fn: (params: { targetURL?: string }) => void): void } }).launchQueue;
    queue?.setConsumer(({ targetURL }) => {
      if (!targetURL) return;
      const url = new URL(targetURL);
      const path = url.pathname + url.search;
      if (url.origin === location.origin && url.pathname !== '/' && path !== location.pathname + location.search) navigate(path);
    });
  }, [navigate]);
}
