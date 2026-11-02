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
  const deps = buildDeps({ teach: { role: "teacher" } }, fakeGhl({ sendInvoice }), {
    createInvitation, attachInvitationAuthUser, revokeInvitation, audit,
  } as any);
  deps.config.safeMode = over.safeMode ?? false;
  deps.config.appUrl = over.appUrl ?? PREVIEW;
  if (over.allowlist !== undefined) deps.config.safeModeEmailAllowlist = over.allowlist;
  (deps.auth as any).sendPortalInvite = sendPortalInvite;
  const post = (body: Record<string, unknown>) => request(createApp(deps)).post("/api/teacher/invitations").set("Authorization", "Bearer teach").send(body);
  return { post, sendPortalInvite, createInvitation, attachInvitationAuthUser, revokeInvitation, audit, sendInvoice };
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
});
