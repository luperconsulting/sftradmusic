import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { ApiRequestError } from "../src/portal/api/client";
import { isRecoverySession, readRecoveryLink, saveNewPassword, tokenFromRecovery, waitForRecoverySession } from "../src/portal/auth/recovery";
import { resolveAuthState } from "../src/portal/auth/session";
import { isEmailOtp } from "../shared/email-otp";
import { buildDeps } from "./helpers";

// Unsigned stand-ins with the claims that matter. The real tokens are checked by Supabase, not here.
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const passwordToken = jwt({ aal: "aal1", amr: [{ method: "password" }] });
const recoveryToken = jwt({ aal: "aal1", amr: [{ method: "recovery" }] });
const teacher = (aal: string) => ({ user: { id: "t", email: "t@example.com", role: "teacher", displayName: "T", mfaEnabled: true, aal } }) as any;
const mfaRequired = () => new ApiRequestError(403, "mfa_required", "Two-factor verification is required.");

/** A stand-in Supabase client. `level` is what supabase.auth.mfa.getAuthenticatorAssuranceLevel() reports. */
function client(session: { access_token: string } | null, factors = 1, level?: { currentLevel: string; nextLevel: string }) {
  const lvl = level ?? { currentLevel: "aal1", nextLevel: factors > 0 ? "aal2" : "aal1" };
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      signOut: vi.fn(async () => undefined),
      mfa: {
        listFactors: async () => ({ data: { totp: Array.from({ length: factors }, (_, i) => ({ id: `f${i}` })) } }),
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: lvl })),
      },
    },
  };
}
const notRecovery = () => false;
const aal2 = { currentLevel: "aal2", nextLevel: "aal2" };
const aal1WithFactor = { currentLevel: "aal1", nextLevel: "aal2" };

describe("teacher sign-in", () => {
  it("routes an AAL1 session to the two-factor screen, then to the portal once Supabase reports aal2", async () => {
    const c = client({ access_token: passwordToken }, 1, aal1WithFactor);
    const pending = { mfaRequired: true as const, user: { role: "teacher" as const, mfaEnabled: true, aal: "aal1" } };
    expect(await resolveAuthState(c, async () => pending, notRecovery)).toEqual({ status: "needsMfa", me: null, mfaEnrolled: true });
    const after = client({ access_token: passwordToken }, 1, aal2);
    expect((await resolveAuthState(after, async () => teacher("aal2"), notRecovery)).status).toBe("ready");
    expect(c.auth.signOut).not.toHaveBeenCalled();
    expect(after.auth.signOut).not.toHaveBeenCalled();
  });

  it("calls only a missing account row 'no account'", async () => {
    const noRow = await resolveAuthState(client({ access_token: passwordToken }), async () => { throw new ApiRequestError(403, "no_account", "x"); }, notRecovery);
    expect(noRow.status).toBe("noAccount");
    const other = await resolveAuthState(client({ access_token: passwordToken }), async () => { throw new ApiRequestError(403, "forbidden", "x"); }, notRecovery);
    expect(other.status).toBe("unavailable");
  });

  it("sends a password-only account without an authenticator to set one up", async () => {
    const state = await resolveAuthState(client({ access_token: passwordToken }, 0), async () => { throw mfaRequired(); }, notRecovery);
    expect(state).toMatchObject({ status: "needsMfa", mfaEnrolled: false });
  });

  it("never lets a client-side aal2 claim in when the server's token says aal1", async () => {
    const c = client({ access_token: passwordToken }, 1, aal2);
    const pending = { mfaRequired: true as const, user: { role: "teacher" as const, mfaEnabled: true, aal: "aal1" } };
    expect((await resolveAuthState(c, async () => pending, notRecovery)).status).toBe("needsMfa");
  });
});

describe("reloading a stored session", () => {
  it("keeps an aal2 session signed in on reload, a new tab, or reopening the site, with no prompt", async () => {
    for (const role of ["teacher", "guardian", "student"]) {
      const c = client({ access_token: jwt({ aal: "aal2" }) }, 1, aal2);
      const me = { user: { id: "u", email: "luperdev@gmail.com", role, displayName: "Arzo Luper", mfaEnabled: true, aal: "aal2" } } as any;
      expect(await resolveAuthState(c, async () => me, notRecovery), role).toEqual({ status: "ready", me, mfaEnrolled: true });
      expect(c.auth.signOut).not.toHaveBeenCalled();
      expect(c.auth.mfa.getAuthenticatorAssuranceLevel).toHaveBeenCalled();
    }
  });

  it("asks an aal1 session for the 2FA code only, without signing it out or asking for the password", async () => {
    for (const role of ["teacher", "guardian"] as const) {
      const c = client({ access_token: passwordToken }, 1, aal1WithFactor);
      const pending = { mfaRequired: true as const, user: { role, mfaEnabled: true, aal: "aal1" } };
      expect(await resolveAuthState(c, async () => pending, notRecovery), role).toEqual({ status: "needsMfa", me: null, mfaEnrolled: true });
      expect(c.auth.signOut).not.toHaveBeenCalled();
    }
  });

  it("treats no stored session as signed out", async () => {
    expect((await resolveAuthState(client(null), vi.fn(), notRecovery)).status).toBe("signedOut");
  });

  it("gets no data from the server at AAL1, only the role for routing", async () => {
    const app = createApp(buildDeps({ t: { role: "teacher", aal: "aal1" } }));
    const me = await request(app).get("/api/me").set("Authorization", "Bearer t");
    expect(me.body).toEqual({ mfaRequired: true, user: { role: "teacher", mfaEnabled: true, aal: "aal1" } });
    for (const path of ["/api/teacher/students", "/api/teacher/overview", "/api/portal/dashboard"]) {
      const res = await request(app).get(path).set("Authorization", "Bearer t");
      expect(res.status, path).toBe(403);
      expect(res.body.error.code, path).toBe("mfa_required");
    }
  });
});

