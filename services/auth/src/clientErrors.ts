import { z } from 'zod';

/**
 * Front-end error reports (POST /api/errors): what a browser may send when the app hits an uncaught
 * error or an unhandled promise rejection (web/src/lib/errorReports.ts). They are only logged.
 * Nothing in them identifies a person: the app sends the route's pattern, never the address, a
 * coarse browser name, and the error itself with personal-looking text taken out. The server
 * scrubs again, because anyone can post anything here.
 */
export const CLIENT_ERROR_LIMITS = {
  /** reports one address may send per window (a page sends at most 5) */
  perIp: 30,
  perIpWindowSec: 600,
  /** reports from everyone together per window; past it they're dropped unlogged, so a flood can't fill the logs */
  total: 600,
  totalWindowSec: 3600,
  /** the request body */
  bodyBytes: 16 * 1024,
} as const;

export const clientErrorSchema = z
  .object({
    kind: z.enum(['error', 'unhandledrejection']),
    message: z.string().max(1000),
    stack: z.string().max(8000).optional(),
    /** file:line:column of the throw */
    source: z.string().max(500).optional(),
    /** the route's pattern, e.g. /profile/:username */
    route: z.string().max(100),
    /** the running code's entry file, e.g. index-D3oOLUDV.js: names the exact build */
    build: z.string().max(100).optional(),
    /** e.g. "Safari 18 on iOS" */
    browser: z.string().max(100).optional(),
    /** opened as the installed app */
    installed: z.boolean().optional(),
  })
  .strict();

export type ClientErrorReport = z.infer<typeof clientErrorSchema>;

// starts only where a run of address characters starts: tried from inside a long run, the search would
// take time growing with the square of its length (CodeQL's polynomial-ReDoS finding, 2026-11-26)
const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
// a URL's query string or fragment (tokens, ids, search terms); its address stays
const URL_EXTRA = /(\bhttps?:\/\/[^\s?#"'`)]+)[?#][^\s"'`)]*/g;
// keys, tokens and ids: 24+ letters and digits with at least one of each (a long function name in a
// stack has no digits, so it stays readable)
const LONG_SECRET = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g;
// a username or room id in a path ("Route GET /api/users/koen not found")
const PERSON_PATH = /(\/(?:users|profile|race|rooms)\/)(?!:)[^\s/?#"'`)]+/gi; // a :placeholder stays

/** Takes personal-looking text out of a report's free text: emails, tokens, query strings, usernames in paths, long ids. */
export function scrubText(text: string): string {
  return text.replace(EMAIL, '<email>').replace(JWT, '<token>').replace(URL_EXTRA, '$1').replace(PERSON_PATH, '$1:id').replace(LONG_SECRET, '<redacted>');
}

/** What gets logged: the report with its free text scrubbed and cut to size. */
export function scrubClientError(r: ClientErrorReport): ClientErrorReport {
  const cut = (s: string | undefined, max: number) => (s === undefined ? undefined : scrubText(s).slice(0, max));
  return {
    kind: r.kind,
    message: cut(r.message, 500)!,
    ...(r.stack !== undefined && { stack: cut(r.stack, 4000) }),
    ...(r.source !== undefined && { source: cut(r.source, 300) }),
    route: cut(r.route, 100)!,
    ...(r.build !== undefined && { build: cut(r.build, 100) }),
    ...(r.browser !== undefined && { browser: cut(r.browser, 100) }),
    ...(r.installed !== undefined && { installed: r.installed }),
  };
}
