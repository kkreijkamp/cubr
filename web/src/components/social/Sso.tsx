// Sign-in with Google, Apple and GitHub, browser side: the buttons, the messages, and the redirect to
// the provider. The server does the OAuth flow (services/auth/src/routes/oauth.ts) and sends the
// browser back to /login/sso (pages/SsoPage.tsx) or, after connecting a provider, to /account.
import { useEffect, useState } from 'react';
import { isProviderName, ProviderIcon, PROVIDER_NAMES } from '../ProviderIcon';
import { Spinner } from '../Spinner';
import { api, ApiError } from '../../lib/api';
import type { OAuthProvider } from '../../lib/types';

let providersCache: Promise<OAuthProvider[]> | null = null;

/** The providers this server has set up (none until their keys are in place). */
export function useProviders(): OAuthProvider[] {
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  useEffect(() => {
    let alive = true;
    providersCache ??= api.auth.oauth.providers().then(
      (r) => r.providers,
      () => {
        providersCache = null; // offline or down: try again next time
        return [];
      },
    );
    void providersCache.then((p) => alive && setProviders(p));
    return () => {
      alive = false;
    };
  }, []);
  return providers;
}

/** Why a sign-in with a provider didn't work (the `error` the server sends back). */
export function ssoErrorMessage(error: string | null, provider: string | null): string {
  const name = isProviderName(provider) ? PROVIDER_NAMES[provider] : 'the provider';
  switch (error) {
    case 'cancelled':
      return `sign-in with ${name} was cancelled.`;
    case 'expired':
      return 'that sign-in took too long, or was finished in another browser. please try again.';
    case 'no_email':
      return `your ${name} account has no verified email address. cubr needs one, for password resets.`;
    case 'email_taken':
      return `an account already uses the email of that ${name} account. sign in with your password, then connect ${name} on your account page.`;
    case 'linked_elsewhere':
      return `that ${name} account is already connected to another cubr account.`;
    case 'already_linked':
      return `your account is already connected to a different ${name} account. disconnect it first.`;
    case 'busy':
      return 'too many sign-in attempts. please wait a few minutes.';
    case 'suspended':
      return 'this account is suspended. questions: hello@cubr.dev';
    default:
      return `sign-in with ${name} didn't work. please try again.`;
  }
}

/** Sends the browser to the provider's sign-in page (rejects if the server says no). */
export async function goToProvider(provider: OAuthProvider, mode: 'signin' | 'link', next?: string): Promise<void> {
  const { url } = await api.auth.oauth.start(provider, mode, next);
  window.location.assign(url);
}

/** "continue with Google / Apple / GitHub", or nothing when no provider is set up. */
export function SsoButtons({ next }: { next: string }) {
  const providers = useProviders();
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!providers.length) return null;
  const go = async (provider: OAuthProvider) => {
    setBusy(provider);
    setError(null);
    try {
      await goToProvider(provider, 'signin', next);
    } catch (err) {
      setBusy(null);
      setError(err instanceof ApiError && err.status === 429 ? ssoErrorMessage('busy', provider) : ssoErrorMessage('failed', provider));
    }
  };
  return (
    <div className="lg-sso">
      {providers.map((p) => (
        <button key={p} type="button" className="btn block lg-sso-btn" onClick={() => void go(p)} disabled={busy !== null}>
          {busy === p ? <Spinner size={16} /> : <ProviderIcon provider={p} />}
          continue with {PROVIDER_NAMES[p]}
        </button>
      ))}
      {error && (
        <div className="lg-sso-error" role="alert">
          {error}
        </div>
      )}
      <div className="lg-or" aria-hidden="true">
        <span>or</span>
      </div>
    </div>
  );
}
