import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { loadConfig, safeInviteAllowlist } from "../server/config";
import { isEmailOtp } from "../shared/email-otp";
import { portalInvitePage } from "../server/services/invitations";
import { buildDeps, STUDENT_A } from "./helpers";

const ARZO = "luperdev@gmail.com";
const PREVIEW = "https://preview.example.com";

function teacherApp(over: { safeMode?: boolean; allowlist?: string[]; appUrl?: string; send?: (email: string, redirectTo: string) => Promise<string | null> } = {}) {
  const sendPortalInvite = vi.fn(over.send ?? (async () => "auth-user-arzo"));
  const createInvitation = vi.fn(async (i: any) => ({ ...i, id: "inv-arzo", status: "pending" }));
  const attachInvitationAuthUser = vi.fn(async () => undefined);
  const revokeInvitation = vi.fn(async () => undefined);
  const audit = vi.fn(async () => undefined);
  const sendInvoice = vi.fn();
  const createContact = vi.fn();
  const createStudent = vi.fn();
  const deps = buildDeps({ teach: { role: "teacher" } }, {
    createInvitation, attachInvitationAuthUser, revokeInvitation, audit, createStudent,
  } as any);
  deps.config.safeMode = over.safeMode ?? false;
  deps.config.appUrl = over.appUrl ?? PREVIEW;
  if (over.allowlist !== undefined) deps.config.safeModeEmailAllowlist = over.allowlist;
  (deps.auth as any).sendPortalInvite = sendPortalInvite;
  const post = (body: Record<string, unknown>) => request(createApp(deps)).post("/api/teacher/invitations").set("Authorization", "Bearer teach").send(body);
  return { post, sendPortalInvite, createInvitation, attachInvitationAuthUser, revokeInvitation, audit, sendInvoice, createStudent, createContact, deps };
}

const arzoInvite = { method: "email", role: "student", email: "LuperDev@gmail.com", name: "Arzo Luper", studentIds: [STUDENT_A] };

