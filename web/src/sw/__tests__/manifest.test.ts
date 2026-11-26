import { describe, expect, it } from 'vitest';
import manifestText from '../../../public/manifest.webmanifest?raw';
import indexHtml from '../../../index.html?raw';
import { DEFAULT_DARK_THEME, DEFAULT_THEME, getTheme } from '../../lib/themes';
import { isAppPath } from '../policy';
import { HOME } from '../../lib/pageMeta';

interface Image {
  src: string;
  sizes: string;
  type?: string;
  purpose?: string;
  form_factor?: string;
}
const manifest = JSON.parse(manifestText) as {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  color_scheme_dark: { background_color: string; theme_color: string };
  icons: Image[];
  shortcuts: { name: string; url: string; icons: Image[] }[];
  screenshots: Image[];
};

// every PNG in public/, as data: URLs
const pngs = import.meta.glob<string>('../../../public/**/*.png', { query: '?inline', import: 'default', eager: true });

/** A PNG in public/, as bytes. */
function pngBytes(path: string): Uint8Array<ArrayBuffer> {
  const url = pngs[`../../../public${path}`];
  if (!url) throw new Error(`public${path} is missing`);
  return Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (ch) => ch.charCodeAt(0));
}

/** A PNG's width, height and whether it has an alpha channel (from its IHDR chunk). */
function png(path: string): { width: number; height: number; alpha: boolean } {
  const bytes = pngBytes(path);
  const view = new DataView(bytes.buffer);
  expect(String.fromCharCode(...bytes.slice(12, 16)), `${path} is a PNG`).toBe('IHDR');
  return { width: view.getUint32(16), height: view.getUint32(20), alpha: bytes[25] === 6 || bytes[25] === 4 };
}

/**
 * The colour of an 8-bit RGB PNG's top-left pixel, as #rrggbb. Only the start of the image data is
 * inflated: the first scanline's filter byte, then that pixel, which no filter changes (it has no
 * neighbours to predict it from).
 */
async function corner(path: string): Promise<string> {
  const bytes = pngBytes(path);
  expect([bytes[24], bytes[25]], `${path}: 8-bit RGB`).toEqual([8, 2]);
  const data: Uint8Array<ArrayBuffer>[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = new DataView(bytes.buffer).getUint32(at);
    if (String.fromCharCode(...bytes.slice(at + 4, at + 8)) === 'IDAT') data.push(bytes.slice(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const reader = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const chunk of data) controller.enqueue(chunk);
      controller.close();
    },
  })
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader();
  let head: number[] = [];
  while (head.length < 4) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`${path} has no image data`);
    head = [...head, ...value];
  }
  await reader.cancel();
  return `#${head
    .slice(1, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}
const declared = (img: Image) => img.sizes.split('x').map(Number);

describe('the web app manifest', () => {
  it('describes an installable app on the whole site', () => {
    expect(manifest).toMatchObject({ id: '/', name: 'cubr', short_name: 'cubr', start_url: '/', scope: '/', display: 'standalone' });
  });
  it('starts in the default theme, and in dark mode in the default dark theme', () => {
    expect(manifest.background_color).toBe(getTheme(DEFAULT_THEME).bg);
    expect(manifest.theme_color).toBe(getTheme(DEFAULT_THEME).bg);
    // the spec's dark colours (w3c/manifest#1207, April 2026); a browser that doesn't read them yet
    // ignores the member and keeps the light ones
    const dark = getTheme(DEFAULT_DARK_THEME).bg;
    expect(manifest.color_scheme_dark).toEqual({ background_color: dark, theme_color: dark });
  });
  it('has 192 and 512 px icons for every platform, each as large as it says', () => {
    for (const purpose of ['any', 'maskable']) {
      const sizes = manifest.icons.filter((i) => i.purpose === purpose).map((i) => i.sizes);
      expect(sizes, purpose).toEqual(expect.arrayContaining(['192x192', '512x512']));
    }
    for (const icon of manifest.icons) {
      const { width, height } = png(icon.src);
      expect([width, height], icon.src).toEqual(declared(icon));
      expect(icon.type).toBe('image/png');
    }
  });
  it('has full-bleed maskable icons (no transparency for the launcher to show)', () => {
    for (const icon of manifest.icons.filter((i) => i.purpose === 'maskable')) expect(png(icon.src).alpha, icon.src).toBe(false);
  });
  it("has shortcuts to the app's pages, with icons of at least 96 px", () => {
    expect(manifest.shortcuts.length).toBeGreaterThan(0);
    for (const s of manifest.shortcuts) {
      expect(isAppPath(s.url) && s.url.startsWith('/'), s.url).toBe(true);
      for (const icon of s.icons) {
        const { width, height } = png(icon.src);
        expect([width, height], icon.src).toEqual(declared(icon));
        expect(width).toBeGreaterThanOrEqual(96);
      }
    }
  });
  it("has screenshots that Chrome's install dialog accepts", () => {
    for (const form of ['wide', 'narrow'])
      expect(
        manifest.screenshots.some((s) => s.form_factor === form),
        form,
      ).toBe(true);
    const ratios = new Map<string, number>();
    for (const shot of manifest.screenshots) {
      const { width, height } = png(shot.src);
      expect([width, height], shot.src).toEqual(declared(shot));
      // 320 to 3840 px a side, at most 2.3 times as long as wide, one aspect ratio per form factor
      expect(Math.min(width, height)).toBeGreaterThanOrEqual(320);
      expect(Math.max(width, height)).toBeLessThanOrEqual(3840);
      expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(2.3);
      const ratio = width / height;
      expect(ratios.get(shot.form_factor ?? '') ?? ratio, shot.src).toBeCloseTo(ratio, 5);
      ratios.set(shot.form_factor ?? '', ratio);
    }
  });
});

describe('index.html', () => {
  it('links the manifest and the iOS home screen icon', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
  });
  it('has a 180 px iOS icon without transparency (iOS would show it black)', () => {
    expect(png('/apple-touch-icon.png')).toEqual({ width: 180, height: 180, alpha: false });
  });
});

describe('link previews (index.html)', () => {
  // the tests run without a DOM: read <meta property|name="key" content="..."> with a pattern
  const meta = (key: string) => indexHtml.match(new RegExp(`<meta (?:property|name)="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" content="([^"]*)"`))?.[1];
  it('read "cubr" and the home page\'s description, the one search engines show (lib/pageMeta.ts)', () => {
    expect(meta('og:title')).toBe('cubr');
    expect(meta('og:description')).toBe(HOME.description);
    expect(meta('description')).toBe(HOME.description);
    expect(meta('og:type')).toBe('website');
  });
  it('show the large image: an absolute https link, its real size, opaque (a transparent one shows black in some apps)', () => {
    const url = new URL(meta('og:image')!);
    expect(url.origin).toBe('https://cubr.dev');
    const { width, height, alpha } = png(url.pathname);
    expect([meta('og:image:width'), meta('og:image:height')]).toEqual([String(width), String(height)]);
    expect([width, height]).toEqual([1200, 630]);
    expect(alpha).toBe(false);
    expect(meta('og:image:type')).toBe('image/png');
    expect(meta('og:image:alt')).toBeTruthy();
    expect(meta('twitter:card')).toBe('summary_large_image');
  });
  it('have no og:url: one shared from any page must link back to that page, not the home page', () => {
    expect(meta('og:url')).toBeUndefined();
  });
});

