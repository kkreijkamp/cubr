// Front-end error reports: an uncaught error or unhandled promise rejection in the app goes to
// POST /api/errors (the auth service), which only logs it. Nothing in a report identifies a person:
// the page's pattern instead of its address, a coarse browser name, and the error with
// personal-looking text taken out (the server scrubs again). SPEC 10.5; the privacy policy says so.
import { isChunkLoadError } from './chunkReload';

export interface ErrorReport {
  kind: 'error' | 'unhandledrejection';
  message: string;
  stack?: string;
  /** file:line:column of the throw */
  source?: string;
  /** the page's route pattern, e.g. /profile/:username */
  route: string;
  /** the running code's entry file, e.g. index-D3oOLUDV.js: names the exact build */
  build?: string;
  /** e.g. "Safari 18 on iOS" */
  browser?: string;
  /** opened as the installed app */
  installed?: boolean;
}

export const ERROR_REPORT_URL = '/api/errors';
/** reports one page load sends at most (a broken render can throw in a loop) */
export const MAX_REPORTS_PER_PAGE = 5;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const URL_EXTRA = /(\bhttps?:\/\/[^\s?#"'`)]+)[?#][^\s"'`)]*/g;
const LONG_SECRET = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g;
// a username or room id in a path ("Route GET /api/users/koen not found")
const PERSON_PATH = /(\/(?:users|profile|race|rooms)\/)(?!:)[^\s/?#"'`)]+/gi; // a :placeholder stays

/** Takes personal-looking text out: emails, tokens, query strings and fragments, usernames in paths, long ids. */
export function scrubText(text: string): string {
  return text.replace(EMAIL, '<email>').replace(JWT, '<token>').replace(URL_EXTRA, '$1').replace(PERSON_PATH, '$1:id').replace(LONG_SECRET, '<redacted>');
}

// the app's routes (App.tsx); the tests keep this list in step with it
const STATIC_ROUTES = new Set(['/', '/leaderboards', '/daily', '/race', '/account', '/settings', '/wca', '/about', '/login', '/login/sso', '/reset', '/confirm-email', '/terms', '/privacy']);

/** A path as its route's pattern: the page type, never a username or room id. Anything else is "(other)". */
export function routePattern(pathname: string): string {
  const path = (pathname.replace(/\/+$/, '') || '/').toLowerCase();
  if (STATIC_ROUTES.has(path)) return path;
  if (/^\/race\/[^/]+$/.test(path)) return '/race/:roomId';
  if (/^\/profile\/[^/]+$/.test(path)) return '/profile/:username';
  return '(other)';
}

/** The browser and system, coarsely ("Chrome 142 on Android"), from the user agent: never the string itself. */
export function browserName(ua: string, touchPoints = 0): string {
  const major = (re: RegExp) => re.exec(ua)?.[1];
  const named: [string, RegExp][] = [
    ['Edge', /\bEdg(?:A|iOS)?\/(\d+)/],
    ['Opera', /\bOPR\/(\d+)/],
    ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
    ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /\b(?:Chrome|CriOS)\/(\d+)/],
    ['Safari', /\bVersion\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//],
  ];
  const hit = named.find(([, re]) => major(re));
  const browser = hit ? `${hit[0]} ${major(hit[1])}` : 'another browser';
  const os = /iPhone|iPod/.test(ua)
    ? 'iOS'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1) // iPadOS asks for desktop pages as a Mac
      ? 'iPadOS'
      : /Android/.test(ua)
        ? 'Android'
        : /CrOS/.test(ua)
          ? 'ChromeOS'
          : /Macintosh|Mac OS X/.test(ua)
            ? 'macOS'
            : /Windows/.test(ua)
              ? 'Windows'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'another system';
  return `${browser} on ${os}`;
}

const EXTENSION = /\b(?:chrome|moz|safari(?:-web)?)-extension:\/\//;

/** Errors not worth a report: cross-origin "Script error.", extensions, other sites' scripts, a new release's missing chunks, aborted requests, ResizeObserver's warning. */
export function isNoise(message: string, error: unknown, filename: string | undefined, origin: string): boolean {
  if (/^Script error\.?$/.test(message) && !error) return true;
  if (filename && !filename.startsWith(origin) && !filename.startsWith('/')) return true;
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  if (EXTENSION.test(stack) || EXTENSION.test(filename ?? '')) return true;
  if (isChunkLoadError(error ?? message)) return true; // chunkReload.ts reloads the page instead
  if (error instanceof Error && error.name === 'AbortError') return true;
  return /ResizeObserver loop/.test(message);
}

export interface ReporterEnv {
  origin: string;
  pathname: () => string;
  userAgent: string;
  touchPoints: number;
  installed: () => boolean;
  /** the entry file of the running code */
  build?: string;
  send: (report: ErrorReport) => void;
}

/** The reporter's two handlers, with the page's limits: each distinct error once, at most MAX_REPORTS_PER_PAGE. */
export function createReporter(env: ReporterEnv) {
  const seen = new Set<string>();
  let sent = 0;

  const report = (kind: ErrorReport['kind'], error: unknown, message: string, source?: string) => {
    if (sent >= MAX_REPORTS_PER_PAGE) return;
    const key = `${kind}|${message}|${source ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    sent++;
    const stack = error instanceof Error && error.stack ? scrubText(error.stack).slice(0, 4000) : undefined;
    env.send({
      kind,
      message: scrubText(message).slice(0, 500) || '(no message)',
      ...(stack && { stack }),
      ...(source && { source: scrubText(source).slice(0, 300) }),
      route: routePattern(env.pathname()),
      ...(env.build && { build: env.build }),
      browser: browserName(env.userAgent, env.touchPoints),
      installed: env.installed(),
    });
  };

  return {
    onError(e: Pick<ErrorEvent, 'message' | 'error' | 'filename' | 'lineno' | 'colno'>) {
      const message = e.error instanceof Error ? e.error.message : String(e.message ?? '');
      if (isNoise(message, e.error, e.filename || undefined, env.origin)) return;
      report('error', e.error, message, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined);
    },
    onRejection(e: Pick<PromiseRejectionEvent, 'reason'>) {
      const r: unknown = e.reason;
      // something other than an Error or a string could hold anything: only its type is sent
      const message = r instanceof Error ? r.message : typeof r === 'string' ? r : `rejected with ${Object.prototype.toString.call(r)}`;
      if (isNoise(message, r, undefined, env.origin)) return;
      report('unhandledrejection', r, message);
    },
  };
}

/** Sends one report without holding anything up, even while the page closes. */
function send(report: ErrorReport): void {
  const body = JSON.stringify(report);
  try {
    if (navigator.sendBeacon?.(ERROR_REPORT_URL, new Blob([body], { type: 'application/json' }))) return;
  } catch {
    /* fall through to fetch */
  }
  fetch(ERROR_REPORT_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
}

/** Starts reporting (production builds only: in development the console shows errors). */
export function startErrorReports(): void {
  if (!import.meta.env.PROD) return;
  const reporter = createReporter({
    origin: location.origin,
    pathname: () => location.pathname,
    userAgent: navigator.userAgent,
    touchPoints: navigator.maxTouchPoints ?? 0,
    installed: () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
    build: new URL(import.meta.url).pathname.split('/').pop(),
    send,
  });
  window.addEventListener('error', (e) => reporter.onError(e));
  window.addEventListener('unhandledrejection', (e) => reporter.onRejection(e));
}
