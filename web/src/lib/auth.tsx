import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, getToken, onUnauthorized, setToken, storedToken } from './api';
import { mergeServerSettings, setSettingsServerSync } from './settings';
import { loadJson, saveJson } from './store';
import { toast } from './toast';
import type { PrivateUser } from './types';

type Status = 'loading' | 'guest' | 'authed';

interface AuthContextValue {
  status: Status;
  user: PrivateUser | null;
  login(login: string, password: string): Promise<void>;
  register(username: string, email: string, password: string): Promise<void>;
  /** Sets a new password with a reset link's token and signs in (every other session ends). */
  resetPassword(token: string, password: string): Promise<void>;
  /** Changes the password (`password`: the current one; left out by an account without one, which
   *  sets its first). Every other session ends; this one carries on with a fresh token. */
  changePassword(newPassword: string, password?: string): Promise<void>;
  logout(): Promise<void>;
  /** Deletes the account for good (after checking the password, or the username for an account
   *  without one), then signs out. */
  deleteAccount(proof: { password: string } | { confirm: string }): Promise<void>;
  /** Signs in with a token from elsewhere (sign-in with Google, Apple or GitHub). */
  signInWithToken(token: string, user: PrivateUser): Promise<void>;
  setUser(u: PrivateUser): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Listeners notified on login/logout (e.g. the solve store switches between local and cloud). */
type AuthListener = (user: PrivateUser | null) => void;
const listeners = new Set<AuthListener>();
export function onAuthChange(fn: AuthListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let currentUser: PrivateUser | null = null;
export function getCurrentUser(): PrivateUser | null {
  return currentUser;
}

/** The last signed-in user, so the app stays signed in while the auth service is unreachable. */
const USER_KEY = 'cubr.user';
function cachedUser(): PrivateUser | null {
  const u = loadJson<PrivateUser | null>(USER_KEY, null);
  return u && typeof u.id === 'string' && typeof u.username === 'string' ? u : null;
}
function rememberUser(u: PrivateUser | null): void {
  if (u) {
    saveJson(USER_KEY, u);
    return;
  }
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(getToken() ? 'loading' : 'guest');
  const [user, setUserState] = useState<PrivateUser | null>(null);

  const applyUser = useCallback((u: PrivateUser | null) => {
    currentUser = u;
    rememberUser(u);
    setUserState(u);
    setStatus(u ? 'authed' : 'guest');
    setSettingsServerSync(u ? (s) => api.auth.saveSettings(s as unknown as Record<string, unknown>) : null);
    listeners.forEach((l) => l(u));
  }, []);

  useEffect(() => {
    let ctrl = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const check = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const sent = getToken();
      if (!sent) return;
      ctrl.abort();
      const c = (ctrl = new AbortController());
      api.auth
        .me(c.signal)
        .then(({ user: u, settings }) => {
          window.removeEventListener('online', check);
          mergeServerSettings(settings);
          applyUser(u);
        })
        .catch((err) => {
          if (c.signal.aborted) return;
          if (err instanceof ApiError && err.status === 401) {
            // another tab's newer token arrived meanwhile (lib/api.ts): check with that one
            if (getToken() !== sent) return check();
            window.removeEventListener('online', check);
            setToken(null);
            applyUser(null);
            return;
          }
          // auth service unreachable: keep the token and stay signed in as the last known user
          // (the solve store keeps working from its offline cache); check again later
          if (failures === 0 && !currentUser) applyUser(cachedUser());
          retryTimer = setTimeout(check, Math.min(60_000, 2000 * 2 ** failures++));
        });
    };
    const cleanup = () => {
      ctrl.abort();
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('online', check);
    };
    onUnauthorized((sent) => {
      // signed out already, or a request sent before this tab got a newer token: nothing to undo
      if (!currentUser || sent !== getToken()) return;
      // Another tab stored a newer token (it signed in again, or changed the password before this
      // tab heard): carry on with that one. Signing out here would delete it from storage too.
      const stored = storedToken();
      if (stored && stored !== sent) {
        setToken(stored);
        check();
        return;
      }
      setToken(null);
      applyUser(null);
      toast.notice('Your session expired - please log in again.');
    });
    if (!getToken()) {
      applyUser(null);
      return cleanup;
    }
    window.addEventListener('online', check);
    check();
    return cleanup;
  }, [applyUser]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      async login(login, password) {
        const res = await api.auth.login({ login, password });
        setToken(res.token);
        try {
          const me = await api.auth.me();
          mergeServerSettings(me.settings);
        } catch {
          /* settings are optional */
        }
        applyUser(res.user);
      },
      async register(username, email, password) {
        const res = await api.auth.register({ username, email, password });
        setToken(res.token);
        applyUser(res.user);
      },
      async resetPassword(token, password) {
        const res = await api.auth.resetPassword({ token, password });
        setToken(res.token);
        try {
          const me = await api.auth.me();
          mergeServerSettings(me.settings);
        } catch {
          /* settings are optional */
        }
        applyUser(res.user);
      },
      async changePassword(newPassword, password) {
        const res = await api.auth.changePassword({ newPassword, ...(password !== undefined ? { password } : {}) });
        setToken(res.token);
        applyUser(res.user);
      },
      async logout() {
        try {
          await api.auth.logout();
        } catch {
          /* token is discarded locally regardless */
        }
        setToken(null);
        applyUser(null);
      },
      async signInWithToken(token, signedIn) {
        setToken(token);
        try {
          const me = await api.auth.me();
          mergeServerSettings(me.settings);
        } catch {
          /* settings are optional */
        }
        applyUser(signedIn);
      },
      async deleteAccount(proof) {
        await api.auth.deleteMe(proof);
        setToken(null);
        applyUser(null);
      },
      setUser(u) {
        applyUser(u);
      },
    }),
    [status, user, applyUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