describe('the iOS launch images', () => {
  const links = [...indexHtml.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)" \/>/g)].map((m) => ({ media: m[1], href: m[2] }));
  /** device-width, device-height, pixel ratio, orientation and light or dark mode from a link's media query */
  const screen = (media: string) => {
    const m =
      /^\(device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: (portrait|landscape)\) and \(prefers-color-scheme: (light|dark)\)$/.exec(
        media,
      );
    if (!m) throw new Error(`unexpected media query: ${media}`);
    return { width: Number(m[1]), height: Number(m[2]), ratio: Number(m[3]), orientation: m[4], mode: m[5] };
  };

  it('only work in a home-screen web app, which index.html declares', () => {
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(links.length).toBeGreaterThan(40);
  });

  it('match their screens exactly: points x pixel ratio, turned for landscape, opaque', () => {
    for (const { media, href } of links) {
      const s = screen(media);
      const { width, height, alpha } = png(href);
      const expected = s.orientation === 'portrait' ? [s.width * s.ratio, s.height * s.ratio] : [s.height * s.ratio, s.width * s.ratio];
      expect([width, height], href).toEqual(expected);
      expect(alpha, `${href}: iOS shows transparency as black`).toBe(false);
    }
  });

  it('cover both orientations of every screen once in each mode, and every image in public/launch is used', () => {
    const media = links.map((l) => l.media);
    expect(new Set(media).size).toBe(media.length);
    for (const m of media) {
      const { orientation, mode } = screen(m);
      const turned = orientation === 'portrait' ? 'landscape' : 'portrait';
      expect(media, `${m}, turned`).toContain(m.replace(`(orientation: ${orientation})`, `(orientation: ${turned})`));
      const other = mode === 'light' ? 'dark' : 'light';
      expect(media, `${m}, in ${other} mode`).toContain(m.replace(`(prefers-color-scheme: ${mode})`, `(prefers-color-scheme: ${other})`));
    }
    const files = Object.keys(pngs)
      .filter((f) => f.includes('/public/launch/'))
      .map((f) => f.slice(f.indexOf('/public/') + '/public'.length));
    expect(files.sort()).toEqual(links.map((l) => l.href).sort());
  });

  it('are the default theme in light mode and the default dark theme in dark mode, as the app starts in each', async () => {
    for (const { media, href } of links) {
      const theme = getTheme(screen(media).mode === 'dark' ? DEFAULT_DARK_THEME : DEFAULT_THEME);
      expect(await corner(href), href).toBe(theme.bg);
    }
  });

  it("include today's iPhones and iPads", () => {
    const screens = new Set(links.map((l) => screen(l.media)).map((s) => `${s.width}x${s.height}@${s.ratio}`));
    // iPhone 15 / 16, 16 Pro / 17 / 18 Pro, 16 Pro Max / 17 Pro Max / 18 Pro Max, Air, 16e / 17e, SE
    for (const s of ['393x852@3', '402x874@3', '440x956@3', '420x912@3', '390x844@3', '375x667@2']) expect(screens, s).toContain(s);
    // iPad (A16) / Air 11, Pro 11 and 13 (M4, M5), Air 13, mini
    for (const s of ['820x1180@2', '834x1210@2', '1032x1376@2', '1024x1366@2', '744x1133@2']) expect(screens, s).toContain(s);
  });
});
