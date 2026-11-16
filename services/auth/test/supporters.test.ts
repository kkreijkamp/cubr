import { describe, expect, it } from 'vitest';
import { cleanSupporterName, kofiTokenMatches, parseKofiData, SUPPORTER_NAME_MAX } from '../src/supporters.js';

const TOKEN = 'abcdef00-1111-2222-3333-444444444444';
const NOW = new Date('2026-11-16T09:00:00.000Z');
const c = (cp: number) => String.fromCodePoint(cp);

const kofi = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    verification_token: TOKEN,
    message_id: 'b2c3d4e5-0000-4000-8000-000000000001',
    timestamp: '2026-11-16T08:30:00Z',
    type: 'Tip',
    is_public: true,
    from_name: 'Jo Example',
    message: 'keep it up!',
    amount: '5.00',
    url: 'https://ko-fi.com/Home/CoffeeShop?txid=1',
    email: 'jo@example.com',
    currency: 'AUD',
    is_subscription_payment: false,
    is_first_subscription_payment: false,
    kofi_transaction_id: '00000000-0000-0000-0000-000000000009',
    shop_items: null,
    tier_name: null,
    shipping: null,
    ...over,
  });

describe('parseKofiData', () => {
  it('keeps only the name, kind and time of a public tip', () => {
    expect(parseKofiData(kofi(), NOW)).toEqual({
      token: TOKEN,
      record: {
        messageId: 'b2c3d4e5-0000-4000-8000-000000000001',
        kind: 'Tip',
        name: 'Jo Example',
        isPublic: true,
        isSubscription: false,
        tier: null,
        receivedAt: '2026-11-16T08:30:00.000Z',
      },
    });
    const kept = JSON.stringify(parseKofiData(kofi(), NOW));
    for (const dropped of ['jo@example.com', '5.00', 'keep it up', 'txid']) expect(kept).not.toContain(dropped);
  });

  it('treats anything not marked public as anonymous', () => {
    expect(parseKofiData(kofi({ is_public: false }), NOW)?.record).toMatchObject({ name: null, isPublic: false });
    expect(parseKofiData(kofi({ is_public: 'true' }), NOW)?.record).toMatchObject({ name: null, isPublic: false });
    expect(parseKofiData(kofi({ is_public: undefined }), NOW)?.record.name).toBeNull();
  });

  it('recognises memberships', () => {
    expect(parseKofiData(kofi({ type: 'Subscription', is_subscription_payment: true, tier_name: 'Cuber' }), NOW)?.record).toMatchObject({
      kind: 'Subscription',
      isSubscription: true,
      tier: 'Cuber',
    });
  });

  it('needs a token and a message id, and valid JSON', () => {
    expect(parseKofiData(kofi({ verification_token: '' }), NOW)).toBeNull();
    expect(parseKofiData(kofi({ message_id: undefined }), NOW)).toBeNull();
    expect(parseKofiData('not json', NOW)).toBeNull();
    expect(parseKofiData('[1,2]', NOW)).toBeNull();
    expect(parseKofiData(undefined, NOW)).toBeNull();
  });

  it('falls back to now for a missing or bad timestamp', () => {
    expect(parseKofiData(kofi({ timestamp: 'yesterday' }), NOW)?.record.receivedAt).toBe(NOW.toISOString());
  });
});

describe('cleanSupporterName', () => {
  it('collapses whitespace and drops invisible and bidi-override characters', () => {
    expect(cleanSupporterName(`  Jo${c(0x09)}${c(0x0a)}Ex${c(0x200b)}ample  `)).toBe('Jo Example');
    expect(cleanSupporterName(`a${c(0x202e)}b${c(0x0)}c`)).toBe('abc');
    expect(cleanSupporterName(`${c(0x3000)}${c(0xa0)}`)).toBeNull();
  });
  it('keeps other scripts and emoji, capped by code point', () => {
    expect(cleanSupporterName('Łukasz 🧩')).toBe('Łukasz 🧩');
    expect([...(cleanSupporterName('🧩'.repeat(60)) ?? '')]).toHaveLength(SUPPORTER_NAME_MAX);
  });
  it('rejects non-strings and empty names', () => {
    expect(cleanSupporterName(42)).toBeNull();
    expect(cleanSupporterName('   ')).toBeNull();
  });
});

describe('kofiTokenMatches', () => {
  it('matches only the exact configured token', () => {
    expect(kofiTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(kofiTokenMatches(TOKEN, TOKEN.toUpperCase())).toBe(false);
    expect(kofiTokenMatches(TOKEN, TOKEN.slice(1))).toBe(false);
    expect(kofiTokenMatches('', '')).toBe(false);
  });
});
