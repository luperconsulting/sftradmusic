import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { ApiRequestError } from "../src/portal/api/client";
import { isRecoverySession, readRecoveryLink, saveNewPassword, tokenFromRecovery, waitForRecoverySession } from "../src/portal/auth/recovery";
import { resolveAuthState } from "../src/portal/auth/session";
import { markMfaVerified, markPasswordVerified, resetTeacherGate } from "../src/portal/auth/teacherGate";
import { buildDeps } from "./helpers";

// Unsigned stand-ins with the claims that matter. The real tokens are checked by Supabase, not here.
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const passwordToken = jwt({ aal: "aal1", amr: [{ method: "password" }] });
const recoveryToken = jwt({ aal: "aal1", amr: [{ method: "recovery" }] });
const teacher = (aal: string) => ({ user: { id: "t", email: "t@example.com", role: "teacher", displayName: "T", mfaEnabled: true, aal } }) as any;
const mfaRequired = () => new ApiRequestError(403, "mfa_required", "Two-factor verification is required.");

function client(session: { access_token: string } | null, factors = 1) {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      signOut: vi.fn(async () => undefined),
      mfa: { listFactors: async () => ({ data: { totp: Array.from({ length: factors }, (_, i) => ({ id: `f${i}` })) } }) },
    },
  };
}
const notRecovery = () => false;

beforeEach(() => resetTeacherGate());

describe("teacher sign-in", () => {
  it("routes the server's AAL1 answer to the two-factor screen, then the portal", async () => {
    const c = client({ access_token: passwordToken });
    markPasswordVerified();
    const pending = { mfaRequired: true as const, user: { role: "teacher" as const, mfaEnabled: true, aal: "aal1" } };
    expect(await resolveAuthState(c, async () => pending, notRecovery)).toEqual({ status: "needsMfa", me: null, mfaEnrolled: true });
    markMfaVerified();
    expect((await resolveAuthState(c, async () => teacher("aal2"), notRecovery)).status).toBe("ready");
    expect(c.auth.signOut).not.toHaveBeenCalled();
  });

  it("calls only a missing account row 'no account'", async () => {
    const noRow = await resolveAuthState(client({ access_token: passwordToken }), async () => { throw new ApiRequestError(403, "no_account", "x"); }, notRecovery);
    expect(noRow.status).toBe("noAccount");
    const other = await resolveAuthState(client({ access_token: passwordToken }), async () => { throw new ApiRequestError(403, "forbidden", "x"); }, notRecovery);
    expect(other.status).toBe("unavailable");
  });

  it("goes from password to the two-factor screen, then to the portal", async () => {
    const c = client({ access_token: passwordToken });
    markPasswordVerified();
    const afterPassword = await resolveAuthState(c, async () => { throw mfaRequired(); }, notRecovery);
    expect(afterPassword).toEqual({ status: "needsMfa", me: null, mfaEnrolled: true });
    expect(c.auth.signOut).not.toHaveBeenCalled();

    markMfaVerified();
    const afterCode = await resolveAuthState(c, async () => teacher("aal2"), notRecovery);
    expect(afterCode.status).toBe("ready");
    expect(c.auth.signOut).not.toHaveBeenCalled();
  });

  it("sends a password-only account without an authenticator to set one up", async () => {
    markPasswordVerified();
    const state = await resolveAuthState(client({ access_token: passwordToken }, 0), async () => { throw mfaRequired(); }, notRecovery);
    expect(state).toMatchObject({ status: "needsMfa", mfaEnrolled: false });
  });
});

describe("reloading a stored session", () => {
  it("signs out a restored AAL1 session from the server's routing answer too", async () => {
    const c = client({ access_token: passwordToken });
    const pending = { mfaRequired: true as const, user: { role: "guardian" as const, mfaEnabled: true, aal: "aal1" } };
    expect((await resolveAuthState(c, async () => pending, notRecovery)).status).toBe("signedOut");
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("signs out a password-only (AAL1) session instead of resuming it", async () => {
    const c = client({ access_token: passwordToken });
    const state = await resolveAuthState(c, async () => { throw mfaRequired(); }, notRecovery);
    expect(state.status).toBe("signedOut");
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("still signs out a stored teacher session that had passed 2FA", async () => {
    const c = client({ access_token: passwordToken });
    expect((await resolveAuthState(c, async () => teacher("aal2"), notRecovery)).status).toBe("signedOut");
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
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

    // The next page load starts from nothing; the new password alone reaches only the 2FA screen.
    resetTeacherGate();
    markPasswordVerified();
    const next = await resolveAuthState(client({ access_token: passwordToken }), async () => { throw mfaRequired(); }, notRecovery);
    expect(next.status).toBe("needsMfa");
  });
});
