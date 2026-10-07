import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, getToken, maybeRefreshSession, setToken, setUnauthorizedHandler } from "./api";

export interface Me {
  user: { id: string; email: string | null; display_name: string | null };
  profile: { id: string; slug: string; name: string } | null;
}

interface AuthState {
  ready: boolean;
  me: Me | null;
  signIn: (sessionToken: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  const reload = useCallback(async () => {
    if (!(await getToken())) {
      setMe(null);
      return;
    }
    try {
      setMe(await api<Me>("/me"));
    } catch {
      setMe(null);
    }
  }, []);

  const signOut = useCallback(async () => {
    await api("/auth/logout", { body: {} }).catch(() => undefined);
    await setToken(null);
    setMe(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void setToken(null).then(() => setMe(null));
    });
    (async () => {
      await maybeRefreshSession().catch(() => undefined);
      await reload();
      setReady(true);
    })();
  }, [reload]);

  const signIn = useCallback(
    async (sessionToken: string) => {
      await setToken(sessionToken);
      await reload();
    },
    [reload],
  );

  const value = useMemo(() => ({ ready, me, signIn, signOut, reload }), [ready, me, signIn, signOut, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
