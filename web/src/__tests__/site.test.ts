import { describe, expect, it } from 'vitest';
import webConf from '../../nginx/default.conf.template?raw';
import gatewayConf from '../../../deploy/gateway/nginx.conf?raw';
import indexHtml from '../../index.html?raw';
import appSource from '../App.tsx?raw';
import robotsTxt from '../../public/robots.txt?raw';
import sitemapXml from '../../public/sitemap.xml?raw';
import securityTxt from '../../public/.well-known/security.txt?raw';
import { BEACON_SRC } from '../lib/analytics';

// The web container's nginx config (web/nginx/default.conf.template) against the app it serves: which
// URLs are pages (200) and which are real 404s, the security headers, the crawler files. nginx's
// location and map matching is re-implemented below, small but faithful, so the tests check what
// nginx would do with a URL rather than how the config is spelled.

// ---- a tiny nginx config reader ------------------------------------------------------------------
interface Block {
  /** the words before the brace, e.g. ['location', '~*', '^/race/...'] */
  head: string[];
  body: string;
}

/** The top-level blocks inside `text` (strings and nested braces handled), plus what's outside them. */
function blocks(text: string): { blocks: Block[]; rest: string } {
  const out: Block[] = [];
  let rest = '';
  let i = 0;
  let stmt = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      stmt += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '{') {
      let depth = 1;
      let j = i + 1;
      while (depth > 0) {
        const d = text[j];
        if (d === '"' || d === "'") j = text.indexOf(d, j + 1);
        else if (d === '#' && /\s/.test(text[j - 1])) j = text.indexOf('\n', j);
        else if (d === '{') depth++;
        else if (d === '}') depth--;
        j++;
      }
      out.push({ head: words(stmt), body: text.slice(i + 1, j - 1) });
      stmt = '';
      i = j;
      continue;
    }
    stmt += c;
    if (c === ';') {
      rest += `${stmt}\n`;
      stmt = '';
    }
    i++;
  }
  return { blocks: out, rest };
}
const words = (s: string) => (s.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''));

interface Location {
  mod: '' | '=' | '~' | '~*' | '^~';
  pattern: string;
  body: string;
}
const top = blocks(webConf);
const server = top.blocks.find((b) => b.head[0] === 'server')!;
const inServer = blocks(server.body);
const locations: Location[] = inServer.blocks
  .filter((b) => b.head[0] === 'location')
  .map((b) => (b.head.length === 3 ? { mod: b.head[1] as Location['mod'], pattern: b.head[2], body: b.body } : { mod: '' as const, pattern: b.head[1], body: b.body }));

/** nginx's choice: an exact match, else the longest prefix if it has ^~, else the first matching regex, else the longest prefix. */
function locationFor(path: string): Location {
  const exact = locations.find((l) => l.mod === '=' && l.pattern === path);
  if (exact) return exact;
  const longest = locations.filter((l) => (l.mod === '' || l.mod === '^~') && path.startsWith(l.pattern)).sort((a, b) => b.pattern.length - a.pattern.length)[0];
  if (longest?.mod === '^~') return longest;
  return locations.find((l) => (l.mod === '~' || l.mod === '~*') && new RegExp(l.pattern, l.mod === '~*' ? 'i' : '').test(path)) ?? longest;
}
const isAppPage = (l: Location) => /try_files \/index\.html =404;/.test(l.body);
/** Where nginx redirects a path to (301), or '' when it serves it as it is (map $cubr_canonical). */
const redirectFor = (path: string) => mapLookup('$cubr_canonical', path);
const isFileOr404 = (l: Location) => /try_files \$uri =404;/.test(l.body) && /error_page 404 \/index\.html;/.test(l.body);

/** An nginx map: exact strings first, then regexes in order, then the default. */
function mapLookup(name: string, key: string): string {
  const map = top.blocks.find((b) => b.head[0] === 'map' && b.head[2] === name);
  if (!map) throw new Error(`no map ${name}`);
  const entries = map.body
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim()) // like nginx: # starts a comment only at the start of a word
    .filter(Boolean)
    .map((line) => words(line.replace(/;$/, '')));
  const exact = entries.find(([k]) => !k.startsWith('~') && k !== 'default' && k === key);
  if (exact) return exact[1];
  for (const [k, v] of entries) {
    if (!k.startsWith('~')) continue;
    const ci = k.startsWith('~*');
    const m = new RegExp(k.slice(ci ? 2 : 1), ci ? 'i' : '').exec(key);
    if (m) return v.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? ''); // $1... are the regex's captures
  }
  return entries.find(([k]) => k === 'default')?.[1] ?? '';
}