describe("portal invitation email", () => {
  it("sends people to this deployment's invite page, with no code in the URL", () => {
    expect(portalInvitePage("https://preview.example.com/")).toBe(`${PREVIEW}/invite`);
    expect(portalInvitePage(PREVIEW)).not.toContain("token=");
    expect(portalInvitePage(PREVIEW)).not.toContain("sftradmusic.com");
  });

  it("defaults the safe-mode allowlist to Arzo and lets an env var replace it", () => {
    expect(safeInviteAllowlist({})).toEqual([ARZO]);
    expect(safeInviteAllowlist({ SAFE_MODE_EMAIL_ALLOWLIST: "" })).toEqual([ARZO]);
    expect(safeInviteAllowlist({ SAFE_MODE_EMAIL_ALLOWLIST: "other@example.com, ARZO@example.com" })).toEqual(["other@example.com", "arzo@example.com"]);
    expect(loadConfig({ VERCEL_ENV: "preview", NODE_ENV: "production" }).safeModeEmailAllowlist).toEqual([ARZO]);
    expect(loadConfig({ VERCEL_ENV: "production", SAFE_MODE_EMAIL_ALLOWLIST: ARZO }).safeMode).toBe(false);
  });

  it("emails Arzo a code through Supabase in safe mode, and does not call GoHighLevel", async () => {
    const { post, sendPortalInvite, attachInvitationAuthUser, audit, sendInvoice, createInvitation } = teacherApp({ safeMode: true });
    const res = await post(arzoInvite);
    expect(res.status).toBe(200);
    expect(res.body.emailed).toBe(true);
    expect(res.body.inviteUrl).toBe(`${PREVIEW}/invite`);
    expect(res.body.credential).toBeUndefined();
    expect(sendPortalInvite).toHaveBeenCalledTimes(1);
    expect(sendPortalInvite).toHaveBeenCalledWith(ARZO, `${PREVIEW}/invite`);
    expect(attachInvitationAuthUser).not.toHaveBeenCalled();
    expect(sendInvoice).not.toHaveBeenCalled();
    const expiresIn = new Date((createInvitation.mock.calls as any)[0][0].expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(50 * 60 * 1000);
    expect(expiresIn).toBeLessThan(61 * 60 * 1000);
    expect(audit).toHaveBeenCalledWith("teach", "invitation.create", "inv-arzo", { method: "email", emailed: true });
  });

  it("refuses every other address while safe mode is on, and sends nothing", async () => {
    const { post, sendPortalInvite, createInvitation, sendInvoice } = teacherApp({ safeMode: true });
    const res = await post({ ...arzoInvite, email: "other@example.com" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("invite_not_allowed");
    expect(sendPortalInvite).not.toHaveBeenCalled();
    expect(createInvitation).not.toHaveBeenCalled();
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("still emails any address when safe mode is off", async () => {
    const { post, sendPortalInvite } = teacherApp({ safeMode: false, allowlist: [] });
    const res = await post({ ...arzoInvite, email: "other@example.com" });
    expect(res.status).toBe(200);
    expect(sendPortalInvite).toHaveBeenCalledWith("other@example.com", `${PREVIEW}/invite`);
  });

  it("does not email an enrollment code", async () => {
    const { post, sendPortalInvite } = teacherApp({ safeMode: true });
    const res = await post({ ...arzoInvite, method: "code", email: "other@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.credential).toMatch(/^SFTM-/);
    expect(res.body.inviteUrl).toBeUndefined();
    expect(sendPortalInvite).not.toHaveBeenCalled();
  });

  it("does not create a student when the teacher invites", async () => {
    const { post, sendPortalInvite, createInvitation, createStudent, createContact } = teacherApp({ safeMode: true });
    const res = await post({ email: "LuperDev@gmail.com", name: "Arzo Luper" });
    expect(res.status).toBe(200);
    expect(res.body.studentName).toBe("Not enrolled yet");
    expect(sendPortalInvite).toHaveBeenCalledWith(ARZO, res.body.inviteUrl);
    expect(createInvitation.mock.calls[0][0].studentIds).toEqual([]);
    expect(createStudent).not.toHaveBeenCalled();
    expect(createContact).not.toHaveBeenCalled();
  });

  it("creates no invitation when Supabase does not accept the email", async () => {
    const { post, revokeInvitation, createInvitation, sendInvoice } = teacherApp({
      safeMode: true,
      send: async () => { throw new Error("smtp down"); },
    });
    const res = await post(arzoInvite);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("invite_email_failed");
    expect(JSON.stringify(res.body)).not.toContain("smtp");
    expect(createInvitation).not.toHaveBeenCalled();
    expect(revokeInvitation).not.toHaveBeenCalled();
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("resend issues a new code and invalidates pending invites for that email", async () => {
    const revokePendingForEmail = vi.fn(async () => undefined);
    const { post, sendPortalInvite, createInvitation, deps } = teacherApp({ safeMode: true });
    const store = deps.store!;
    store.getInvitation = async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      tokenHash: "old",
      method: "email" as const,
      email: ARZO,
      name: "Arzo Luper",
      role: "student" as const,
      studentIds: [],
      status: "pending" as const,
      expiresAt: new Date(Date.now() + 864e5).toISOString(),
      preview: { firstName: "Arzo", studentLine: "Not enrolled yet", accountFor: "Arzo Luper · student", lessons: "", format: "In person" },
    });
    store.revokePendingForEmail = revokePendingForEmail;
    const first = await post({ email: ARZO, name: "Arzo Luper" });
    const res = await request(createApp(deps)).post("/api/teacher/invitations/11111111-1111-4111-8111-111111111111/resend").set("Authorization", "Bearer teach");
    expect(res.status).toBe(200);
    expect(res.body.inviteUrl).toBe(`${PREVIEW}/invite`);
    expect(res.body.inviteUrl).toBe(first.body.inviteUrl);
    const hashes = createInvitation.mock.calls.map((c: any) => c[0].tokenHash);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(revokePendingForEmail).toHaveBeenCalledWith(ARZO, "inv-arzo");
    expect(sendPortalInvite).toHaveBeenCalledTimes(2);
    expect(createInvitation.mock.calls.every((c: any) => c[0].studentIds.length === 0)).toBe(true);
  });

  it("a revoked code cannot be used to sign up", async () => {
    const deps = buildDeps({}, {
      findInvitationByHash: async () => ({ id: "i", status: "revoked", expiresAt: new Date(Date.now() + 864e5).toISOString(), preview: {}, email: ARZO }),
    } as any);
    const res = await request(createApp(deps)).post("/api/invitations/verify").send({ credential: "old-token-value" });
    expect(res.status).toBe(404);
  });
});

describe("accepting an invitation", () => {
  const token = "invite-token-arzo";
  const invite = {
    id: "i",
    tokenHash: "h",
    method: "email" as const,
    email: ARZO,
    name: "Arzo Luper",
    role: "student" as const,
    studentIds: [] as string[],
    status: "pending" as const,
    expiresAt: new Date(Date.now() + 864e5).toISOString(),
    preview: { firstName: "Arzo", studentLine: "Not enrolled yet", accountFor: "Arzo Luper · student", lessons: "", format: "In person" },
  };

  it("creates Arzo's student row in Supabase only after sign-up, with no GoHighLevel id", async () => {
    const createStudent = vi.fn(async (i: any) => ({ student: { ...i, id: "33333333-3333-4333-8333-333333333333", firstName: "Arzo", styleLine: "", studentSince: null }, guardian: null }));
    const createAccountForInvitation = vi.fn(async () => undefined);
    const createUser = vi.fn(async () => "auth-user");
    const deps = buildDeps({}, {
      findInvitationByHash: async () => invite,
      claimInvitation: async () => true,
      createStudent,
      createAccountForInvitation,
      listStudents: async () => [],
    } as any);
    (deps.auth as any).createUser = createUser;
    const res = await request(createApp(deps)).post("/api/invitations/redeem").send({ credential: token, password: "a-long-enough-password" });
    expect(res.status).toBe(200);
    const saved = (createStudent.mock.calls as any)[0][0];
    expect(saved).toMatchObject({ fullName: "Arzo Luper", email: ARZO, isMinor: false, teacherAccountId: "teach" });
    expect(saved.ghlContactId).toBeUndefined();
    expect(saved.billingContactId).toBeUndefined();
    expect((createAccountForInvitation.mock.calls as any)[0][0].studentIds).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(createUser).toHaveBeenCalled();
  });

  it("reopens the invitation and creates no login when the student row cannot be saved", async () => {
    const createUser = vi.fn();
    const releaseInvitation = vi.fn(async () => undefined);
    const deps = buildDeps({}, {
      findInvitationByHash: async () => invite,
      claimInvitation: async () => true,
      releaseInvitation,
      createStudent: async () => { throw new Error("db"); },
      listStudents: async () => [],
    } as any);
    (deps.auth as any).createUser = createUser;
    const res = await request(createApp(deps)).post("/api/invitations/redeem").send({ credential: token, password: "a-long-enough-password" });
    expect(res.status).toBe(500);
    expect(createUser).not.toHaveBeenCalled();
    expect(releaseInvitation).toHaveBeenCalledWith("i");
  });

  it("refuses to enroll a second student with Arzo's email", async () => {
    const createStudent = vi.fn();
    const releaseInvitation = vi.fn(async () => undefined);
    const deps = buildDeps({}, { findInvitationByHash: async () => invite, claimInvitation: async () => true, releaseInvitation, createStudent } as any);
    (deps.auth as any).createUser = vi.fn();
    const res = await request(createApp(deps)).post("/api/invitations/redeem").send({ credential: token, password: "a-long-enough-password" });
    expect(res.status).toBe(409);
    expect(createStudent).not.toHaveBeenCalled();
    expect(releaseInvitation).toHaveBeenCalledWith("i");
  });
});

describe("email code verification", () => {
  const code = "482913";
  const pending = {
    id: "i",
    tokenHash: "h",
    method: "email" as const,
    email: ARZO,
    name: "Arzo Luper",
    role: "student" as const,
    studentIds: [] as string[],
    status: "pending" as const,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    preview: { firstName: "Arzo", studentLine: "Not enrolled yet", accountFor: "Arzo Luper · student", lessons: "", format: "In person" },
  };

  it("verifies Arzo's code once, then creates the student and returns a session", async () => {
    const verifyEmailOtp = vi.fn(async () => ({ userId: "auth-arzo", accessToken: "access", refreshToken: "refresh" }));
    const createUser = vi.fn();
    const createStudent = vi.fn(async (i: any) => ({ student: { ...i, id: "33333333-3333-4333-8333-333333333333", firstName: "Arzo", styleLine: "", studentSince: null }, guardian: null }));
    const createAccountForInvitation = vi.fn(async () => undefined);
    let open = true;
    const deps = buildDeps({}, {
      findPendingInvitationByEmail: async () => (open ? pending : null),
      claimInvitation: async () => { open = false; return true; },
      createStudent,
      createAccountForInvitation,
      listStudents: async () => [],
    } as any);
    (deps.auth as any).verifyEmailOtp = verifyEmailOtp;
    (deps.auth as any).createUser = createUser;
    const app = createApp(deps);
    const ok = await request(app).post("/api/invitations/verify-code").send({ email: "LuperDev@gmail.com", code });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ accessToken: "access", refreshToken: "refresh", email: ARZO });
    expect(verifyEmailOtp).toHaveBeenCalledTimes(1);
    expect(verifyEmailOtp).toHaveBeenCalledWith(ARZO, code);
    expect(createUser).not.toHaveBeenCalled();
    expect((createStudent.mock.calls as any)[0][0]).toMatchObject({ email: ARZO, isMinor: false });
    expect((createAccountForInvitation.mock.calls as any)[0][0].studentIds).toEqual(["33333333-3333-4333-8333-333333333333"]);
    const again = await request(app).post("/api/invitations/verify-code").send({ email: ARZO, code });
    expect(again.status).toBe(404);
    expect(verifyEmailOtp).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired code before asking Supabase", async () => {
    const verifyEmailOtp = vi.fn();
    const deps = buildDeps({}, {
      findPendingInvitationByEmail: async () => ({ ...pending, expiresAt: new Date(Date.now() - 1000).toISOString() }),
    } as any);
    (deps.auth as any).verifyEmailOtp = verifyEmailOtp;
    const res = await request(createApp(deps)).post("/api/invitations/verify-code").send({ email: ARZO, code });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("invitation_expired");
    expect(verifyEmailOtp).not.toHaveBeenCalled();
  });

  it("rejects a code Supabase will not accept, and does not create a student", async () => {
    const verifyEmailOtp = vi.fn(async () => null);
    const createStudent = vi.fn();
    const claimInvitation = vi.fn();
    const deps = buildDeps({}, { findPendingInvitationByEmail: async () => pending, createStudent, claimInvitation } as any);
    (deps.auth as any).verifyEmailOtp = verifyEmailOtp;
    const res = await request(createApp(deps)).post("/api/invitations/verify-code").send({ email: ARZO, code });
    expect(res.status).toBe(401);
    expect(createStudent).not.toHaveBeenCalled();
    expect(claimInvitation).not.toHaveBeenCalled();
  });

  it("forwards 6, 8, and 10 digit codes to verifyOtp type email, and rejects other lengths", async () => {
    expect(isEmailOtp("48291370")).toBe(true);
    for (const code of ["482913", "48291370", "1234567890"]) {
      const verifyEmailOtp = vi.fn(async () => null);
      const deps = buildDeps({}, { findPendingInvitationByEmail: async () => pending } as any);
      (deps.auth as any).verifyEmailOtp = verifyEmailOtp;
      const res = await request(createApp(deps)).post("/api/invitations/verify-code").send({ email: ARZO, code });
      expect(res.status).toBe(401);
      expect(verifyEmailOtp).toHaveBeenCalledWith(ARZO, code);
    }
    for (const code of ["12345", "12345678901"]) {
      const verifyEmailOtp = vi.fn();
      const deps = buildDeps({}, { findPendingInvitationByEmail: async () => pending } as any);
      (deps.auth as any).verifyEmailOtp = verifyEmailOtp;
      const res = await request(createApp(deps)).post("/api/invitations/verify-code").send({ email: ARZO, code });
      expect(res.status).toBe(400);
      expect(verifyEmailOtp).not.toHaveBeenCalled();
    }
  });

  it("rate limits code attempts", async () => {
    const app = createApp(buildDeps({}, { findPendingInvitationByEmail: async () => null } as any));
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await request(app).post("/api/invitations/verify-code").send({ email: ARZO, code: "123456" })).status;
    expect(last).toBe(429);
  });
});
