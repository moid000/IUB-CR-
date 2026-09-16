/**
 * Central auth/session state.
 *
 * - On load: GET /api/auth/me. 200 → authenticated, 401 → unauthenticated.
 * - The user object lives in React state ONLY — no token is ever stored
 *   client-side (auth is entirely the httpOnly `iub_auth` cookie).
 * - `ready` prevents protected routes from rendering before the
 *   authentication state is known (no auth-page flash).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi } from '../api/auth.js';
import { ApiError } from '../api/client.js';

const AuthContext = createContext(null);

export const ROLE_HOME = { ADMIN: '/admin', CR: '/cr', GR: '/cr', STUDENT: '/student' };

/**
 * Backend stores roles lowercase ('admin' | 'cr' | 'student'); the frontend
 * consistently uses uppercase. Normalize at the auth boundary so every
 * consumer sees canonical role strings.
 */
const normalizeUser = (u) =>
  u ? { ...u, role: typeof u.role === 'string' ? u.role.toUpperCase() : u.role } : null;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false); // initial session check done?
  const [refreshing, setRefreshing] = useState(false);

  // Initial session restoration
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await authApi.me();
        if (!cancelled) setUser(normalizeUser(data?.user));
      } catch {
        if (!cancelled) setUser(null); // 401 or network → unauthenticated
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email, password) => {
    await authApi.login(email, password); // sets the httpOnly cookie
    const data = await authApi.me(); // fetch the authoritative session
    const u = normalizeUser(data?.user);
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout(); // best-effort — clears the cookie server-side
    } finally {
      setUser(null); // frontend state cleared regardless
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await authApi.me();
      const u = normalizeUser(data?.user);
      setUser(u);
      return u;
    } catch (err) {
      setUser(null);
      if (err instanceof ApiError && err.status !== 401) throw err;
      return null;
    } finally {
      setRefreshing(false);
    }
  }, []);

  const value = useMemo(() => ({
    user,
    ready,
    refreshing,
    isAuthenticated: Boolean(user),
    role: user?.role ?? null,
    home: user ? (ROLE_HOME[user.role] ?? '/login') : '/login',
    login,
    logout,
    refresh,
  }), [user, ready, refreshing, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
