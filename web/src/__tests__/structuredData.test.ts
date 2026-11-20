import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import logoPng from '../../public/icons/icon-maskable-512.png?inline';
import { canonicalUrl } from '../lib/canonical';
import { DONATE_URL, REPO_URL } from '../lib/links';
import { HOME } from '../lib/pageMeta';

// index.html's JSON-LD: what search engines read for the site's name ("cubr") and its logo.

const blocks = [...indexHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]) as { '@context': string; '@graph': Record<string, unknown>[] });
const graph = blocks[0]?.['@graph'] ?? [];
const website = graph.find((n) => n['@type'] === 'WebSite') as Record<string, unknown>;
const org = graph.find((n) => n['@type'] === 'Organization') as Record<string, unknown> & { logo: { url: string; width: number; height: number }; sameAs: string[] };

/** A PNG's size and whether it has transparency, from its IHDR chunk. */
function png(dataUrl: string) {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20), alpha: bytes[25] === 6 || bytes[25] === 4 };
}

describe("the site's structured data", () => {
  it('is one valid JSON-LD block on schema.org, a data block the CSP leaves alone', () => {
    expect(blocks).toHaveLength(1);
    expect(blocks[0]['@context']).toBe('https://schema.org');
    // the CSP's script hashes cover only executable inline scripts; this one has a type, so it isn't one
    expect(indexHtml).toMatch(/<script type="application\/ld\+json">/);
  });

  it('names the site "cubr" at its home address, with cubr.dev as another name and the description the page has', () => {
    expect(website).toMatchObject({ '@id': 'https://cubr.dev/#website', url: canonicalUrl('/'), name: 'cubr', inLanguage: 'en' });
    expect(website.alternateName).toEqual(['cubr.dev']);
    const description = /<meta name="description" content="([^"]+)"/.exec(indexHtml)![1];
    expect(website.description).toBe(description);
    expect(description).toBe(HOME.description);
    expect(website.publisher).toEqual({ '@id': org['@id'] });
  });

  it("gives the organisation a logo search engines accept: on the site, at least 112 px, opaque, the size it says", () => {
    expect(org).toMatchObject({ '@id': 'https://cubr.dev/#organization', name: 'cubr', url: canonicalUrl('/') });
    expect(org.logo.url).toBe(canonicalUrl('/icons/icon-maskable-512.png'));
    const { width, height, alpha } = png(logoPng);
    expect([width, height]).toEqual([org.logo.width, org.logo.height]);
    expect(Math.min(width, height)).toBeGreaterThanOrEqual(112);
    expect(alpha).toBe(false); // looks the same on any background
  });

  it("links the organisation's own pages, the same ones the app links to", () => {
    expect(org.sameAs).toEqual([REPO_URL, DONATE_URL]);
  });
});
