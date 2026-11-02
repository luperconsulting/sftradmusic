import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MeResponse } from "../../../shared/portal-types";
import { api, ApiRequestError } from "../api/client";
import { teacherMfaPending, teacherMustReauthenticate, teacherPortalReady } from "./teacherGate";
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
      // Sample data never opens the teacher portal by itself. Sign-in has to be clicked first.
      if (!teacherPortalReady()) {
        setMe(null);
        setStatus("signedOut");
        return;
      }
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
      // A stored teacher session is not a new login. Drop it until this page gets a password and a 2FA challenge.
      if (teacherMustReauthenticate(profile.user.role)) {
        await supabase.auth.signOut({ scope: "local" });
        setMe(null);
        setStatus("signedOut");
        return;
      }
      setMe(profile);
      const needsMfa = profile.user.role === "teacher"
        ? teacherMfaPending(profile.user.role, profile.user.aal)
        : profile.user.aal !== "aal2" || !profile.user.mfaEnabled;
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
