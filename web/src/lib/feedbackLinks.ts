// The footer's feedback popup (components/FeedbackModal.tsx) offers an email or a GitHub issue. Both end
// with one line of what helps track a bug down: cubr's version, the browser, whether it's the installed app,
// the window's size and the page. People see it in their mail app or on GitHub before sending, and can edit it.
import { CONTACT_EMAIL, REPO_URL } from './links';

// The first match wins: Edge, Opera and Samsung Internet also say "Chrome/", and every iOS browser says "Safari/".
const BROWSERS: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ['Edge', /\b(?:Edg|EdgA|EdgiOS)\/(\d+)/],
  ['Opera', /\b(?:OPR|OPT|OPiOS)\/(\d+)/],
  ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /\b(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /\bVersion\/(\d+(?:\.\d+)?).*\bSafari\//],
];

/** The system, without a version: browsers freeze it in the user agent (macOS at 10.15.7, Chrome's Android
 *  at 10), so it would often be wrong. On iOS, Safari's own version is the system's. */
function systemOf(ua: string, maxTouchPoints: number): string | null {
  if (/\b(?:iPhone|iPod)\b/.test(ua)) return 'iOS';
  // iPads ask for desktop pages and say "Macintosh", but a Mac has no touch screen
  if (/\biPad\b/.test(ua) || (/\bMacintosh\b/.test(ua) && maxTouchPoints > 1)) return 'iPadOS';
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
  if (/\bWindows\b/.test(ua)) return 'Windows';
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';
  if (/\bLinux\b/.test(ua)) return 'Linux';
  return null;
}

/** "Chrome 142 on macOS", "Safari 26.1 on iOS": the browser's name and major version (Safari's minor too),
 *  and the system. A browser it doesn't know is given as its whole user agent. */
export function describeBrowser(ua: string, maxTouchPoints = 0): string {
  for (const [name, pattern] of BROWSERS) {
    const m = pattern.exec(ua);
    if (!m) continue;
    const system = systemOf(ua, maxTouchPoints);
    return `${name} ${m[1]}${system ? ` on ${system}` : ''}`;
  }
  return ua.trim().slice(0, 200) || 'unknown browser';
}

export interface FeedbackContext {
  /** the running version from `/_info`, as the footer shows it; null if it didn't answer */
  version: string | null;
  /** from describeBrowser */
  browser: string;
  /** opened as the installed app rather than in a browser tab */
  installed: boolean;
  /** the window, in CSS pixels */
  width: number;
  height: number;
  /** the path of the page it was opened on */
  page: string;
}

/** "cubr v1.6.3 · Chrome 142 on macOS · installed app · 1280×800 · /daily" */
export function feedbackDetails(c: FeedbackContext): string {
  const version = c.version === null ? 'cubr (version unknown)' : `cubr ${/^\d/.test(c.version) ? `v${c.version}` : c.version}`;
  return [version, c.browser, c.installed ? 'installed app' : null, `${Math.round(c.width)}×${Math.round(c.height)}`, c.page].filter(Boolean).join(' · ');
}

export const FEEDBACK_SUBJECT = 'cubr feedback';

/** An email to cubr's address: the subject, room to write, then the details below a signature line.
 *  Line breaks are CRLF and spaces %20, as mailto: links want them (RFC 6068). */
export function feedbackMailto(details: string): string {
  const body = `\n\n\n-- \n${details}`.replace(/\n/g, '\r\n');
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(FEEDBACK_SUBJECT)}&body=${encodeURIComponent(body)}`;
}

/** GitHub's form for a new issue, with room to write and the details as a quote at the end. The title is left
 *  to the person (GitHub asks for one). */
export function feedbackIssueUrl(details: string): string {
  return `${REPO_URL}/issues/new?body=${encodeURIComponent(`\n\n\n> ${details}`)}`;
}
