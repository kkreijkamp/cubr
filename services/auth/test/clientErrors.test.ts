import { describe, expect, it } from 'vitest';
import { clientErrorSchema, scrubClientError, scrubText } from '../src/clientErrors.js';

const report = (over: Record<string, unknown> = {}) => ({
  kind: 'error',
  message: "Cannot read properties of undefined (reading 'ms')",
  stack: "TypeError: Cannot read properties of undefined (reading 'ms')\n    at Ab (https://cubr.dev/assets/index-D3oOLUDV.js:12:3456)",
  source: 'https://cubr.dev/assets/index-D3oOLUDV.js:12:3456',
  route: '/profile/:username',
  build: 'index-D3oOLUDV.js',
  browser: 'Safari 18 on iOS',
  installed: true,
  ...over,
});

describe('front-end error reports', () => {
  it('accept what the web app sends', () => {
    expect(clientErrorSchema.safeParse(report()).success).toBe(true);
    expect(clientErrorSchema.safeParse(report({ kind: 'unhandledrejection', stack: undefined, source: undefined })).success).toBe(true);
  });

  it.each([
    ['an unknown kind', { kind: 'warning' }],
    ['no message', { message: undefined }],
    ['no route', { route: undefined }],
    ['a message over 1,000 characters', { message: 'x'.repeat(1001) }],
    ['a stack over 8,000 characters', { stack: 'x'.repeat(8001) }],
    ['an extra field (an id, an email...)', { userId: 'u1' }],
    ['installed as text', { installed: 'yes' }],
  ])('refuse %s', (_label, over) => {
    expect(clientErrorSchema.safeParse(report(over)).success).toBe(false);
  });

  it('take emails, tokens, query strings, usernames in paths and long ids out of the free text', () => {
    expect(scrubText('failed for jo.example+cubr@mail.example.com')).toBe('failed for <email>');
    expect(scrubText('bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl here')).toBe('bad token <token> here');
    expect(scrubText('GET https://cubr.dev/reset?token=abc123&x=1 failed')).toBe('GET https://cubr.dev/reset failed');
    expect(scrubText('at https://cubr.dev/leaderboards#ao5')).toBe('at https://cubr.dev/leaderboards');
    expect(scrubText('session 3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b gone')).toBe('session <redacted> gone');
    expect(scrubText('key fakekey_9QxZ2aBcDeFgHiJkLmNoPqRsT')).toBe('key <redacted>');
    expect(scrubText('Route GET /api/users/koen_k not found')).toBe('Route GET /api/users/:id not found');
    expect(scrubText('at https://cubr.dev/profile/Koen and /race/ab12cd')).toBe('at https://cubr.dev/profile/:id and /race/:id');
    expect(scrubText('/profile/:username')).toBe('/profile/:username'); // a route pattern stays
  });

  it('scrub a long run of address characters in linear time', () => {
    // the old pattern took over a second on 50,000 characters (it tried every start inside the run)
    for (const run of ['a'.repeat(50_000), 'a.'.repeat(25_000)]) {
      const t0 = performance.now();
      expect(scrubText(`${run} koen@cubr.dev`)).toContain('<email>');
      expect(performance.now() - t0).toBeLessThan(250);
    }
    expect(scrubText('x a.b+c@d-e.co.uk y')).toBe('x <email> y');
  });

  it('leave a stack readable: asset names, line numbers and long function names stay', () => {
    const stack = 'at useSyncExternalStoreWithSelector (https://cubr.dev/assets/index-D3oOLUDV.js:12:3456)';
    expect(scrubText(stack)).toBe(stack);
  });

  it('log the scrubbed report, cut to size, with only the fields it was sent', () => {
    const r = scrubClientError(clientErrorSchema.parse(report({ message: `${'m'.repeat(600)} from x@y.io`, stack: undefined })));
    expect(r.message).toHaveLength(500);
    expect(r).not.toHaveProperty('stack');
    expect(r).toMatchObject({ kind: 'error', route: '/profile/:username', build: 'index-D3oOLUDV.js', browser: 'Safari 18 on iOS', installed: true });
    expect(scrubClientError(clientErrorSchema.parse(report({ message: 'from x@y.io' }))).message).toBe('from <email>');
  });
});
