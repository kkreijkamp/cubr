import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { CHANGE_PASSWORD_URL, validatePassword } from '../../lib/password';
import type { PrivateUser } from '../../lib/types';
import { Modal } from '../Modal';
import { Spinner } from '../Spinner';

/**
 * Changes the password (POST /api/auth/me/password): the current one, then the new one. An account
 * without a password (made with Google, Apple or GitHub) sets its first instead, which needs a
 * sign-in in the last 10 minutes, so it's offered a fresh one (as for changing the email). Every
 * other device is signed out; this one carries on. Password managers open it through
 * /.well-known/change-password, so the fields say which password is which (autocomplete), and a
 * hidden username field tells them whose it is.
 */
export function ChangePasswordModal({ user, onDone, onClose }: { user: PrivateUser; onDone: () => void; onClose: () => void }) {
  const { changePassword, logout } = useAuth();
  const navigate = useNavigate();
  const hasPassword = user.hasPassword !== false;
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInAgain, setSignInAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const rule = validatePassword(password);
  // the rule shows as a hint, and as the error only once the form was sent (no nagging while typing)
  const showRule = submitted && rule;

  const submit = async () => {
    setSubmitted(true);
    if (busy || rule || (hasPassword && !current)) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(password, hasPassword ? current : undefined);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && !hasPassword) setSignInAgain(true);
      else if (e instanceof ApiError && e.status === 403) setError('wrong password');
      else if (e instanceof ApiError && e.status === 429) setError('too many attempts, try again later');
      else setError(((e as Error).message || "couldn't change the password, try again").toLowerCase());
      setBusy(false);
    }
  };

  const reSignIn = async () => {
    await logout();
    navigate(`/login?next=${encodeURIComponent(CHANGE_PASSWORD_URL)}`);
  };

  const title = hasPassword ? 'change password' : 'set a password';
  if (signInAgain) {
    return (
      <Modal title={title} onClose={onClose} center>
        <div className="stack">
          <div className="dialog-message">
            Your account signs in with Google or GitHub, so to keep it safe, sign in again first. Then set your password within 10 minutes.
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
    <Modal title={title} onClose={onClose} center>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <div className="dialog-message">
          {hasPassword
            ? "You'll stay signed in here and be signed out on every other device."
            : 'Then you can also sign in with your username or email. Every other device is signed out.'}
        </div>
        <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
        {hasPassword && (
          <div className="field">
            <label htmlFor="change-password-current">current password</label>
            <input
              id="change-password-current"
              name="current-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              maxLength={128}
              value={current}
              aria-invalid={submitted && !current}
              onChange={(e) => {
                setCurrent(e.target.value);
                setError(null);
              }}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="change-password-new">new password</label>
          <div className="pw-input">
            <input
              id="change-password-new"
              name="new-password"
              type={revealed ? 'text' : 'password'}
              autoComplete="new-password"
              autoFocus={!hasPassword}
              autoCapitalize="off"
              spellCheck={false}
              maxLength={128}
              value={password}
              aria-invalid={Boolean(showRule)}
              aria-describedby="change-password-rule"
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
            />
            <button
              type="button"
              className="pw-reveal btn-text"
              aria-label={revealed ? 'hide password' : 'show password'}
              aria-pressed={revealed}
              data-tip={revealed ? 'hide password' : 'show password'}
              onClick={() => setRevealed((r) => !r)}
            >
              {revealed ? <EyeSlashIcon /> : <EyeIcon />}
            </button>
          </div>
          <span id="change-password-rule" className={showRule ? 'error-text' : 'sub small'}>
            {showRule ? rule : 'at least 8 characters'}
          </span>
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || (submitted && Boolean(rule || (hasPassword && !current)))}>
            {busy && <Spinner size={16} />} {hasPassword ? 'change password' : 'set password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
