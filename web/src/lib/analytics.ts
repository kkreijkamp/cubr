// Cloudflare Web Analytics (docs/SPEC.md 10.3): counts page views and measures loading speed, without
// cookies or anything else stored in the browser (Cloudflare's description). The app adds the beacon
// itself rather than leaving it to Cloudflare's injection into pages it serves: the offline app opens
// from its cached copy of index.html, which never passes through Cloudflare, so returning visitors
// would go uncounted. The beacon follows the router's page changes on its own (History API).

/** Cloudflare's beacon script (allowed by the CSP, web/nginx/default.conf.template). */
export const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
/** cubr.dev's site in Cloudflare Web Analytics. Not a secret: it's in every page that loads the beacon. */
export const BEACON_TOKEN = '985dd88adbef4c4d8a02e90b17befc86';
/** Only the real site is measured, never the local stack or a preview. */
export const ANALYTICS_HOST = 'cubr.dev';

export interface MeasureEnv {
  hostname: string;
  /** Global Privacy Control (navigator.globalPrivacyControl) */
  globalPrivacyControl?: boolean;
  /** Do Not Track (navigator.doNotTrack: "1" when on) */
  doNotTrack?: string | null;
}

/** Whether to measure this visit: on cubr.dev itself, unless the browser asks not to be tracked. */
export function shouldMeasure(env: MeasureEnv): boolean {
  if (env.hostname !== ANALYTICS_HOST) return false;
  if (env.globalPrivacyControl === true) return false;
  return env.doNotTrack !== '1' && env.doNotTrack !== 'yes';
}

/** The parts of the page the beacon is added to (a narrow interface, so tests can stand in for it). */
export interface BeaconDoc {
  querySelector(selector: string): unknown;
  createElement(tag: 'script'): HTMLScriptElement;
  head: { append(el: HTMLScriptElement): void };
}

/**
 * Adds the beacon, once. Returns whether it did: not off cubr.dev, not when the browser asks not to be
 * tracked, and not when the page already has one (Cloudflare injects it into pages it serves while its
 * automatic setup is on).
 */
export function startAnalytics(doc: BeaconDoc = document, env: MeasureEnv = currentEnv()): boolean {
  if (!shouldMeasure(env)) return false;
  if (doc.querySelector('script[src*="static.cloudflareinsights.com"]')) return false;
  const script = doc.createElement('script');
  script.defer = true;
  script.src = BEACON_SRC;
  script.setAttribute('data-cf-beacon', JSON.stringify({ token: BEACON_TOKEN }));
  doc.head.append(script);
  return true;
}

function currentEnv(): MeasureEnv {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return { hostname: location.hostname, globalPrivacyControl: nav.globalPrivacyControl, doNotTrack: nav.doNotTrack };
}
