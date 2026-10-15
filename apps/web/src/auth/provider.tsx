import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useConfig } from '../config-context.js';
import { AuthSession, returnPath, userIdentity } from './session.js';
import { navigate } from '../navigation.js';
interface AuthState {
  session: AuthSession;
  identity: { sub: string } | null;
  loading: boolean;
  message: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<AuthState | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Identity context is missing.');
  return value;
}
export function AuthProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const [session] = useState(() => new AuthSession(config, sessionStorage));
  const [identity, setIdentity] = useState<{ sub: string } | null>(null),
    [loading, setLoading] = useState(true),
    [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const loaded = async () => {
      const user = await session.manager.getUser();
      if (!cancelled) setIdentity(userIdentity(user, config));
    };
    const unloaded = () => {
      if (!cancelled) setIdentity(null);
    };
    session.manager.events.addUserLoaded(loaded);
    session.manager.events.addUserUnloaded(unloaded);
    void (async () => {
      try {
        await session.manager.clearStaleState();
        if (location.pathname === new URL(config.callbackUrl).pathname) {
          const user = await session.manager.signinRedirectCallback(location.href);
          const state = user.state as { path?: unknown } | undefined;
          history.replaceState(null, '', returnPath(state?.path));
          window.dispatchEvent(new PopStateEvent('popstate'));
        }
        await session.token();
        await loaded();
      } catch {
        await session.manager.removeUser();
        if (location.pathname === new URL(config.callbackUrl).pathname) {
          history.replaceState(null, '', '/');
          window.dispatchEvent(new PopStateEvent('popstate'));
        }
        if (!cancelled) setMessage('Sign-in could not finish. Please try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      session.manager.events.removeUserLoaded(loaded);
      session.manager.events.removeUserUnloaded(unloaded);
    };
  }, [config, session]);
  const signIn = async () => {
    setMessage(null);
    try {
      await session.signIn(location.pathname);
    } catch {
      setMessage('Sign-in is unavailable. Please try again.');
    }
  };
  const signOut = async () => {
    setLoading(true);
    try {
      location.assign(await session.signOut());
    } catch {
      setLoading(false);
      setIdentity(null);
      setMessage('You are signed out. The hosted sign-out page is unavailable.');
      navigate('/');
    }
  };
  return <AuthContext value={{ session, identity, loading, message, signIn, signOut }}>{children}</AuthContext>;
}
