import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { PrivateUser } from '../../lib/types';
import { Modal } from '../Modal';

const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * Changes the account's email (POST /api/auth/me/email): the new address gets a link, and nothing
 * changes until it's opened. The password is asked again; an account without one (made with Google,
 * Apple or GitHub) must have signed in in the last 10 minutes, so it's offered a fresh sign-in.
 */
export function ChangeEmailModal({ user, onSent, onClose }: { user: PrivateUser; onSent: (email: string) => void; onClose: () => void }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const needsPassword = user.hasPassword !== false;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [signInAgain, setSignInAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = looksLikeEmail(email.trim()) && (!needsPassword || password.length > 0);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.auth.changeEmail({ email: email.trim(), ...(needsPassword ? { password } : {}) });
      onSent(res.email);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && !needsPassword) setSignInAgain(true);
      else if (e instanceof ApiError && e.status === 403) setError('wrong password');
      else if (e instanceof ApiError && e.status === 409) setError('another account already uses that email');
      else setError(((e as Error).message || "couldn't change the email, try again").toLowerCase());
      setBusy(false);
    }
  };

  const reSignIn = async () => {
    await logout();
    navigate(`/login?next=${encodeURIComponent('/account')}`);
  };

  if (signInAgain) {
    return (
      <Modal title={user.emailReleased ? 'add an email' : 'change email'} onClose={onClose} center>
        <div className="stack">
          <div className="dialog-message">
            Your account signs in with Google or GitHub, so to keep it safe, sign in again first. Then change your email within 10 minutes.
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void reSignIn()}>
              sign in again
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={user.emailReleased ? 'add an email' : 'change email'} onClose={onClose} center>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-message">
          {user.emailReleased ? (
            <>We&apos;ll send a link to the address. Nothing changes until you open it.</>
          ) : (
            <>
              We&apos;ll send a link to the new address. Your email stays <span className="main">{user.email}</span> until you open it.
            </>
          )}
        </div>
        <div className="field">
          <label htmlFor="change-email-new">new email</label>
          <input
            id="change-email-new"
            type="email"
            autoComplete="email"
            autoFocus
            maxLength={254}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
          />
        </div>
        {needsPassword && (
          <div className="field">
            <label htmlFor="change-email-password">your password</label>
            <input
              id="change-email-password"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
            />
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="btn primary" disabled={!ready || busy}>
            {busy ? 'sending...' : 'send link'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
