import { useCallback, useEffect, useState } from 'react';
import { KeyIcon } from '@heroicons/react/24/outline';
import { isProviderName, ProviderIcon, PROVIDER_NAMES } from '../ProviderIcon';
import { Spinner } from '../Spinner';
import { goToProvider, ssoErrorMessage } from './Sso';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { OAuthProvider, SignInMethods as Methods } from '../../lib/types';

/**
 * The account page's "sign-in" row: how this account signs in, and connecting or disconnecting
 * Google, Apple and GitHub (only those the server has set up; no row when none is). Connecting goes
 * to the provider and comes back to /account#linked=<provider> (or #error=...).
 */
export function SignInMethods() {
  const [methods, setMethods] = useState<Methods | null>(null);
  const [busy, setBusy] = useState<OAuthProvider | null>(null);

  const load = useCallback(() => {
    api.auth.oauth.methods().then(setMethods, () => setMethods(null));
  }, []);

  useEffect(() => {
    // back from connecting a provider
    const back = new URLSearchParams(window.location.hash.slice(1));
    if (back.has('linked') || back.has('error')) {
      history.replaceState(history.state, '', window.location.pathname);
      const linked = back.get('linked');
      if (isProviderName(linked)) toast.success(`you can now sign in with ${PROVIDER_NAMES[linked]}`, { title: 'connected' });
      else toast.error(ssoErrorMessage(back.get('error'), back.get('provider')), { title: "couldn't connect" });
    }
    load();
  }, [load]);

  if (!methods || methods.providers.length === 0) return null;

  const connect = async (provider: OAuthProvider) => {
    setBusy(provider);
    try {
      await goToProvider(provider, 'link', '/account');
    } catch (err) {
      setBusy(null);
      toast.error(err instanceof ApiError ? err.message.toLowerCase() : ssoErrorMessage('failed', provider), { title: "couldn't connect" });
    }
  };
  const disconnect = async (provider: OAuthProvider) => {
    setBusy(provider);
    try {
      await api.auth.oauth.disconnect(provider);
      toast.notice(`${PROVIDER_NAMES[provider]} is disconnected`);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message.toLowerCase() : "couldn't disconnect, try again", { title: "couldn't disconnect" });
    } finally {
      setBusy(null);
    }
  };

  const ways = [
    ...(methods.password ? ['your password'] : []),
    ...methods.identities.map((i) => `${PROVIDER_NAMES[i.provider]}${i.email ? ` (${i.email})` : ''}`),
  ];
  return (
    <div className="ac-row">
      <div>
        <div className="t">
          <KeyIcon /> sign-in
        </div>
        <div className="d">
          you sign in with <span className="text">{ways.join(', ').replace(/, ([^,]*)$/, ' and $1') || 'nothing yet'}</span>.
          {!methods.password && <> no password yet: you can set one below.</>}
        </div>
      </div>
      <div className="ac-actions">
        {methods.providers.map((p) => {
          const linked = methods.identities.some((i) => i.provider === p);
          return (
            <button key={p} className={`btn${linked ? ' danger-text' : ''}`} onClick={() => void (linked ? disconnect(p) : connect(p))} disabled={busy !== null}>
              {busy === p ? <Spinner size={16} /> : <ProviderIcon provider={p} />} {linked ? 'disconnect' : 'connect'} {PROVIDER_NAMES[p]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
