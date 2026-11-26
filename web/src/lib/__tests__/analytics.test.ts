import { describe, expect, it } from 'vitest';
import { ANALYTICS_HOST, BEACON_SRC, BEACON_TOKEN, shouldMeasure, startAnalytics, type BeaconDoc } from '../analytics';

/** A stand-in page: records the scripts added, and can already hold Cloudflare's injected one. */
function fakeDoc(alreadyInjected = false) {
  const added: { src: string; defer: boolean; attrs: Record<string, string> }[] = [];
  const doc: BeaconDoc = {
    querySelector: (sel) => (alreadyInjected && sel.includes('static.cloudflareinsights.com') ? {} : null),
    createElement: () => {
      const el = {
        src: '',
        defer: false,
        attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) {
          this.attrs[k] = v;
        },
      };
      return el as unknown as HTMLScriptElement;
    },
    head: { append: (el) => void added.push(el as unknown as (typeof added)[number]) },
  };
  return { doc, added };
}
const onSite = { hostname: ANALYTICS_HOST, globalPrivacyControl: undefined, doNotTrack: null };

describe('shouldMeasure', () => {
  it('measures visits to cubr.dev', () => {
    expect(shouldMeasure(onSite)).toBe(true);
    expect(shouldMeasure({ ...onSite, doNotTrack: '0' })).toBe(true);
    expect(shouldMeasure({ ...onSite, globalPrivacyControl: false })).toBe(true);
  });
  it('never measures the local stack, previews or other hosts', () => {
    for (const hostname of ['localhost', '127.0.0.1', 'www.cubr.dev', 'cubr.dev.evil.example', 'staging.cubr.dev'])
      expect(shouldMeasure({ ...onSite, hostname }), hostname).toBe(false);
  });
  it('respects Global Privacy Control and Do Not Track', () => {
    expect(shouldMeasure({ ...onSite, globalPrivacyControl: true })).toBe(false);
    expect(shouldMeasure({ ...onSite, doNotTrack: '1' })).toBe(false);
    expect(shouldMeasure({ ...onSite, doNotTrack: 'yes' })).toBe(false);
  });
});

describe('startAnalytics', () => {
  it("adds Cloudflare's beacon with cubr.dev's token, deferred", () => {
    const { doc, added } = fakeDoc();
    expect(startAnalytics(doc, onSite)).toBe(true);
    expect(added).toHaveLength(1);
    expect(added[0].src).toBe(BEACON_SRC);
    expect(added[0].defer).toBe(true);
    expect(JSON.parse(added[0].attrs['data-cf-beacon'])).toEqual({ token: BEACON_TOKEN });
  });
  it('adds nothing when Cloudflare already put the beacon in the page (no visit counted twice)', () => {
    const { doc, added } = fakeDoc(true);
    expect(startAnalytics(doc, onSite)).toBe(false);
    expect(added).toHaveLength(0);
  });
  it('adds nothing off cubr.dev or when the browser asks not to be tracked', () => {
    for (const env of [
      { ...onSite, hostname: 'localhost' },
      { ...onSite, globalPrivacyControl: true },
      { ...onSite, doNotTrack: '1' },
    ]) {
      const { doc, added } = fakeDoc();
      expect(startAnalytics(doc, env)).toBe(false);
      expect(added).toHaveLength(0);
    }
  });
});
