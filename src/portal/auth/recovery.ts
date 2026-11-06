// Deciding whether this page holds a session that came from a password reset link. supabase-js reports
// PASSWORD_RECOVERY only after it has saved the session, on a later tick, so no single early check is reliable.

export interface RecoveryLink {
  accessToken: string;
}

/** Reads the implicit-flow reset link from the URL hash. Call before the Supabase client clears it. */
export function readRecoveryLink(hash: string): RecoveryLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const accessToken = params.get("access_token");
  return params.get("type") === "recovery" && accessToken ? { accessToken } : null;
}

/** True when Supabase signed this token for a recovery login (its `amr` claim). */
export function tokenFromRecovery(accessToken: string) {
  try {
    const part = accessToken.split(".")[1] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const amr = JSON.parse(json).amr;
    return Array.isArray(amr) && amr.some((m: any) => m?.method === "recovery");
  } catch {
    return false;
  }
}

export interface RecoverySignals {
  link: RecoveryLink | null;
  eventSeen: () => boolean;
}

export function isRecoverySession(session: { access_token: string } | null, signals: RecoverySignals) {
  if (!session) return false;
  return signals.eventSeen() || session.access_token === signals.link?.accessToken || tokenFromRecovery(session.access_token);
}

/**
 * Waits for the recovery session instead of checking once. Without a reset link in the URL, an existing session
 * still counts if it came from one; anything else fails straight away.
 */
export async function waitForRecoverySession(
  getSession: () => Promise<{ access_token: string } | null>,
  signals: RecoverySignals,
  { timeoutMs = 5000, stepMs = 100, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  for (let waited = 0; ; waited += stepMs) {
    const session = await getSession();
    if (isRecoverySession(session, signals)) return true;
    if (!signals.link || waited >= timeoutMs) return false;
    await sleep(stepMs);
  }
}

export interface PasswordResetClient {
  auth: {
    mfa: {
      listFactors(): Promise<{ data: { totp: { id: string }[] } | null }>;
      challengeAndVerify(p: { factorId: string; code: string }): Promise<{ error: unknown }>;
    };
    updateUser(p: { password: string }): Promise<{ error: { code?: string; message: string } | null }>;
    signOut(p: { scope: "global" | "local" }): Promise<unknown>;
  };
}

/** The authenticator code is checked before the password changes, so an email link alone can't get past 2FA. */
export async function saveNewPassword(client: PasswordResetClient, { password, code, needsCode }: { password: string; code: string; needsCode: boolean }) {
  if (needsCode) {
    const factor = (await client.auth.mfa.listFactors()).data?.totp[0];
    const check = factor ? await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code }) : null;
    if (!check || check.error) return { error: "That code isn't valid or has expired. Codes refresh every 30 seconds." };
  }
  const { error } = await client.auth.updateUser({ password });
  if (error?.code === "weak_password") return { error: error.message };
  if (error) return { error: "This reset link has expired. Request a new one from the sign-in page." };
  // Ends every session, including this recovery one, so the new password has to be used with 2FA.
  await client.auth.signOut({ scope: "global" });
  return { error: null };
}
