import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import {
  CheckIcon,
  CloudArrowUpIcon,
  ExclamationCircleIcon,
  EyeIcon,
  EyeSlashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { Loading, Spinner } from '../components/Spinner';
import { safeNext } from '../components/social/util';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { localDataSummary } from '../lib/solves';
import { toast } from '../lib/toast';
import '../components/social/login.css';

// Mirrors the auth-service limits in docs/SPEC.md section 5.
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateUsername(v: string): string | null {
  if (!v) return 'pick a username';
  if (v.length < 3) return 'at least 3 characters';
  if (v.length > 20) return 'at most 20 characters';
  if (!USERNAME_RE.test(v)) return 'letters, numbers and _ only';
  return null;
}
function validateEmail(v: string): string | null {
  if (!v) return 'enter your email';
  if (v.length > 254 || !EMAIL_RE.test(v)) return 'that does not look like an email';
  return null;
}
function validatePassword(v: string): string | null {
  if (!v) return 'choose a password';
  if (v.length < 8) return 'at least 8 characters';
  if (v.length > 128) return 'at most 128 characters';
  return null;
}

/** Turns an auth API failure into a short message for the form. */
function describeAuthError(err: unknown, mode: 'login' | 'register'): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'too many attempts. wait a minute and try again.';
    if (err.status === 401 && mode === 'login') return 'incorrect username/email or password.';
    if (err.isUnavailable) return 'the auth service is unavailable right now. try again in a moment.';
    return err.message.charAt(0).toLowerCase() + err.message.slice(1);
  }
  return (err as Error)?.message || 'something went wrong';
}

type Mode = 'login' | 'register';

/** Focus a form's first field when it becomes the visible one (desktop only: on touch it would pop the keyboard). */
function useFocusWhenActive(active: boolean, ref: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    if (active && window.matchMedia?.('(pointer: fine)').matches) ref.current?.focus();
  }, [active, ref]);
}

interface FieldProps {
  type?: string;
  name: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  /** validation / server error */
  error: string | null;
  /** show validation state (after blur or submit) */
  show: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  maxLength?: number;
  /** password field with a show / hide toggle */
  revealable?: boolean;
}

function Field({ type = 'text', name, placeholder, value, onChange, autoComplete, error, show, inputRef, maxLength, revealable }: FieldProps) {
  const [touched, setTouched] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // nag about a field only after it was left non-empty, or once the form was submitted
  const visible = show || (touched && value.length > 0);
  const bad = visible && Boolean(error);
  const ok = visible && !error && value.length > 0;
  const errId = `${name}-error`;
  return (
    <div className="lg-field">
      <div className="lg-input">
        <input
          ref={inputRef}
          type={revealable && revealed ? 'text' : type}
          name={name}
          placeholder={placeholder}
          aria-label={placeholder}
          value={value}
          maxLength={maxLength}
          autoComplete={autoComplete}
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={bad}
          aria-describedby={bad ? errId : undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
        />
        {revealable ? (
          <button
            type="button"
            className="lg-reveal btn-text"
            aria-label={revealed ? 'hide password' : 'show password'}
            aria-pressed={revealed}
            data-tip={revealed ? 'hide password' : 'show password'}
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? <EyeSlashIcon /> : <EyeIcon />}
          </button>
        ) : (
          <>
            {bad && (
              <span className="lg-indicator bad" aria-hidden="true">
                <XMarkIcon width={16} height={16} />
              </span>
            )}
            {ok && (
              <span className="lg-indicator ok" aria-hidden="true">
                <CheckIcon width={16} height={16} />
              </span>
            )}
          </>
        )}
      </div>
      {bad && (
        <div className="lg-field-error" id={errId}>
          {error}
        </div>
      )}
    </div>
  );
}

function FormError({ children, shakeKey }: { children: ReactNode; shakeKey: number }) {
  return (
    <div key={shakeKey} className="lg-form-error shake" role="alert">
      <ExclamationCircleIcon width={15} height={15} />
      <span>{children}</span>
    </div>
  );
}

interface FormProps {
  active: boolean;
  /** focus the first field when shown (off while the tabs are driven by the keyboard) */
  focusFirst: boolean;
}

function RegisterForm({ active, focusFirst }: FormProps) {
  const { register } = useAuth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverField, setServerField] = useState<{ field: 'username' | 'email'; message: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  const usernameRef = useRef<HTMLInputElement>(null);
  useFocusWhenActive(active && focusFirst, usernameRef);

  const errors = {
    username: serverField?.field === 'username' ? serverField.message : validateUsername(username),
    email: serverField?.field === 'email' ? serverField.message : validateEmail(email),
    password: validatePassword(password),
  };
  const hasErrors = Object.values(errors).some(Boolean);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setFormError(null);
    if (hasErrors || busy) {
      setErrorTick((t) => t + 1);
      return;
    }
    setBusy(true);
    try {
      await register(username.trim(), email.trim(), password);
      toast.success(`welcome to cubr, ${username.trim()}!`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const field = /mail/i.test(err.message) ? 'email' : 'username';
        setServerField({ field, message: field === 'email' ? 'this email is already registered' : 'this username is taken' });
      } else {
        setFormError(describeAuthError(err, 'register'));
      }
      setErrorTick((t) => t + 1);
      setBusy(false);
    }
  };

  return (
    <form
      className="lg-form"
      id="lg-panel-register"
      role="tabpanel"
      aria-labelledby="lg-tab-register"
      hidden={!active}
      onSubmit={onSubmit}
      noValidate
    >
      <Field
        name="username"
        placeholder="username"
        autoComplete="username"
        inputRef={usernameRef}
        maxLength={20}
        value={username}
        onChange={(v) => {
          setUsername(v);
          if (serverField?.field === 'username') setServerField(null);
        }}
        error={errors.username}
        show={submitted || serverField?.field === 'username'}
      />
      <Field
        type="email"
        name="email"
        placeholder="email"
        autoComplete="email"
        maxLength={254}
        value={email}
        onChange={(v) => {
          setEmail(v);
          if (serverField?.field === 'email') setServerField(null);
        }}
        error={errors.email}
        show={submitted || serverField?.field === 'email'}
      />
      <Field
        type="password"
        name="new-password"
        placeholder="password (8+ characters)"
        autoComplete="new-password"
        maxLength={128}
        value={password}
        onChange={setPassword}
        error={errors.password}
        show={submitted}
        revealable
      />
      {formError && <FormError shakeKey={errorTick}>{formError}</FormError>}
      <button type="submit" className="btn primary block" disabled={busy}>
        {busy && <Spinner size={16} />} create account
      </button>
    </form>
  );
}

