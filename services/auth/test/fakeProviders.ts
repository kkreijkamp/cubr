// A fake Google, Apple and GitHub for the sign-in tests, on 127.0.0.1. It checks what the real ones
// check (client credentials, redirect URI, PKCE, Apple's signed client secret) and signs ID tokens
// with its own keys. Tests skip the provider's sign-in page: `issue()` makes the code the provider
// would have sent the browser back with.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT, type CryptoKey } from 'jose';

export interface Person {
  /** the provider's id for the account */
  sub: string;
  email?: string | null;
  emailVerified?: boolean;
  name?: string | null;
  /** GitHub only */
  login?: string;
  /** GitHub only: the account's email list (default: `email`, primary and verified) */
  emails?: { email: string; primary: boolean; verified: boolean }[];
}
/** What a broken provider (or an attacker) might send: the test checks cubr refuses it. */
export type Tamper = 'nonce' | 'audience' | 'issuer' | 'signature' | 'expired';

interface Grant {
  provider: 'google' | 'apple' | 'github';
  person: Person;
  nonce: string | null;
  challenge: string | null;
  redirectUri: string;
  tamper?: Tamper;
}

export const IDS = {
  google: { clientId: 'google-client-id', secret: 'google-client-secret', issuer: 'https://accounts.google.test' },
  apple: { clientId: 'dev.cubr.test.signin', teamId: 'TEAM123456', keyId: 'KEY1234567', issuer: 'https://appleid.apple.test' },
  github: { clientId: 'github-client-id', secret: 'github-client-secret' },
};

export class FakeProviders {
  url = '';
  private server: Server | null = null;
  private grants = new Map<string, Grant>();
  private githubTokens = new Map<string, Person>();
  private googleKey!: CryptoKey;
  private appleKey!: CryptoKey;
  private otherKey!: CryptoKey;
  private teamPublicKey!: CryptoKey;
  private jwks: Record<string, unknown> = {};
  /** the Sign in with Apple key cubr signs its client secret with (PKCS#8 PEM) */
  teamPrivateKeyPem = '';
  /** Apple client secrets that were refused (a test can check none were) */
  badAppleSecrets = 0;

