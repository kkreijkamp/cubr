// Sign-in with Google, Apple and GitHub (the routes are in routes/oauth.ts). This module holds the
// providers' endpoints, their configuration from the environment, and the steps of the
// authorization-code flow that differ between them:
// - Google: OpenID Connect with PKCE; the ID token is checked against Google's published keys.
// - Apple: OpenID Connect, answered by a POST (response_mode=form_post); the client secret is a
//   short-lived JWT signed with the team's private key; the name only comes on the first sign-in.
// - GitHub: OAuth 2 with PKCE; the account and its verified email come from the REST API.
// Every endpoint can be overridden (e.g. GOOGLE_TOKEN_URL) so tests can use a fake provider.
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTPayload } from 'jose';

export const PROVIDERS = ['google', 'apple', 'github'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_NAMES: Record<Provider, string> = { google: 'Google', apple: 'Apple', github: 'GitHub' };

export function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

interface Endpoints {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}
export interface GoogleConfig extends Endpoints {
  kind: 'google';
  clientSecret: string;
  jwksUrl: string;
  issuers: string[];
}
export interface AppleConfig extends Endpoints {
  kind: 'apple';
  teamId: string;
  keyId: string;
  /** the Sign in with Apple key (.p8, PKCS#8 PEM) */
  privateKey: string;
  jwksUrl: string;
  issuers: string[];
}
export interface GithubConfig extends Endpoints {
  kind: 'github';
  clientSecret: string;
  apiUrl: string;
}
export type ProviderConfig = GoogleConfig | AppleConfig | GithubConfig;

/** The providers whose credentials are set; the others are off (no button, 404). */
export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): Partial<Record<Provider, ProviderConfig>> {
  const v = (k: string) => (env[k] ?? '').trim();
  const out: Partial<Record<Provider, ProviderConfig>> = {};
  if (v('GOOGLE_CLIENT_ID') && v('GOOGLE_CLIENT_SECRET')) {
    out.google = {
      kind: 'google',
      clientId: v('GOOGLE_CLIENT_ID'),
      clientSecret: v('GOOGLE_CLIENT_SECRET'),
      authorizeUrl: v('GOOGLE_AUTH_URL') || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: v('GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com/token',
      jwksUrl: v('GOOGLE_JWKS_URL') || 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: v('GOOGLE_ISSUER') ? [v('GOOGLE_ISSUER')] : ['https://accounts.google.com', 'accounts.google.com'],
      scope: 'openid email profile',
    };
  }
  if (v('APPLE_CLIENT_ID') && v('APPLE_TEAM_ID') && v('APPLE_KEY_ID') && v('APPLE_PRIVATE_KEY')) {
    out.apple = {
      kind: 'apple',
      clientId: v('APPLE_CLIENT_ID'),
      teamId: v('APPLE_TEAM_ID'),
      keyId: v('APPLE_KEY_ID'),
      // one line in .env: the PEM's line breaks written as \n
      privateKey: v('APPLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
      authorizeUrl: v('APPLE_AUTH_URL') || 'https://appleid.apple.com/auth/authorize',
      tokenUrl: v('APPLE_TOKEN_URL') || 'https://appleid.apple.com/auth/token',
      jwksUrl: v('APPLE_JWKS_URL') || 'https://appleid.apple.com/auth/keys',
      issuers: [v('APPLE_ISSUER') || 'https://appleid.apple.com'],
      scope: 'name email',
    };
  }
  if (v('GITHUB_CLIENT_ID') && v('GITHUB_CLIENT_SECRET')) {
    out.github = {
      kind: 'github',
      clientId: v('GITHUB_CLIENT_ID'),
      clientSecret: v('GITHUB_CLIENT_SECRET'),
      authorizeUrl: v('GITHUB_AUTH_URL') || 'https://github.com/login/oauth/authorize',
      tokenUrl: v('GITHUB_TOKEN_URL') || 'https://github.com/login/oauth/access_token',
      apiUrl: (v('GITHUB_API_URL') || 'https://api.github.com').replace(/\/$/, ''),
      scope: 'read:user user:email',
    };
  }
  return out;
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** PKCE (RFC 7636, S256): the verifier stays on the server, the challenge goes to the provider. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The provider's sign-in page for one flow. */
export function authorizeUrl(cfg: ProviderConfig, p: { redirectUri: string; state: string; nonce: string; challenge: string }): string {
  const url = new URL(cfg.authorizeUrl);
  const q = url.searchParams;
  q.set('client_id', cfg.clientId);
  q.set('redirect_uri', p.redirectUri);
  q.set('response_type', 'code');
  q.set('scope', cfg.scope);
  q.set('state', p.state);
  if (cfg.kind !== 'github') q.set('nonce', p.nonce); // OpenID Connect: echoed in the ID token
  if (cfg.kind !== 'apple') {
    q.set('code_challenge', p.challenge);
    q.set('code_challenge_method', 'S256');
  }
  if (cfg.kind === 'apple') q.set('response_mode', 'form_post'); // required when asking for the name or email
  if (cfg.kind === 'google') q.set('prompt', 'select_account');
  return url.toString();
}

/** Who signed in, as the provider says (only a verified email counts). */
export interface ProviderIdentity {
  /** the provider's stable id for the account */
  subject: string;
  email: string | null;
  name: string | null;
  /** GitHub's username: a good first guess for the cubr one */
  login: string | null;
}

export class OAuthError extends Error {
  constructor(
    readonly reason: 'token' | 'id_token' | 'profile',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 10_000;

async function postForm(fetchImpl: Fetch, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.error === 'string') {
    throw new OAuthError('token', `token endpoint: HTTP ${res.status} ${typeof body.error === 'string' ? body.error : ''}`.trim());
  }
  return body;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function keySet(url: string) {
  let set = keySets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { timeoutDuration: 5000 });
    keySets.set(url, set);
  }
  return set;
}

/** Checks an ID token's signature, issuer, audience, expiry and nonce. */
async function verifyIdToken(cfg: GoogleConfig | AppleConfig, idToken: unknown, nonce: string): Promise<JWTPayload> {
  if (typeof idToken !== 'string') throw new OAuthError('id_token', 'no id_token in the token response');
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, keySet(cfg.jwksUrl), { issuer: cfg.issuers, audience: cfg.clientId }));
  } catch (err) {
    throw new OAuthError('id_token', `id_token rejected: ${(err as Error).message}`);
  }
  if (payload.nonce !== nonce) throw new OAuthError('id_token', 'id_token nonce does not match');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new OAuthError('id_token', 'id_token without sub');
  return payload;
}

