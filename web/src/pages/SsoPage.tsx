// /login/sso: where sign-in with Google, Apple or GitHub lands. The server's redirect carries, in the
// fragment, a one-time code (an existing account: exchanged for a token), a sign-up id (a new account:
// pick a username first) or an error. The fragment is read once and cleared from the address bar.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ProviderIcon, PROVIDER_NAMES } from '../components/ProviderIcon';
import { Loading, Spinner } from '../components/Spinner';
import { ssoErrorMessage } from '../components/social/Sso';
import { safeNext } from '../components/social/util';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePageMeta } from '../lib/usePageMeta';
import type { OAuthProvider } from '../lib/types';
import '../components/social/login.css';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

type View = { kind: 'working' } | { kind: 'error'; message: string } | { kind: 'signup'; id: string; provider: OAuthProvider; email: string; username: string };

export default function SsoPage() {
  const { signInWithToken } = useAuth();
  const navigate = useNavigate();
  const [params] = useState(() => new URLSearchParams(window.location.hash.slice(1)));
  const next = safeNext(params.get('next'));
  const [view, setView] = useState<View>({ kind: 'working' });
  const started = useRef(false);

  usePageMeta({ title: 'signing in | cubr' });
  useEffect(() => {
    // the code is single-use and bound to this browser, but it needn't stay in the history either
    if (window.location.hash) history.replaceState(history.state, '', window.location.pathname);
    if (started.current) return; // React's strict mode runs effects twice in development
    started.current = true;
    const code = params.get('code');
    const signup = params.get('signup');
    if (code) {
      api.auth.oauth
        .exchange(code)
        .then(({ token, user }) => signInWithToken(token, user))
        .then(() => navigate(next, { replace: true }))
        .catch((err: unknown) =>
          setView({ kind: 'error', message: err instanceof ApiError && err.status === 404 ? 'that sign-in link has expired, or was opened in another browser. please sign in again.' : ssoErrorMessage('failed', null) }),
        );
    } else if (signup) {
      api.auth.oauth.signup(signup).then(
        (s) => setView({ kind: 'signup', id: signup, provider: s.provider, email: s.email, username: s.username ?? '' }),
        () => setView({ kind: 'error', message: 'this sign-up has expired, or was started in another browser. please start again.' }),
      );
    } else if (params.has('error')) {
      setView({ kind: 'error', message: ssoErrorMessage(params.get('error'), params.get('provider')) });
    } else {
      navigate('/login', { replace: true }); // nothing to finish (back on this page later, say)
    }
  }, []); // once, on arrival

  if (view.kind === 'working') return <Loading />;
  if (view.kind === 'error') {
    return (
      <div className="lg-page">
        <h1 className="lg-title">couldn&apos;t sign in</h1>
        <p className="lg-lede" role="alert">
          {view.message}
        </p>
        <Link to={`/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`} className="btn primary block">
          back to sign in
        </Link>
        <Link to="/" className="lg-guest">
          or keep timing as a guest
        </Link>
      </div>
    );
  }
  return <ChooseUsername {...view} onDone={(token, user) => signInWithToken(token, user).then(() => navigate(next, { replace: true }))} />;
}

/** A new account from a provider: everything is known but the (public) username. */
function ChooseUsername({ id, provider, email, username: suggested, onDone }: Extract<View, { kind: 'signup' }> & { onDone: (token: string, user: Awaited<ReturnType<typeof api.auth.oauth.completeSignup>>['user']) => Promise<void> }) {
  const [username, setUsername] = useState(suggested);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = USERNAME_RE.test(username.trim());

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) {
      setError('3-20 characters: letters, digits or _');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await api.auth.oauth.completeSignup(id, username.trim());
      await onDone(token, user);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 409) setError(err.message.toLowerCase().includes('username') ? 'that username is taken. try another.' : err.message.toLowerCase());
      else if (err instanceof ApiError && err.status === 404) setError('this sign-up has expired. please start again from the sign-in page.');
      else setError((err as Error).message || "couldn't create the account. please try again.");
    }
  };

  return (
    <div className="lg-page">
      <h1 className="lg-title">choose a username</h1>
      <p className="lg-lede">
        <ProviderIcon provider={provider} size={14} /> signing up with {PROVIDER_NAMES[provider]} as <span className="text">{email}</span>. your username is public: it&apos;s on
        your profile and the leaderboards.
      </p>
      <form className="lg-form" onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="lg-field">
          <div className="lg-input">
            <input
              name="username"
              placeholder="username"
              aria-label="username"
              autoComplete="username"
              autoFocus
              maxLength={20}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
              aria-invalid={error !== null}
            />
          </div>
          {error && <div className="lg-field-error">{error}</div>}
        </div>
        <button type="submit" className="btn primary block" disabled={busy}>
          {busy ? <Spinner size={16} /> : 'create account'}
        </button>
        <p className="lg-agree">
          by signing up you agree to the <Link to="/terms">terms</Link> and <Link to="/privacy">privacy policy</Link>.
        </p>
      </form>
    </div>
  );
}
