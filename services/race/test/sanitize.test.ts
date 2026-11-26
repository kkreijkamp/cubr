import { describe, expect, it } from 'vitest';
import {
  GUEST_ID_RE,
  ROOM_ID_RE,
  defaultGuestName,
  generateGuestId,
  newRoomId,
  randomId,
  sanitizeGuestId,
  sanitizeName,
  sanitizeText,
} from '../src/sanitize.js';

describe('ids', () => {
  it('randomId uses only [a-z0-9] and has the requested length', () => {
    for (let i = 0; i < 200; i++) expect(randomId(12)).toMatch(/^[a-z0-9]{12}$/);
  });

  it('room ids are 8 url-safe characters and unique enough', () => {
    const ids = new Set(Array.from({ length: 2000 }, newRoomId));
    expect(ids.size).toBe(2000);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]{8}$/);
      expect(ROOM_ID_RE.test(id)).toBe(true);
    }
  });

  it('generated guest ids pass validation', () => {
    for (let i = 0; i < 100; i++) expect(GUEST_ID_RE.test(generateGuestId())).toBe(true);
  });
});

describe('sanitizeGuestId', () => {
  it('accepts well-formed guest ids', () => {
    expect(sanitizeGuestId('guest-abc123')).toBe('guest-abc123');
    expect(sanitizeGuestId('guest-' + 'a'.repeat(24))).toBe('guest-' + 'a'.repeat(24));
  });

  it.each([
    undefined,
    null,
    42,
    {},
    '',
    'guest-',
    'guest-abc',
    'guest-ABCDEF',
    'guest-abc_123',
    'Guest-abcdef',
    'xguest-abcdef',
    'guest-abcdef ',
    'guest-' + 'a'.repeat(25),
    '00000000-0000-0000-0000-000000000000',
  ])('rejects %j', (raw) => {
    expect(sanitizeGuestId(raw)).toBeNull();
  });
});

describe('sanitizeText / sanitizeName', () => {
  it('trims and collapses whitespace', () => {
    expect(sanitizeText('  hello \n\t  world  ', 50)).toBe('hello world');
  });

  it('removes control and invisible formatting characters', () => {
    expect(sanitizeText('a\u0000b\u0007c', 50)).toBe('a b c');
    expect(sanitizeText('zero\u200bwidth\u202eevil', 50)).toBe('zero width evil');
  });

  it('caps length in code points without splitting emoji', () => {
    expect(sanitizeText('\u{1F9CA}'.repeat(30), 20)).toBe('\u{1F9CA}'.repeat(20));
    expect(Array.from(sanitizeText('x'.repeat(300), 200))).toHaveLength(200);
  });

  it('nickname falls back for empty / non-string input', () => {
    expect(sanitizeName('  Feliks  ', 'guest-ab12')).toBe('Feliks');
    expect(sanitizeName('   ', 'guest-ab12')).toBe('guest-ab12');
    expect(sanitizeName('\u200b\u200b', 'guest-ab12')).toBe('guest-ab12');
    expect(sanitizeName(undefined, 'guest-ab12')).toBe('guest-ab12');
    expect(sanitizeName(1234, 'guest-ab12')).toBe('guest-ab12');
    expect(sanitizeName('a'.repeat(50), 'x')).toBe('a'.repeat(20));
  });

  it("falls back for a name posing as the site's or with a word cubr doesn't allow", () => {
    expect(sanitizeName('admin', 'guest-ab12')).toBe('guest-ab12');
    expect(sanitizeName('Cubr Official', 'guest-ab12')).toBe('guest-ab12');
    expect(sanitizeName('xX fuck Xx', 'guest-ab12')).toBe('guest-ab12');
    expect(sanitizeName('helpful cuber', 'guest-ab12')).toBe('helpful cuber');
  });

  it("keeps html as plain text (escaping is the renderer's job)", () => {
    expect(sanitizeName('<b>hi</b>', 'x')).toBe('<b>hi</b>');
  });

  it('default guest name uses the last 4 characters of the guest id', () => {
    expect(defaultGuestName('guest-abcdef1234')).toBe('guest-1234');
  });
});