/** Apple's client secret: a JWT signed with the team's key (ES256), valid for a few minutes. */
export async function appleClientSecret(cfg: AppleConfig, now = Date.now()): Promise<string> {
  const key = await importPKCS8(cfg.privateKey, 'ES256');
  const iat = Math.floor(now / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: cfg.keyId })
    .setIssuer(cfg.teamId)
    .setSubject(cfg.clientId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(key);
}

/** "true" (Apple) or true (Google) */
const verified = (v: unknown) => v === true || v === 'true';
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Apple sends `user` (JSON) on the first sign-in only: {"name":{"firstName","lastName"},"email"} */
export function appleName(user: unknown): string | null {
  if (typeof user !== 'string') return null;
  try {
    const name = (JSON.parse(user) as { name?: { firstName?: unknown; lastName?: unknown } }).name;
    return str([str(name?.firstName), str(name?.lastName)].filter(Boolean).join(' '));
  } catch {
    return null;
  }
}

/** Exchanges the authorization code and returns the account it belongs to. */
export async function fetchIdentity(
  cfg: ProviderConfig,
  p: { code: string; redirectUri: string; verifier: string; nonce: string; appleUser?: unknown },
  fetchImpl: Fetch = fetch,
): Promise<ProviderIdentity> {
  if (cfg.kind === 'google') {
    const tokens = await postForm(fetchImpl, cfg.tokenUrl, {
      grant_type: 'authorization_code',
      code: p.code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
    });
    const claims = await verifyIdToken(cfg, tokens.id_token, p.nonce);
    return { subject: claims.sub!, email: verified(claims.email_verified) ? str(claims.email) : null, name: str(claims.name), login: null };
  }
  if (cfg.kind === 'apple') {
    const tokens = await postForm(fetchImpl, cfg.tokenUrl, {
      grant_type: 'authorization_code',
      code: p.code,
      client_id: cfg.clientId,
      client_secret: await appleClientSecret(cfg),
      redirect_uri: p.redirectUri,
    });
    const claims = await verifyIdToken(cfg, tokens.id_token, p.nonce);
    return { subject: claims.sub!, email: verified(claims.email_verified) ? str(claims.email) : null, name: appleName(p.appleUser), login: null };
  }
  const tokens = await postForm(fetchImpl, cfg.tokenUrl, {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  });
  const accessToken = str(tokens.access_token);
  if (!accessToken) throw new OAuthError('token', 'no access_token in the token response');
  const api = async (path: string) => {
    const res = await fetchImpl(`${cfg.apiUrl}${path}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'cubr' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new OAuthError('profile', `GitHub ${path}: HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  const user = (await api('/user')) as { id?: unknown; login?: unknown; name?: unknown };
  if (typeof user.id !== 'number' && typeof user.id !== 'string') throw new OAuthError('profile', 'GitHub /user without an id');
  const emails = (await api('/user/emails')) as { email?: unknown; primary?: unknown; verified?: unknown }[];
  const ok = Array.isArray(emails) ? emails.filter((e) => e.verified === true && str(e.email)) : [];
  const email = str((ok.find((e) => e.primary === true) ?? ok[0])?.email);
  return { subject: String(user.id), email, name: str(user.name), login: str(user.login) };
}

/**
 * A cubr username to suggest for a new account (3-20 of a-z, 0-9 and _), from the provider's
 * username, name or email. The caller checks it's free.
 */
export function suggestUsername(id: Pick<ProviderIdentity, 'login' | 'name' | 'email'>): string {
  const raw = id.login ?? id.name ?? id.email?.split('@')[0] ?? '';
  let s = raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // é -> e
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 20);
  if (s.length < 3) s = s ? `${s}_cuber`.slice(0, 20) : 'cuber';
  return s;
}

/** Candidates for a free name: the suggestion, then with 2, 3, ... appended (kept within 20). */
export function usernameCandidates(base: string, count = 50): string[] {
  const out = [base];
  for (let i = 2; out.length < count; i++) out.push(`${base.slice(0, 20 - String(i).length)}${i}`);
  return out;
}

/** One cookie's value from a Cookie header (null if absent). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A path inside cubr to return to after signing in (anything else becomes "/"). */
export function safeNext(v: unknown): string {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') && v.length <= 300 ? v : '/';
}
