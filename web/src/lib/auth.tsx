import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, getToken, onUnauthorized, setToken } from './api';
import { toast } from './toast';
import type { PrivateUser } from './types';

type Status = 'loading' | 'guest' | 'authed';

interface AuthContextValue {
  status: Status;
  user: PrivateUser | null;
  login(login: string, password: string): Promise<void>;
  register(username: string, email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

let currentUser: PrivateUser | null = null;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(getToken() ? 'loading' : 'guest');
  const [user, setUserState] = useState<PrivateUser | null>(null);

  const applyUser = useCallback((u: PrivateUser | null) => {
    currentUser = u;
    setUserState(u);
    setStatus(u ? 'authed' : 'guest');
  }, []);

  useEffect(() => {
    onUnauthorized(() => {
      if (!currentUser) return;
      setToken(null);
      applyUser(null);
      toast.notice('Your session expired — please log in again.');
    });
    if (!getToken()) {
      applyUser(null);
      return;
    }
    const ctrl = new AbortController();
    api.auth
      .me(ctrl.signal)
      .then(({ user: u }) => {
        applyUser(u);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) setToken(null);
        // auth service down: stay logged out locally but keep the token for next time
        applyUser(null);
      });
    return () => ctrl.abort();
  }, [applyUser]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      async login(login, password) {
        const res = await api.auth.login({ login, password });
        setToken(res.token);
        applyUser(res.user);
      },
      async register(username, email, password) {
        const res = await api.auth.register({ username, email, password });
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