  async start(): Promise<this> {
    const google = await generateKeyPair('RS256', { extractable: true });
    const apple = await generateKeyPair('ES256', { extractable: true });
    const other = await generateKeyPair('RS256', { extractable: true });
    const team = await generateKeyPair('ES256', { extractable: true });
    this.googleKey = google.privateKey;
    this.appleKey = apple.privateKey;
    this.otherKey = other.privateKey;
    this.teamPublicKey = team.publicKey;
    this.teamPrivateKeyPem = await exportPKCS8(team.privateKey);
    this.jwks = {
      google: { keys: [{ ...(await exportJWK(google.publicKey)), kid: 'g1', alg: 'RS256', use: 'sig' }] },
      apple: { keys: [{ ...(await exportJWK(apple.publicKey)), kid: 'a1', alg: 'ES256', use: 'sig' }] },
    };
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        this.handle(req.method ?? 'GET', new URL(req.url ?? '/', 'http://x'), req.headers, body).then(
          ([status, json]) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(json));
          },
          (err: Error) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'server_error', message: err.message }));
          },
        );
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** The environment that points cubr's auth service at this fake. */
  env(): Record<string, string> {
    const u = this.url;
    return {
      GOOGLE_CLIENT_ID: IDS.google.clientId,
      GOOGLE_CLIENT_SECRET: IDS.google.secret,
      GOOGLE_AUTH_URL: `${u}/google/authorize`,
      GOOGLE_TOKEN_URL: `${u}/google/token`,
      GOOGLE_JWKS_URL: `${u}/google/jwks`,
      GOOGLE_ISSUER: IDS.google.issuer,
      APPLE_CLIENT_ID: IDS.apple.clientId,
      APPLE_TEAM_ID: IDS.apple.teamId,
      APPLE_KEY_ID: IDS.apple.keyId,
      APPLE_PRIVATE_KEY: this.teamPrivateKeyPem.replace(/\n/g, '\\n'), // as it's written in .env
      APPLE_AUTH_URL: `${u}/apple/authorize`,
      APPLE_TOKEN_URL: `${u}/apple/token`,
      APPLE_JWKS_URL: `${u}/apple/jwks`,
      APPLE_ISSUER: IDS.apple.issuer,
      GITHUB_CLIENT_ID: IDS.github.clientId,
      GITHUB_CLIENT_SECRET: IDS.github.secret,
      GITHUB_AUTH_URL: `${u}/github/authorize`,
      GITHUB_TOKEN_URL: `${u}/github/token`,
      GITHUB_API_URL: `${u}/github/api`,
    };
  }

  /** The code the provider redirects back with, after `person` signed in on its page. */
  issue(provider: Grant['provider'], authorizeUrl: URL, person: Person, tamper?: Tamper): string {
    const code = randomBytes(16).toString('hex');
    const q = authorizeUrl.searchParams;
    this.grants.set(code, { provider, person, nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') ?? '', tamper });
    return code;
  }

  private async idToken(grant: Grant, issuer: string, audience: string, key: CryptoKey, kid: string, alg: string): Promise<string> {
    const t = grant.tamper;
    const p = grant.person;
    const claims: Record<string, unknown> = { email: p.email ?? undefined, email_verified: p.emailVerified ?? true, name: p.name ?? undefined, nonce: t === 'nonce' ? 'not-the-nonce' : grant.nonce };
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: t === 'signature' ? 'RS256' : alg, kid })
      .setIssuer(t === 'issuer' ? 'https://evil.test' : issuer)
      .setAudience(t === 'audience' ? 'someone-else' : audience)
      .setSubject(p.sub)
      .setIssuedAt(now - 600)
      .setExpirationTime(t === 'expired' ? now - 300 : now + 300)
      .sign(t === 'signature' ? this.otherKey : key);
  }

  private take(form: URLSearchParams, provider: Grant['provider']): Grant | string {
    const grant = this.grants.get(form.get('code') ?? '');
    if (!grant || grant.provider !== provider) return 'invalid_grant';
    this.grants.delete(form.get('code')!);
    if (form.get('redirect_uri') !== grant.redirectUri) return 'redirect_uri_mismatch';
    if (grant.challenge) {
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return 'invalid_pkce';
    }
    return grant;
  }

  private async handle(method: string, url: URL, headers: Record<string, unknown>, body: string): Promise<[number, unknown]> {
    const form = new URLSearchParams(body);
    switch (`${method} ${url.pathname}`) {
      case 'GET /google/jwks':
        return [200, this.jwks.google];
      case 'GET /apple/jwks':
        return [200, this.jwks.apple];
      case 'POST /google/token': {
        if (form.get('client_id') !== IDS.google.clientId || form.get('client_secret') !== IDS.google.secret) return [401, { error: 'invalid_client' }];
        const grant = this.take(form, 'google');
        if (typeof grant === 'string') return [400, { error: grant }];
        return [200, { access_token: 'ya29.x', id_token: await this.idToken(grant, IDS.google.issuer, IDS.google.clientId, this.googleKey, 'g1', 'RS256') }];
      }
      case 'POST /apple/token': {
        // Apple's client secret: an ES256 JWT from the team, with the key id
        try {
          const { protectedHeader } = await jwtVerify(form.get('client_secret') ?? '', this.teamPublicKey, {
            issuer: IDS.apple.teamId,
            subject: IDS.apple.clientId,
            audience: 'https://appleid.apple.com',
          });
          if (protectedHeader.kid !== IDS.apple.keyId || form.get('client_id') !== IDS.apple.clientId) throw new Error('kid or client');
        } catch {
          this.badAppleSecrets++;
          return [400, { error: 'invalid_client' }];
        }
        const grant = this.take(form, 'apple');
        if (typeof grant === 'string') return [400, { error: grant }];
        return [200, { access_token: 'a.x', id_token: await this.idToken(grant, IDS.apple.issuer, IDS.apple.clientId, this.appleKey, 'a1', 'ES256') }];
      }
      case 'POST /github/token': {
        if (form.get('client_id') !== IDS.github.clientId || form.get('client_secret') !== IDS.github.secret) return [200, { error: 'incorrect_client_credentials' }];
        const grant = this.take(form, 'github');
        if (typeof grant === 'string') return [200, { error: 'bad_verification_code' }]; // GitHub answers errors with 200
        const token = `gho_${randomBytes(8).toString('hex')}`;
        this.githubTokens.set(token, grant.person);
        return [200, { access_token: token, token_type: 'bearer', scope: 'read:user,user:email' }];
      }
      case 'GET /github/api/user':
      case 'GET /github/api/user/emails': {
        const person = this.githubTokens.get(String(headers.authorization ?? '').replace(/^Bearer /, ''));
        if (!person) return [401, { message: 'Bad credentials' }];
        if (url.pathname.endsWith('/emails')) return [200, person.emails ?? (person.email ? [{ email: person.email, primary: true, verified: true }] : [])];
        return [200, { id: Number(person.sub), login: person.login ?? 'octocat', name: person.name ?? null }];
      }
      default:
        return [404, { error: 'not_found' }];
    }
  }
}
