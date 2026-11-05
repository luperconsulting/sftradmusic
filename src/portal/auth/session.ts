import type { MeResponse } from "../../../shared/portal-types";
import { ApiRequestError } from "../api/client";
import { teacherGateState, teacherMfaPending, teacherMustReauthenticate } from "./teacherGate";

export type AuthStatus = "loading" | "signedOut" | "needsMfa" | "ready" | "suspended" | "noAccount" | "unavailable";

export interface AuthState {
  status: AuthStatus;
  me: MeResponse | null;
  /** Whether the account has a verified authenticator. Known before the profile is, which needs 2FA first. */
  mfaEnrolled: boolean;
}

export interface SessionClient {
  auth: {
    getSession(): Promise<{ data: { session: { access_token: string } | null } }>;
    signOut(p: { scope: "local" }): Promise<unknown>;
    mfa: { listFactors(): Promise<{ data: { totp: unknown[] } | null }> };
  };
}

const signedOut: AuthState = { status: "signedOut", me: null, mfaEnrolled: false };

/**
 * Works out where a stored or fresh session stands. The server refuses every profile and data request until the
 * session has passed 2FA (AAL2), so a password-only session is told apart by that refusal.
 */
export async function resolveAuthState(
  client: SessionClient,
  fetchMe: () => Promise<MeResponse>,
  isRecovery: (session: { access_token: string }) => boolean,
): Promise<AuthState> {
  const { data } = await client.auth.getSession();
  if (!data.session) return signedOut;
  // A reset link's session belongs to the reset page, which asks for the 2FA code itself. Signing it out here
  // would break the reset, and it can't open anything else: the server still requires AAL2.
  if (isRecovery(data.session)) return signedOut;
  try {
    const me = await fetchMe();
    // A stored teacher session is not a new login. Drop it until this page gets a password and a 2FA challenge.
    if (teacherMustReauthenticate(me.user.role)) {
      await client.auth.signOut({ scope: "local" });
      return signedOut;
    }
    const needsMfa = me.user.role === "teacher" ? teacherMfaPending(me.user.role, me.user.aal) : me.user.aal !== "aal2" || !me.user.mfaEnabled;
    return { status: needsMfa ? "needsMfa" : "ready", me, mfaEnrolled: me.user.mfaEnabled };
  } catch (e) {
    if (e instanceof ApiRequestError && e.code === "mfa_required") {
      // A password-only session restored from the browser isn't a sign-in: start again at the password.
      if (!teacherGateState().passwordVerified) {
        await client.auth.signOut({ scope: "local" });
        return signedOut;
      }
      const factors = await client.auth.mfa.listFactors();
      return { status: "needsMfa", me: null, mfaEnrolled: (factors.data?.totp.length ?? 0) > 0 };
    }
    if (e instanceof ApiRequestError && e.status === 401) return signedOut;
    if (e instanceof ApiRequestError && e.code === "account_suspended") return { ...signedOut, status: "suspended" };
    if (e instanceof ApiRequestError && e.status === 403) return { ...signedOut, status: "noAccount" };
    return { ...signedOut, status: "unavailable" };
  }
}
