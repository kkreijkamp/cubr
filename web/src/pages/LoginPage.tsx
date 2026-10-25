import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRightEndOnRectangleIcon,
  CalendarDaysIcon,
  CheckIcon,
  CloudIcon,
  ExclamationCircleIcon,
  FlagIcon,
  TrophyIcon,
  UserPlusIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { Loading, Spinner } from '../components/Spinner';
import { safeNext } from '../components/social/util';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
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
}

function Field({ type = 'text', name, placeholder, value, onChange, autoComplete, error, show, inputRef, maxLength }: FieldProps) {
  const [touched, setTouched] = useState(false);
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
          type={type}
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

function RegisterForm() {
  const { register } = useAuth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verify, setVerify] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverField, setServerField] = useState<{ field: 'username' | 'email'; message: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [errorTick, setErrorTick] = useState(0);

  const errors = {
    username: serverField?.field === 'username' ? serverField.message : validateUsername(username),
    email: serverField?.field === 'email' ? serverField.message : validateEmail(email),
    password: validatePassword(password),
    verify: !verify ? 'repeat your password' : verify !== password ? 'passwords do not match' : null,
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
      toast.success(`welcome to cubetype, ${username.trim()}!`);
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
    <form className="lg-form lg-register" onSubmit={onSubmit} noValidate>
      <h2 className="h3">
        <UserPlusIcon /> register
      </h2>
      <Field
        name="username"
        placeholder="username"
        autoComplete="username"
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
        placeholder="password"
        autoComplete="new-password"
        maxLength={128}
        value={password}
        onChange={setPassword}
        error={errors.password}
        show={submitted}
      />
      <Field
        type="password"
        name="verify-password"
        placeholder="verify password"
        autoComplete="new-password"
        maxLength={128}
        value={verify}
        onChange={setVerify}
        error={errors.verify}
        show={submitted}
      />
      {formError && <FormError shakeKey={errorTick}>{formError}</FormError>}
      <button type="submit" className="btn block" disabled={busy}>
        {busy ? <Spinner size={16} /> : <UserPlusIcon />} sign up
      </button>
    </form>
  );
}

function LoginForm() {
  const { login } = useAuth();
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  const identityRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // keyboard-first: focus the login field on desktop (not on touch devices - it would pop the keyboard)
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) identityRef.current?.focus();
  }, []);

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
    <form className="lg-form lg-login" onSubmit={onSubmit} noValidate>
      <h2 className="h3">
        <ArrowRightEndOnRectangleIcon /> login
      </h2>
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
      />
      {formError && <FormError shakeKey={errorTick}>{formError}</FormError>}
      <button type="submit" className="btn block" disabled={busy}>
        {busy ? <Spinner size={16} /> : <ArrowRightEndOnRectangleIcon />} sign in
      </button>
    </form>
  );
}

export default function LoginPage() {
  const { status } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  useEffect(() => {
    document.title = 'sign in | cubetype';
    return () => {
      document.title = 'cubetype';
    };
  }, []);

  if (status === 'loading') return <Loading />;
  if (status === 'authed') return <Navigate to={next} replace />;

  return (
    <div className="lg-page">
      <RegisterForm />
      <div className="lg-divider" aria-hidden="true" />
      <LoginForm />
      <div className="lg-perks">
        <span>
          <CloudIcon width={14} height={14} /> solves synced across devices
        </span>
        <span>
          <TrophyIcon width={14} height={14} /> a spot on the leaderboards
        </span>
        <span>
          <CalendarDaysIcon width={14} height={14} /> daily challenge rankings
        </span>
        <span>
          <FlagIcon width={14} height={14} /> race with your name
        </span>
      </div>
    </div>
  );
}
