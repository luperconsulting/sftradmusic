import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { loadConfig, safeInviteAllowlist } from "../server/config";
import { portalInviteRedirect } from "../server/services/invitations";
import { buildDeps, fakeGhl, STUDENT_A } from "./helpers";

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
  const deps = buildDeps({ teach: { role: "teacher" } }, fakeGhl({ sendInvoice, createContact }), {
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
  it("builds the redirect from this deployment's APP_URL", () => {
    const url = new URL(portalInviteRedirect("https://preview.example.com/", "tok en"));
    expect(url.origin).toBe(PREVIEW);
    expect(url.pathname).toBe("/invite");
    expect(url.searchParams.get("token")).toBe("tok en");
    expect(url.href).not.toContain("sftradmusic.com");
  });

  it("defaults the safe-mode allowlist to Arzo and lets an env var replace it", () => {
    expect(safeInviteAllowlist({})).toEqual([ARZO]);
    expect(safeInviteAllowlist({ SAFE_MODE_EMAIL_ALLOWLIST: "" })).toEqual([ARZO]);
    expect(safeInviteAllowlist({ SAFE_MODE_EMAIL_ALLOWLIST: "other@example.com, ARZO@example.com" })).toEqual(["other@example.com", "arzo@example.com"]);
    expect(loadConfig({ VERCEL_ENV: "preview", NODE_ENV: "production" }).safeModeEmailAllowlist).toEqual([ARZO]);
    expect(loadConfig({ VERCEL_ENV: "production", SAFE_MODE_EMAIL_ALLOWLIST: ARZO }).safeMode).toBe(false);
  });

  it("emails Arzo through Supabase in safe mode, using the Preview redirect, and does not call GoHighLevel", async () => {
    const { post, sendPortalInvite, attachInvitationAuthUser, audit, sendInvoice } = teacherApp({ safeMode: true });
    const res = await post(arzoInvite);
    expect(res.status).toBe(200);
    expect(res.body.emailed).toBe(true);
    const redirect = res.body.inviteUrl as string;
    expect(new URL(redirect).origin).toBe(PREVIEW);
    expect(new URL(redirect).pathname).toBe("/invite");
    expect(new URL(redirect).searchParams.get("token")).toBe(res.body.credential);
    expect(redirect).not.toContain("www.sftradmusic.com");
    expect(sendPortalInvite).toHaveBeenCalledTimes(1);
    expect(sendPortalInvite).toHaveBeenCalledWith(ARZO, redirect);
    expect(attachInvitationAuthUser).toHaveBeenCalledWith("inv-arzo", "auth-user-arzo");
    expect(sendInvoice).not.toHaveBeenCalled();
    expect(JSON.stringify(audit.mock.calls)).not.toContain(res.body.credential);
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
    expect(sendPortalInvite).toHaveBeenCalledWith("other@example.com", res.body.inviteUrl);
  });

  it("does not email an enrollment code", async () => {
    const { post, sendPortalInvite } = teacherApp({ safeMode: true });
    const res = await post({ ...arzoInvite, method: "code", email: "other@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.credential).toMatch(/^SFTM-/);
    expect(res.body.inviteUrl).toBeUndefined();
    expect(sendPortalInvite).not.toHaveBeenCalled();
  });

  it("does not create a student or a GoHighLevel contact when the teacher invites", async () => {
    const { post, sendPortalInvite, createInvitation, createStudent, createContact } = teacherApp({ safeMode: true });
    const res = await post({ email: "LuperDev@gmail.com", name: "Arzo Luper" });
    expect(res.status).toBe(200);
    expect(res.body.studentName).toBe("Not enrolled yet");
    expect(sendPortalInvite).toHaveBeenCalledWith(ARZO, res.body.inviteUrl);
    expect(createInvitation.mock.calls[0][0].studentIds).toEqual([]);
    expect(createStudent).not.toHaveBeenCalled();
    expect(createContact).not.toHaveBeenCalled();
  });

  it("revokes the invitation when Supabase does not accept the email", async () => {
    const { post, revokeInvitation, sendInvoice } = teacherApp({
      safeMode: true,
      send: async () => { throw new Error("smtp down"); },
    });
    const res = await post(arzoInvite);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("invite_email_failed");
    expect(JSON.stringify(res.body)).not.toContain("smtp");
    expect(revokeInvitation).toHaveBeenCalledWith("inv-arzo");
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
    expect(res.body.credential).not.toBe(first.body.credential);
    expect(res.body.inviteUrl).not.toBe(first.body.inviteUrl);
    expect(revokePendingForEmail).toHaveBeenCalledWith(ARZO);
    expect(sendPortalInvite).toHaveBeenCalledTimes(2);
    expect(createInvitation.mock.calls.every((c: any) => c[0].studentIds.length === 0)).toBe(true);
  });

  it("a revoked code cannot be used to sign up", async () => {
    const deps = buildDeps({}, null, {
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

  it("creates the student from Arzo's existing contact only after sign-up", async () => {
    const createContact = vi.fn();
    const createStudent = vi.fn(async (i: any) => ({ ...i, id: "33333333-3333-4333-8333-333333333333", firstName: "Arzo", styleLine: "", studentSince: null }));
    const createAccountForInvitation = vi.fn(async () => undefined);
    const createUser = vi.fn(async () => "auth-user");
    const ghl = fakeGhl({
      createContact,
      findContactByEmail: async (email) => (email === ARZO ? { id: "RQgd4luPVk9r2srPBlHr", name: "Arzo Luper", email } : null),
    });
    const deps = buildDeps({}, ghl, {
      findInvitationByHash: async () => invite,
      claimInvitation: async () => true,
      createStudent,
      createAccountForInvitation,
      listStudents: async () => [],
    } as any);
    (deps.auth as any).createUser = createUser;
    const res = await request(createApp(deps)).post("/api/invitations/redeem").send({ credential: token, password: "a-long-enough-password" });
    expect(res.status).toBe(200);
    expect(createContact).not.toHaveBeenCalled();
    expect((createStudent.mock.calls as any)[0][0]).toMatchObject({ fullName: "Arzo Luper", email: ARZO, ghlContactId: "RQgd4luPVk9r2srPBlHr", billingContactId: "RQgd4luPVk9r2srPBlHr", isMinor: false });
    expect((createAccountForInvitation.mock.calls as any)[0][0].studentIds).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(createUser).toHaveBeenCalled();
  });

  it("removes a new contact and audits it when the student row cannot be saved", async () => {
    const deleteContact = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const createUser = vi.fn();
    const releaseInvitation = vi.fn(async () => undefined);
    const ghl = fakeGhl({
      deleteContact,
      findContactByEmail: async () => null,
      createContact: async () => ({ contact: { id: "new-contact", name: "Arzo Luper", email: ARZO }, created: true }),
    });
    const deps = buildDeps({}, ghl, {
      findInvitationByHash: async () => invite,
      claimInvitation: async () => true,
      releaseInvitation,
      createStudent: async () => { throw new Error("db"); },
      audit,
      listStudents: async () => [],
    } as any);
    (deps.auth as any).createUser = createUser;
    const res = await request(createApp(deps)).post("/api/invitations/redeem").send({ credential: token, password: "a-long-enough-password" });
    expect(res.status).toBe(500);
    expect(deleteContact).toHaveBeenCalledWith("new-contact");
    expect(audit).toHaveBeenCalledWith(null, "student.create_failed", "", { createdContactIds: ["new-contact"] });
    expect(createUser).not.toHaveBeenCalled();
    expect(releaseInvitation).toHaveBeenCalledWith("i");
  });
});
