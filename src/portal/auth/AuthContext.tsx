import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MeResponse } from "../../../shared/portal-types";
import { api } from "../api/client";
import { isRecoverySession } from "./recovery";
import { resolveAuthState, type AuthStatus } from "./session";
import { teacherPortalReady } from "./teacherGate";
import { DEMO_MODE, recoverySignals, supabase } from "./supabase";

export type { AuthStatus };

interface AuthValue {
  status: AuthStatus;
  me: MeResponse | null;
  /** Whether a verified authenticator exists. Set before the profile loads, which needs 2FA. */
  mfaEnrolled: boolean;
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
  const [mfaEnrolled, setMfaEnrolled] = useState(false);

  const refresh = useCallback(async () => {
    if (DEMO_MODE) {
      // Sample data never opens the teacher portal by itself. Sign-in has to be clicked first.
      if (!teacherPortalReady()) {
        setMe(null);
        setStatus("signedOut");
        return;
      }
      const profile = await api<MeResponse>("/me");
      setMe(profile);
      setMfaEnrolled(profile.user.mfaEnabled);
      setStatus("ready");
      return;
    }
    if (!supabase) {
      setMe(null);
      setStatus("signedOut");
      return;
    }
    // Only the reset page may keep a reset link's session; anywhere else it's handled like any other.
    const onResetPage = window.location.pathname === "/reset-password";
    const next = await resolveAuthState(supabase, () => api<MeResponse>("/me"), (session) => onResetPage && isRecoverySession(session, recoverySignals));
    setMe(next.me);
    setMfaEnrolled(next.mfaEnrolled);
    setStatus(next.status);
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

  const value = useMemo(() => ({ status, me, mfaEnrolled, configured: DEMO_MODE || !!supabase, refresh, signOut }), [status, me, mfaEnrolled, refresh, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