function LoginForm({ active, focusFirst }: FormProps) {
  const { login } = useAuth();
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  const identityRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useFocusWhenActive(active && focusFirst, identityRef);

  const errors = {
    identity: identity.trim() ? null : 'enter your username or email',
    password: password ? null : 'enter your password',
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setFormError(null);
    if (errors.identity || errors.password || busy) {
      setErrorTick((t) => t + 1);
      return;
    }
    setBusy(true);
    try {
      await login(identity.trim(), password);
      toast.success('welcome back!', { title: 'signed in' });
    } catch (err) {
      setFormError(describeAuthError(err, 'login'));
      setErrorTick((t) => t + 1);
      setBusy(false);
      if (err instanceof ApiError && err.status === 401) {
        setPassword('');
        passwordRef.current?.focus();
      }
    }
  };

  return (
    <form
      className="lg-form"
      id="lg-panel-login"
      role="tabpanel"
      aria-labelledby="lg-tab-login"
      hidden={!active}
      onSubmit={onSubmit}
      noValidate
    >
      <Field
        name="login"
        placeholder="username or email"
        autoComplete="username"
        inputRef={identityRef}
        value={identity}
        onChange={setIdentity}
        error={errors.identity}
        show={submitted}
      />
      <Field
        type="password"
        name="password"
        placeholder="password"
        autoComplete="current-password"
        inputRef={passwordRef}
        value={password}
        onChange={setPassword}
        error={errors.password}
        show={submitted && !formError}
        revealable
      />
      {formError && <FormError shakeKey={errorTick}>{formError}</FormError>}
      <button type="submit" className="btn primary block" disabled={busy}>
        {busy && <Spinner size={16} />} sign in
      </button>
    </form>
  );
}

const TABS: { mode: Mode; label: string; lede: string }[] = [
  { mode: 'login', label: 'sign in', lede: 'welcome back. your solves, pbs and settings are waiting.' },
  { mode: 'register', label: 'sign up', lede: 'keep your solves in the cloud, rank on the leaderboards and race under your own name.' },
];

export default function LoginPage() {
  const { status } = useAuth();
  const [params, setParams] = useSearchParams();
  const next = safeNext(params.get('next'));
  const mode: Mode = params.get('mode') === 'signup' ? 'register' : 'login';
  const tab = TABS.find((t) => t.mode === mode) ?? TABS[0];
  const tabRefs = useRef<Record<Mode, HTMLButtonElement | null>>({ login: null, register: null });
  // arrow keys on the tabs keep focus on the tabs; a click moves it into the form
  const [keyNav, setKeyNav] = useState(false);
  // guest solves in this browser: offered for upload right after signing in
  const guestSolves = useMemo(() => localDataSummary().solves, []);

  const setMode = (m: Mode) => {
    const p = new URLSearchParams(params);
    if (m === 'register') p.set('mode', 'signup');
    else p.delete('mode');
    setParams(p, { replace: true });
  };

  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const other: Mode = mode === 'login' ? 'register' : 'login';
    setKeyNav(true);
    setMode(other);
    tabRefs.current[other]?.focus();
  };

  useEffect(() => {
    document.title = `${tab.label} | cubr`;
  }, [tab.label]);
  useEffect(
    () => () => {
      document.title = 'cubr';
    },
    [],
  );

  if (status === 'loading') return <Loading />;
  if (status === 'authed') return <Navigate to={next} replace />;

  return (
    <div className="lg-page">
      <div className="lg-tabs" role="tablist" aria-label="account">
        {TABS.map((t) => (
          <button
            key={t.mode}
            ref={(el) => {
              tabRefs.current[t.mode] = el;
            }}
            type="button"
            role="tab"
            id={`lg-tab-${t.mode}`}
            aria-selected={mode === t.mode}
            aria-controls={`lg-panel-${t.mode}`}
            tabIndex={mode === t.mode ? 0 : -1}
            className={`lg-tab${mode === t.mode ? ' active' : ''}`}
            onClick={() => {
              setKeyNav(false);
              setMode(t.mode);
            }}
            onKeyDown={onTabKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="lg-lede">{tab.lede}</p>
      <LoginForm active={mode === 'login'} focusFirst={!keyNav} />
      <RegisterForm active={mode === 'register'} focusFirst={!keyNav} />
      {guestSolves > 0 && (
        <p className="lg-note">
          <CloudArrowUpIcon width={14} height={14} />
          <span>
            {guestSolves} guest {guestSolves === 1 ? 'solve' : 'solves'} in this browser can move to your account once you&apos;re in.
          </span>
        </p>
      )}
      <Link to="/" className="lg-guest">
        or keep timing as a guest
      </Link>
    </div>
  );
}
