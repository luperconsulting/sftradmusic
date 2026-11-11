import type { MePending, MeResponse } from "../../../shared/portal-types";
import { ApiRequestError } from "../api/client";
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
    signOut(p: { scope: "local" | "global" }): Promise<unknown>;
    mfa: {
      listFactors(): Promise<{ data: { totp: unknown[] } | null }>;
      /** Supabase MFA: currentLevel is the session's AAL; nextLevel is aal2 when the account has a verified factor. */
      getAuthenticatorAssuranceLevel(): Promise<{ data: { currentLevel: string | null; nextLevel: string | null } | null }>;
    };
  };
}

const signedOut: AuthState = { status: "signedOut", me: null, mfaEnrolled: false };

/**
 * Works out where a stored or fresh session stands, from Supabase MFA's own session level, so a reload, a new tab
 * or reopening the site keeps the user signed in:
 *  - currentLevel aal2 (the TOTP challenge passed in this session): straight in, no prompt;
 *  - currentLevel aal1 with nextLevel aal2: only the 2FA code step, not the password again;
 *  - aal1 with no verified factor: set up 2FA (the invite flow).
 * The server enforces the same thing from the JWT's aal claim: every data route requires aal2.
 */
export async function resolveAuthState(
  client: SessionClient,
  fetchMe: () => Promise<MeResponse | MePending>,
  isRecovery: (session: { access_token: string }) => boolean,
): Promise<AuthState> {
  const { data } = await client.auth.getSession();
  if (!data.session) return signedOut;
  // A reset link's session belongs to the reset page, which asks for the 2FA code itself. Signing it out here
  // would break the reset, and it can't open anything else: the server still requires AAL2.
  if (isRecovery(data.session)) return signedOut;
  const level = (await client.auth.mfa.getAuthenticatorAssuranceLevel()).data;
  const enrolled = level?.nextLevel === "aal2";
  try {
    const me = await fetchMe();
    // Either side saying aal1 means the 2FA step (or 2FA setup when no factor is verified yet).
    if (me.mfaRequired || level?.currentLevel !== "aal2" || me.user.aal !== "aal2" || !me.user.mfaEnabled) {
      return { status: "needsMfa", me: null, mfaEnrolled: enrolled || me.user.mfaEnabled };
    }
    return { status: "ready", me, mfaEnrolled: true };
  } catch (e) {
    // An older server refuses /api/me outright until 2FA; Supabase's nextLevel says whether a factor exists.
    if (e instanceof ApiRequestError && e.code === "mfa_required") return { status: "needsMfa", me: null, mfaEnrolled: enrolled };
    if (e instanceof ApiRequestError && e.status === 401) return signedOut;
    if (e instanceof ApiRequestError && e.code === "account_suspended") return { ...signedOut, status: "suspended" };
    // Only a sign-in with no account row is "no account"; any other refusal isn't explained by that.
    if (e instanceof ApiRequestError && e.code === "no_account") return { ...signedOut, status: "noAccount" };
    return { ...signedOut, status: "unavailable" };
  }
}

/** Sign out of this browser only. Other browsers and devices stay signed in until their own sessions end. */
export const signOutThisBrowser = (client: Pick<SessionClient, "auth">) => client.auth.signOut({ scope: "local" });

/** Sign out everywhere: ends every session for this login, on every browser and device. */
export const signOutAllBrowsers = (client: Pick<SessionClient, "auth">) => client.auth.signOut({ scope: "global" });
