import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from 'jose';
import {
  appleClientSecret,
  appleName,
  authorizeUrl,
  loadOAuthConfig,
  pkce,
  readCookie,
  safeNext,
  suggestUsername,
  usernameCandidates,
  type AppleConfig,
} from '../src/oauth.js';
import { USERNAME_RE } from '../src/users.js';

describe('loadOAuthConfig', () => {
  it('turns on only the providers whose credentials are all set, with the real endpoints by default', () => {
    expect(loadOAuthConfig({})).toEqual({});
    const cfg = loadOAuthConfig({ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's', GITHUB_CLIENT_ID: 'h', APPLE_CLIENT_ID: 'a', APPLE_TEAM_ID: 't' });
    expect(Object.keys(cfg)).toEqual(['google']); // GitHub has no secret, Apple no key
    expect(cfg.google).toMatchObject({ tokenUrl: 'https://oauth2.googleapis.com/token', issuers: ['https://accounts.google.com', 'accounts.google.com'] });
  });
  it("reads Apple's key from one .env line with \\n for the line breaks", () => {
    const cfg = loadOAuthConfig({ APPLE_CLIENT_ID: 'a', APPLE_TEAM_ID: 't', APPLE_KEY_ID: 'k', APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----' });
    expect((cfg.apple as AppleConfig).privateKey).toBe('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
  });
});

describe('pkce', () => {
  it('makes a fresh verifier whose S256 hash is the challenge', () => {
    const a = pkce();
    const b = pkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'));
  });
});

describe('authorizeUrl', () => {
  const base = { clientId: 'cid', authorizeUrl: 'https://p.test/auth?existing=1', tokenUrl: '', scope: 's' };
  const p = { redirectUri: 'https://cubr.dev/cb', state: 'st', nonce: 'no', challenge: 'ch' };
  it('keeps the provider URL and adds the flow', () => {
    const q = new URL(authorizeUrl({ ...base, kind: 'google', clientSecret: '', jwksUrl: '', issuers: [] }, p)).searchParams;
    expect(Object.fromEntries(q)).toEqual({
      existing: '1',
      client_id: 'cid',
      redirect_uri: 'https://cubr.dev/cb',
      response_type: 'code',
      scope: 's',
      state: 'st',
      nonce: 'no',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
  });
});

describe('appleClientSecret', () => {
  it('is an ES256 JWT from the team for the Services ID, with the key id, valid for 5 minutes', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const cfg = { kind: 'apple', clientId: 'dev.cubr.signin', teamId: 'TEAM', keyId: 'KID', privateKey: await exportPKCS8(privateKey) } as AppleConfig;
    const jwt = await appleClientSecret(cfg, Date.UTC(2026, 10, 17));
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'ES256', kid: 'KID' });
    const claims = decodeJwt(jwt);
    expect(claims).toMatchObject({ iss: 'TEAM', sub: 'dev.cubr.signin', aud: 'https://appleid.apple.com' });
    expect(claims.exp! - claims.iat!).toBe(300);
  });
});

describe('appleName', () => {
  it("reads the name Apple sends on the first sign-in, and nothing otherwise", () => {
    expect(appleName(JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } }))).toBe('Ada Lovelace');
    expect(appleName(JSON.stringify({ name: { firstName: 'Ada' } }))).toBe('Ada');
    expect(appleName(undefined)).toBeNull();
    expect(appleName('{not json')).toBeNull();
  });
});

describe('suggestUsername', () => {
  it.each([
    [{ login: 'octocat', name: 'The Octocat', email: null }, 'octocat'],
    [{ login: 'Octo-Cat', name: null, email: null }, 'Octo_Cat'],
    [{ login: null, name: 'Zoë Speedcuber', email: null }, 'Zoe_Speedcuber'],
    [{ login: null, name: null, email: 'feliks.z+cubing@example.com' }, 'feliks_z_cubing'],
    [{ login: null, name: '张伟', email: 'zw@example.com' }, 'cuber'],
    [{ login: null, name: 'Al', email: null }, 'Al_cuber'],
    [{ login: null, name: null, email: null }, 'cuber'],
    [{ login: null, name: 'A Very Long Name Indeed For Sure', email: null }, 'A_Very_Long_Name_Ind'],
  ])('%j -> %s', (identity, expected) => {
    const s = suggestUsername(identity);
    expect(s).toBe(expected);
    expect(s).toMatch(USERNAME_RE);
  });
  it('offers numbered alternatives that stay valid', () => {
    const c = usernameCandidates('A_Very_Long_Name_Ind', 12);
    expect(c.slice(0, 3)).toEqual(['A_Very_Long_Name_Ind', 'A_Very_Long_Name_In2', 'A_Very_Long_Name_In3']);
    expect(c.at(-1)).toBe('A_Very_Long_Name_I12');
    for (const name of c) expect(name).toMatch(USERNAME_RE);
  });
});

describe('readCookie and safeNext', () => {
  it('reads one cookie out of the header', () => {
    expect(readCookie('a=1; cubr_oauth=abc; b=2', 'cubr_oauth')).toBe('abc');
    expect(readCookie('cubr_oauthx=abc', 'cubr_oauth')).toBeNull();
    expect(readCookie(undefined, 'cubr_oauth')).toBeNull();
    expect(readCookie('cubr_oauth=%E0%A4%A', 'cubr_oauth')).toBeNull();
  });
  it('returns only to a path inside cubr', () => {
    expect(safeNext('/daily?x=1')).toBe('/daily?x=1');
    for (const bad of ['https://evil.test', '//evil.test', '/\\evil.test', 'daily', 42, undefined, `/${'x'.repeat(400)}`]) expect(safeNext(bad)).toBe('/');
  });
});