const serverHeaders = Object.fromEntries(
  [...inServer.rest.matchAll(/add_header\s+(\S+)\s+("[^"]*"|\S+)\s+always;/g)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')]),
);
const csp = Object.fromEntries(
  serverHeaders['Content-Security-Policy']
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .map(([name, ...values]) => [name, values]),
);

// ---- the app's pages and real 404s ------------------------------------------------------------------
/** Every route of the router (src/App.tsx), with sample values for its parameters. */
const appPaths = [...appSource.matchAll(/\{ path: '([^']+)'/g)]
  .map((m) => m[1])
  .filter((p) => p !== '*')
  .map((p) => p.replace(':roomId', 'abcd1234').replace(':username', 'Koen_K'));

describe('the app\'s pages and real 404s', () => {
  it('reads every route of the router', () => {
    expect(appPaths).toEqual(expect.arrayContaining(['/', '/daily', '/leaderboards', '/race', '/race/abcd1234', '/profile/Koen_K', '/login/sso', '/privacy']));
    expect(appPaths.length).toBeGreaterThanOrEqual(15);
  });

  it('serves every route at its own address (200), without a redirect', () => {
    for (const p of appPaths) {
      expect(redirectFor(p), p).toBe('');
      expect(isAppPage(locationFor(p)), p).toBe(true);
    }
  });

  it('sends capitals and a trailing slash to the plain address (301), keeping a username\'s case', () => {
    expect(inServer.blocks.find((b) => b.head[0] === 'if' && b.head[1] === '($cubr_canonical)')?.body.trim()).toBe('return 301 $cubr_canonical$is_args$args;');
    for (const p of appPaths.filter((x) => x !== '/')) {
      // what the address is once fixed: the route's own spelling, with the name or room id as typed
      const plain = (v: string) => p.replace(/^(\/profile\/|\/race\/)(.+)$/i, (_, prefix: string) => `${prefix.toLowerCase()}${v.slice(prefix.length).replace(/\/$/, '')}`);
      for (const variant of [`${p}/`, p.toUpperCase(), `${p.toUpperCase()}/`, p.replace(/^\/./, (c) => c.toUpperCase())]) {
        const target = redirectFor(variant);
        expect(target, variant).toBe(/^\/(?:profile|race)\/./i.test(p) ? plain(variant) : p);
        // never a loop: the target is served as it is
        expect(redirectFor(target), `${variant} -> ${target}`).toBe('');
        expect(isAppPage(locationFor(target)), target).toBe(true);
      }
    }
    expect(redirectFor('/PROFILE/Koen_K/')).toBe('/profile/Koen_K');
    expect(redirectFor('/Race/abcd1234/')).toBe('/race/abcd1234');
  });

  it('never redirects the home page, the site\'s files or unknown paths', () => {
    for (const p of ['/', '/assets/index-D3oOLUDV.js', '/favicon.svg', '/robots.txt', '/sitemap.xml', '/.well-known/security.txt', '/launch/apple-launch-1179x2556.png', '/nope', '/ABOUTS', '/profile/a.b', '/race/ab']) {
      expect(redirectFor(p), p).toBe('');
    }
  });

  it('answers 404 (still showing the app\'s not-found page) for anything the router doesn\'t know', () => {
    for (const p of ['/nope', '/no/such/page', '/index', '/abouts', '/leaderboards/x', '/login/other', '/race/ab', '/race/abcd1234/x', '/race/' + 'a'.repeat(33), '/profile/ab', '/profile/a.b', '/profile/koen_k/extra', '/profile/' + 'a'.repeat(21), '/favicon.ico']) {
      const l = locationFor(p);
      expect(isAppPage(l), p).toBe(false);
      expect(isFileOr404(l), p).toBe(true);
    }
  });

  it('accepts exactly the usernames and room ids the services do (USERNAME_RE, ROOM_ID_RE)', () => {
    for (const name of ['abc', 'koen_k', 'A_1', 'x'.repeat(20)]) expect(isAppPage(locationFor(`/profile/${name}`)), name).toBe(true);
    for (const name of ['ab', 'x'.repeat(21), 'koen-k', 'kö']) expect(isAppPage(locationFor(`/profile/${name}`)), name).toBe(false);
    for (const id of ['abcd', 'u66mxv33', 'a'.repeat(32)]) expect(isAppPage(locationFor(`/race/${id}`)), id).toBe(true);
    for (const id of ['abc', 'a'.repeat(33), 'ab-cd', 'ab_cd']) expect(isAppPage(locationFor(`/race/${id}`)), id).toBe(false);
  });

  it('serves the site\'s files as files, and keeps the API, assets and icons plain 404s', () => {
    expect(isFileOr404(locationFor('/robots.txt'))).toBe(true);
    expect(isFileOr404(locationFor('/sitemap.xml'))).toBe(true);
    expect(locationFor('/.well-known/security.txt')).toMatchObject({ mod: '^~', pattern: '/.well-known/' });
    expect(locationFor('/security.txt').body).toMatch(/return 301 \/\.well-known\/security\.txt;/);
    expect(locationFor('/api/nope')).toMatchObject({ mod: '^~', pattern: '/api/' });
    expect(locationFor('/assets/index-abc.js')).toMatchObject({ pattern: '/assets/' });
    expect(locationFor('/icons/icon-512.png').pattern).toBe('^/(icons|screenshots)/');
    expect(locationFor('/sw.js')).toMatchObject({ mod: '=', pattern: '/sw.js' });
  });

  it('sends relative redirects (behind the gateway and Cloudflare nginx would get the scheme and port wrong)', () => {
    expect(inServer.rest).toMatch(/absolute_redirect off;/);
  });
});

// ---- headers ---------------------------------------------------------------------------------------
describe('security headers', () => {
  it('are set once, at server level, and no location sets its own (nginx would drop them all there)', () => {
    for (const l of locations) expect(l.body, `${l.mod} ${l.pattern}`).not.toMatch(/add_header/);
    expect(serverHeaders).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    });
  });

  it('allow only cubr.dev\'s own scripts, the inline theme script by its hash, and Cloudflare\'s analytics beacon', async () => {
    const inline = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(inline.length).toBeGreaterThan(0);
    const hashes = await Promise.all(
      inline.map(async (s) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))))}'`),
    );
    // a changed inline script needs its new hash here, or browsers block it (and the theme flashes)
    expect(csp['script-src']).toEqual(["'self'", ...hashes, 'https://static.cloudflareinsights.com']);
  });

  it('shut out plugins, <base>, framing and other sites\' forms', () => {
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'none'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(csp['worker-src']).toEqual(["'self'"]);
    // the race sockets, and Cloudflare Web Analytics' reports (lib/analytics.ts)
    expect(csp['connect-src']).toEqual(["'self'", 'wss://$host', 'https://cloudflareinsights.com']);
    for (const values of Object.values(csp)) expect(values).not.toContain("'unsafe-eval'");
  });

  it('allow exactly the analytics beacon the app loads (lib/analytics.ts)', () => {
    expect(csp['script-src']).toContain(new URL(BEACON_SRC).origin);
  });

  it('take stylesheets only from cubr.dev (no injected <style>), allowing inline style attributes alone', () => {
    // the 2D scramble net parses cubing.js's puzzle drawings, whose stickers carry style="fill:..."
    expect(csp['style-src']).toEqual(["'self'"]);
    expect(csp['style-src-attr']).toEqual(["'unsafe-inline'"]);
    expect(csp['style-src-elem']).toBeUndefined();
  });

  it('keep the browser features cubr uses (microphone, Bluetooth) and turn the rest off', () => {
    const policy = Object.fromEntries(serverHeaders['Permissions-Policy'].split(', ').map((p) => p.split('=')));
    expect(policy).toMatchObject({ microphone: '(self)', bluetooth: '(self)', camera: '()', geolocation: '()', payment: '()', usb: '()' });
  });

  it('cache hashed files for a year and everything else never without asking, errors included', () => {
    const cache = (status: number, uri: string) => mapLookup('$cubr_cache_control', `${status}:${uri}`);
    expect(serverHeaders['Cache-Control']).toBe('$cubr_cache_control');
    expect(cache(200, '/assets/index-abc.js')).toBe('public, max-age=31536000, immutable');
    expect(cache(304, '/assets/index-abc.js')).toBe('public, max-age=31536000, immutable');
    expect(cache(404, '/assets/index-abc.js')).toBe('no-cache'); // a chunk missing mid-rollout mustn't stick
    expect(cache(200, '/index.html')).toBe('no-cache');
    expect(cache(404, '/index.html')).toBe('no-cache');
    expect(cache(200, '/robots.txt')).toBe('public, max-age=3600');
    expect(cache(404, '/.well-known/nope')).toBe('no-cache');
    expect(cache(200, '/healthz')).toBe('no-store');
  });

  it('never say which container, version or internal address answered (web or gateway)', () => {
    for (const conf of [webConf, gatewayConf]) expect(conf).not.toMatch(/add_header\s+X-(?:Served-By|Service|Upstream)/i);
  });

  it('are left to the services and the web container by the gateway, which only adds them to its own answers', () => {
    const gwServer = blocks(blocks(blocks(gatewayConf).blocks.find((b) => b.head[0] === 'http')!.body).blocks.find((b) => b.head[0] === 'server')!.body);
    expect(gwServer.rest).not.toMatch(/add_header/); // it would add a second copy to every proxied answer
    for (const b of gwServer.blocks.filter((x) => /return (?:404|502|504)/.test(x.body))) expect(b.body, b.head.join(' ')).toMatch(/X-Content-Type-Options "nosniff"/);
  });
});

