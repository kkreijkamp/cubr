import { describe, expect, it } from 'vitest';
import layoutSource from '../../components/Layout.tsx?raw';
import modalSource from '../../components/FeedbackModal.tsx?raw';
import { describeBrowser, FEEDBACK_SUBJECT, feedbackDetails, feedbackIssueUrl, feedbackMailto } from '../feedbackLinks';
import { CONTACT_EMAIL, REPO_URL } from '../links';

// The footer's feedback popup: an email or a GitHub issue, each ending with the details of the browser it came from.

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.7444.46 Mobile/15E148 Safari/604.1';
const IPHONE_FIREFOX =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/145.0 Mobile/15E148 Safari/605.1.15';
const IPAD_OLD = 'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const ANDROID_SAMSUNG = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36';
const ANDROID_FIREFOX = 'Mozilla/5.0 (Android 14; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0';
const WINDOWS_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0';
const WINDOWS_OPERA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0';
const WINDOWS_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0';
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0';
const CHROMEOS = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

describe('describeBrowser', () => {
  it('names the browser, its major version and the system', () => {
    expect(describeBrowser(MAC_CHROME)).toBe('Chrome 142 on macOS');
    expect(describeBrowser(ANDROID_CHROME)).toBe('Chrome 142 on Android');
    expect(describeBrowser(WINDOWS_FIREFOX)).toBe('Firefox 145 on Windows');
    expect(describeBrowser(ANDROID_FIREFOX)).toBe('Firefox 145 on Android');
    expect(describeBrowser(LINUX_FIREFOX)).toBe('Firefox 145 on Linux');
    expect(describeBrowser(CHROMEOS)).toBe('Chrome 142 on ChromeOS');
  });

  it("keeps Safari's minor version, which on iOS is the system's", () => {
    expect(describeBrowser(IPHONE_SAFARI)).toBe('Safari 26.1 on iOS');
    expect(describeBrowser(MAC_SAFARI)).toBe('Safari 26.1 on macOS');
    expect(describeBrowser(IPAD_OLD)).toBe('Safari 12.1 on iPadOS');
  });

  it('tells browsers built on Chrome or WebKit apart from them', () => {
    expect(describeBrowser(WINDOWS_EDGE)).toBe('Edge 142 on Windows');
    expect(describeBrowser(WINDOWS_OPERA)).toBe('Opera 125 on Windows');
    expect(describeBrowser(ANDROID_SAMSUNG)).toBe('Samsung Internet 29 on Android');
    expect(describeBrowser(IPHONE_CHROME)).toBe('Chrome 142 on iOS');
    expect(describeBrowser(IPHONE_FIREFOX)).toBe('Firefox 145 on iOS');
  });

  it('knows an iPad asking for the desktop page by its touch screen', () => {
    expect(describeBrowser(MAC_SAFARI, 5)).toBe('Safari 26.1 on iPadOS');
    expect(describeBrowser(MAC_SAFARI, 0)).toBe('Safari 26.1 on macOS');
  });

  it('gives an unknown browser as its user agent', () => {
    expect(describeBrowser('curl/8.7.1')).toBe('curl/8.7.1');
    expect(describeBrowser('x'.repeat(300))).toHaveLength(200);
    expect(describeBrowser('')).toBe('unknown browser');
  });
});

describe('feedbackDetails', () => {
  const base = { version: '1.6.3', browser: 'Chrome 142 on macOS', installed: false, width: 1280, height: 800, page: '/daily' };

  it('is one line: version, browser, installed or not, window and page', () => {
    expect(feedbackDetails(base)).toBe('cubr v1.6.3 · Chrome 142 on macOS · 1280×800 · /daily');
    expect(feedbackDetails({ ...base, installed: true })).toBe('cubr v1.6.3 · Chrome 142 on macOS · installed app · 1280×800 · /daily');
    expect(feedbackDetails({ ...base, width: 390.4, height: 843.6 })).toContain(' · 390×844 · ');
  });

  it('says when the version is unknown, and leaves a development build\'s "dev" as it is', () => {
    expect(feedbackDetails({ ...base, version: null })).toMatch(/^cubr \(version unknown\) · /);
    expect(feedbackDetails({ ...base, version: 'dev' })).toMatch(/^cubr dev · /);
  });
});

describe('the links', () => {
  const details = 'cubr v1.6.3 · Safari 26.1 on iOS · installed app · 390×844 · /race';

  it('emails cubr with the subject, room to write, and the details last', () => {
    const link = feedbackMailto(details);
    expect(link.startsWith(`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(FEEDBACK_SUBJECT)}&body=`)).toBe(true);
    const body = decodeURIComponent(link.slice(link.indexOf('&body=') + 6));
    expect(body).toBe(`\r\n\r\n\r\n-- \r\n${details}`);
    // RFC 6068: CRLF line breaks and %20 for spaces (a "+" would stay a "+" in the mail app)
    expect(body.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(link).not.toContain('+');
    expect(link).not.toContain(' ');
  });

  it("opens GitHub's new-issue form for the repo, with the details quoted last", () => {
    const link = feedbackIssueUrl(details);
    const url = new URL(link);
    expect(`${url.origin}${url.pathname}`).toBe(`${REPO_URL}/issues/new`);
    expect(url.searchParams.get('body')).toBe(`\n\n\n> ${details}`);
    expect([...url.searchParams.keys()]).toEqual(['body']);
  });
});

describe('the footer', () => {
  it('opens the popup from "feedback", where "contact" was', () => {
    expect(layoutSource).toMatch(/onClick=\{\(\) => setFeedbackOpen\(true\)\}[^>]*aria-haspopup="dialog"/);
    expect(layoutSource).toContain('<FeedbackModal ');
    expect(layoutSource).not.toContain('mailto:');
  });

  it('opens GitHub in a new tab without handing it the page', () => {
    expect(modalSource).toMatch(/href=\{feedbackIssueUrl\(details\)\} target="_blank" rel="noreferrer noopener"/);
  });

  it("gives the page's path only: reset, email-confirmation and sign-in links carry their tokens after the #", () => {
    expect(modalSource).toContain('const { pathname } = useLocation();');
    expect(modalSource).toContain('page: pathname,');
    expect(modalSource).not.toMatch(/\b(?:search|hash)\b|location\.href/);
  });
});
