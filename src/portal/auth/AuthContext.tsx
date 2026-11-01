import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MeResponse } from "../../../shared/portal-types";
import { api, ApiRequestError } from "../api/client";
import { DEMO_MODE, supabase } from "./supabase";

export type AuthStatus = "loading" | "signedOut" | "needsMfa" | "ready" | "suspended" | "noAccount" | "unavailable";

interface AuthValue {
  status: AuthStatus;
  me: MeResponse | null;
  configured: boolean;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);
export const useAuth = () => useContext(Ctx)!;

export const homeFor = (me: MeResponse | null) => (me?.user.role === "teacher" ? "/teacher" : "/portal");

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [me, setMe] = useState<MeResponse | null>(null);

  const refresh = useCallback(async () => {
    if (DEMO_MODE) {
      setMe(await api<MeResponse>("/me"));
      setStatus("ready");
      return;
    }
    if (!supabase) {
      setMe(null);
      setStatus("signedOut");
      return;
    }
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      setMe(null);
      setStatus("signedOut");
      return;
    }
    try {
      const profile = await api<MeResponse>("/me");
      setMe(profile);
      // The server enforces this on every request. Checking here only decides which screen to show.
      const needsMfa = profile.user.aal !== "aal2" && (profile.user.role === "teacher" || profile.user.mfaEnabled);
      setStatus(needsMfa ? "needsMfa" : "ready");
    } catch (e) {
      setMe(null);
      if (e instanceof ApiRequestError && e.status === 401) setStatus("signedOut");
      else if (e instanceof ApiRequestError && e.code === "account_suspended") setStatus("suspended");
      else if (e instanceof ApiRequestError && e.status === 403) setStatus("noAccount");
      else setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setMe(null);
        setStatus("signedOut");
      }
    });
    return () => data.subscription.unsubscribe();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut();
    setMe(null);
    setStatus("signedOut");
  }, []);

  const value = useMemo(() => ({ status, me, configured: DEMO_MODE || !!supabase, refresh, signOut }), [status, me, refresh, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