// ---- crawlers ----------------------------------------------------------------------------------------
const noindex = (path: string) => mapLookup('$cubr_robots', path) === 'noindex';

describe('for crawlers', () => {
  it('robots.txt lets them fetch everything public, the API included, and names the sitemap', () => {
    const lines = robotsTxt.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines).toEqual(['User-agent: *', 'Disallow: /internal/', 'Sitemap: https://cubr.dev/sitemap.xml']);
    // Google renders pages without whatever robots.txt blocks: the leaderboards, profiles, the daily
    // board and About load their content from the API
    for (const l of lines) expect(l).not.toMatch(/^Disallow: \/api/);
  });

  it('API answers (data, not pages) ask not to be listed, wherever they come from', () => {
    for (const p of ['/api/leaderboards', '/api/users/koen_k', '/api/nope', '/internal/x']) expect(noindex(p), p).toBe(true);
    expect(noindex('/apiary')).toBe(false);
  });

  it('personal and short-lived pages ask not to be listed, and the public ones don\'t', () => {
    for (const p of ['/account', '/settings', '/settings?tab=app', '/login', '/login/sso', '/reset', '/Account', '/race/abcd1234']) expect(noindex(p), p).toBe(true);
    for (const p of ['/', '/daily', '/leaderboards', '/race', '/race/', '/wca', '/about', '/profile/koen_k', '/loginx', '/terms', '/privacy']) expect(noindex(p), p).toBe(false);
  });

  it('the sitemap lists public pages of the app, each once, as absolute cubr.dev URLs', () => {
    expect(sitemapXml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(sitemapXml).toMatch(/<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(new Set(locs).size).toBe(locs.length);
    expect(locs).toContain('https://cubr.dev/');
    for (const loc of locs) {
      const url = new URL(loc);
      expect(url.origin, loc).toBe('https://cubr.dev');
      expect(isAppPage(locationFor(url.pathname)), `${loc} is a page of the app`).toBe(true);
      expect(noindex(url.pathname), `${loc} may be listed`).toBe(false);
    }
  });

  it('robots.txt never blocks a page that relies on noindex (a crawler has to fetch it to see that)', () => {
    const disallowed = robotsTxt.split('\n').filter((l) => l.startsWith('Disallow:')).map((l) => l.slice('Disallow:'.length).trim());
    for (const p of ['/account', '/settings', '/login', '/reset', '/race/abcd1234']) expect(disallowed.some((d) => p.startsWith(d)), p).toBe(false);
  });
});

describe('security.txt (RFC 9116)', () => {
  const fields = Object.fromEntries(
    securityTxt
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]),
  );

  it('has a contact, a language, its canonical address and the policy', () => {
    expect(fields).toMatchObject({
      Contact: 'mailto:hello@cubr.dev',
      'Preferred-Languages': 'en',
      Canonical: 'https://cubr.dev/.well-known/security.txt',
      Policy: 'https://github.com/kkreijkamp/cubr/blob/main/SECURITY.md',
    });
  });

  it('expires within a year, and more than 30 days from now (renew it when this fails)', () => {
    expect(fields.Expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
    const days = (Date.parse(fields.Expires) - Date.now()) / 86_400_000;
    expect(days, 'security.txt expires soon: move Expires up to a year ahead').toBeGreaterThan(30);
    expect(days).toBeLessThanOrEqual(366);
  });
});