describe("password reset link", () => {
  const link = readRecoveryLink(`#access_token=${recoveryToken}&type=recovery&expires_in=3600`);

  it("reads only recovery links from the URL", () => {
    expect(link?.accessToken).toBe(recoveryToken);
    expect(readRecoveryLink(`#access_token=${passwordToken}&type=magiclink`)).toBeNull();
    expect(readRecoveryLink("#type=recovery")).toBeNull();
    expect(readRecoveryLink("")).toBeNull();
  });

  it("recognises a recovery token by its amr claim", () => {
    expect(tokenFromRecovery(recoveryToken)).toBe(true);
    expect(tokenFromRecovery(passwordToken)).toBe(false);
    expect(tokenFromRecovery("not a token")).toBe(false);
  });

  it("waits for the session that Supabase saves after the page starts, before the deferred event", async () => {
    let calls = 0;
    const getSession = async () => (++calls < 3 ? null : { access_token: link!.accessToken });
    let eventSeen = false;
    const ok = await waitForRecoverySession(getSession, { link, eventSeen: () => eventSeen }, { sleep: async () => undefined });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("accepts the PASSWORD_RECOVERY event when it arrives later", async () => {
    let polls = 0;
    const session = { access_token: "opaque" };
    const ok = await waitForRecoverySession(async () => session, { link: { accessToken: "different" }, eventSeen: () => ++polls > 4 }, { sleep: async () => undefined });
    expect(ok).toBe(true);
  });

  it("refuses an ordinary session, and gives up on a link that never produces a session", async () => {
    const plain = await waitForRecoverySession(async () => ({ access_token: passwordToken }), { link: null, eventSeen: () => false });
    expect(plain).toBe(false);
    const sleep = vi.fn(async () => undefined);
    const stale = await waitForRecoverySession(async () => null, { link, eventSeen: () => false }, { timeoutMs: 500, stepMs: 100, sleep });
    expect(stale).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("keeps the recovery session on the reset page instead of signing it out", async () => {
    const c = client({ access_token: recoveryToken });
    const fetchMe = vi.fn();
    const state = await resolveAuthState(c, fetchMe, (s) => isRecoverySession(s, { link, eventSeen: () => false }));
    expect(state.status).toBe("signedOut");
    expect(c.auth.signOut).not.toHaveBeenCalled();
    expect(fetchMe).not.toHaveBeenCalled();
  });

  it("checks the code, saves the password, ends every session, and the next sign-in needs 2FA", async () => {
    const order: string[] = [];
    const auth = {
      mfa: {
        listFactors: async () => ({ data: { totp: [{ id: "f1" }] } }),
        challengeAndVerify: vi.fn(async ({ code }: any) => { order.push("code"); return { error: code === "123456" ? null : new Error("bad") }; }),
      },
      updateUser: vi.fn(async () => { order.push("password"); return { error: null }; }),
      signOut: vi.fn(async (p: any) => { order.push(`signOut:${p.scope}`); }),
    };
    expect((await saveNewPassword({ auth }, { password: "a-new-long-password", code: "000000", needsCode: true })).error).toMatch(/code/);
    expect(auth.updateUser).not.toHaveBeenCalled();

    expect((await saveNewPassword({ auth }, { password: "a-new-long-password", code: "123456", needsCode: true })).error).toBeNull();
    expect(order).toEqual(["code", "code", "password", "signOut:global"]);

    // Signing in again with the new password reaches only the 2FA screen (the session is aal1).
    const next = await resolveAuthState(client({ access_token: passwordToken }, 1, aal1WithFactor), async () => { throw mfaRequired(); }, notRecovery);
    expect(next.status).toBe("needsMfa");
  });
});

describe("email OTP length", () => {
  it("accepts 6 to 10 digits, which covers Supabase's configurable OTP", () => {
    expect(isEmailOtp("482913")).toBe(true);
    expect(isEmailOtp("48291370")).toBe(true);
    expect(isEmailOtp("1234567890")).toBe(true);
    expect(isEmailOtp("12345")).toBe(false);
    expect(isEmailOtp("12345678901")).toBe(false);
    expect(isEmailOtp("4829137a")).toBe(false);
  });
});
