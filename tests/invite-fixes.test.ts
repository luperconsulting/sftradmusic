import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { ApiError } from "../server/http";
import { inviteRateLimitSeconds } from "../server/services/invitations";
import { buildDeps, PAYER_A, PAYER_B, STUDENT_A, STUDENT_B, studentRecord } from "./helpers";

const PREVIEW_HOST = "sftradmusic-git-feature-example.vercel.app";

function setup(over: { send?: () => Promise<string | null>; students?: Record<string, any> } = {}) {
  const order: string[] = [];
  const sendPortalInvite = vi.fn(over.send ?? (async () => { order.push("send"); return null; }));
  const createInvitation = vi.fn(async (i: any) => { order.push("create"); return { ...i, id: "new-invite", status: "pending" }; });
  const revokePendingForEmail = vi.fn(async () => { order.push("revoke"); });
  const createAccountForInvitation = vi.fn(async () => undefined);
  const students: Record<string, any> = over.students ?? {};
  const deps = buildDeps({ teach: { role: "teacher" } }, {
    createInvitation, revokePendingForEmail, createAccountForInvitation,
    getStudents: async (ids: string[]) => ids.map((id) => students[id]).filter(Boolean),
  } as any);
  deps.config.safeMode = false;
  deps.config.appUrl = "https://www.example.com";
  (deps.auth as any).sendPortalInvite = sendPortalInvite;
  const app = createApp(deps);
  const invite = (body: object, origin?: string) => {
    const r = request(app).post("/api/teacher/invitations").set("Authorization", "Bearer teach").set("Host", PREVIEW_HOST);
    return (origin ? r.set("Origin", origin) : r).send(body);
  };
  return { invite, order, sendPortalInvite, createInvitation, revokePendingForEmail };
}

const minor = { ...studentRecord(STUDENT_A, PAYER_A), fullName: "Kiroqa Luper", isMinor: true };
const adult = { ...studentRecord(STUDENT_B, PAYER_B), fullName: "Ada Luper", isMinor: false };

describe("#21 invite from a minor's row", () => {
  it("is a guardian invite linked to that student, even if sent as role student", async () => {
    const { invite, createInvitation } = setup({ students: { [STUDENT_A]: minor } });
    const res = await invite({ email: "parent@example.com", name: "Arzo Luper", role: "student", studentIds: [STUDENT_A] });
    expect(res.status).toBe(200);
    const row = createInvitation.mock.calls[0][0];
    expect(row).toMatchObject({ role: "guardian", studentIds: [STUDENT_A] });
    expect(row.preview).toMatchObject({ studentLine: "Kiroqa Luper", accountFor: "Arzo Luper · parent" });
  });

  it("keeps an adult's own invite as a student invite", async () => {
    const { invite, createInvitation } = setup({ students: { [STUDENT_B]: adult } });
    await invite({ email: "ada@example.com", role: "student", studentIds: [STUDENT_B] });
    expect(createInvitation.mock.calls[0][0]).toMatchObject({ role: "student", studentIds: [STUDENT_B] });
  });

  it("refuses a guardian invite that names no student, sending nothing", async () => {
    const { invite, sendPortalInvite } = setup();
    const res = await invite({ email: "parent@example.com", role: "guardian" });
    expect(res.status).toBe(400);
    expect(sendPortalInvite).not.toHaveBeenCalled();
  });

  it("links the guardian's new account to the child when the code is accepted", async () => {
    const createAccountForInvitation = vi.fn(async () => undefined);
    const live = { id: "i1", tokenHash: "h", method: "email", email: "parent@example.com", name: "Arzo Luper", role: "guardian", studentIds: [STUDENT_A], status: "pending", expiresAt: new Date(Date.now() + 36e5).toISOString(), preview: { firstName: "Arzo", studentLine: "Kiroqa Luper", accountFor: "Arzo Luper · parent", lessons: "", format: "In person" } };
    const deps = buildDeps({}, {
      findPendingInvitationByEmail: async () => live,
      claimInvitation: async () => true, createAccountForInvitation, audit: async () => undefined,
    } as any);
    (deps.auth as any).verifyEmailOtp = async () => ({ userId: "u-arzo", accessToken: "a", refreshToken: "r" });
    const res = await request(createApp(deps)).post("/api/invitations/verify-code").send({ email: "parent@example.com", code: "48291370" });
    expect(res.status).toBe(200);
    expect(createAccountForInvitation).toHaveBeenCalledWith(expect.objectContaining({ role: "guardian", studentIds: [STUDENT_A] }), "u-arzo");
  });
});

describe("#22 resend inside Supabase's cooldown", () => {
  it("sends first, then creates the new invitation, and only then revokes older ones", async () => {
    const { invite, order, revokePendingForEmail } = setup();
    expect((await invite({ email: "a@example.com" })).status).toBe(200);
    expect(order).toEqual(["send", "create", "revoke"]);
    expect(revokePendingForEmail).toHaveBeenCalledWith("a@example.com", "new-invite");
  });

  it("keeps the live invitation and says how long to wait when rate-limited", async () => {
    const { invite, createInvitation, revokePendingForEmail } = setup({
      send: async () => { throw new ApiError(429, "invite_rate_limited", "Please wait 28 seconds before resending."); },
    });
    const res = await invite({ email: "a@example.com" });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe("Please wait 28 seconds before resending.");
    expect(createInvitation).not.toHaveBeenCalled();
    expect(revokePendingForEmail).not.toHaveBeenCalled();
  });

  it("reads the wait from Supabase's rate-limit error", () => {
    expect(inviteRateLimitSeconds({ status: 429, message: "For security purposes, you can only request this after 28 seconds." })).toBe(28);
    expect(inviteRateLimitSeconds({ code: "over_email_send_rate_limit", message: "Email rate limit exceeded" })).toBe(60);
    expect(inviteRateLimitSeconds({ status: 500, message: "boom" })).toBeNull();
    expect(inviteRateLimitSeconds(null)).toBeNull();
  });
});

describe("invite email link", () => {
  it("points at the Preview the teacher is using", async () => {
    const { invite, sendPortalInvite } = setup();
    const res = await invite({ email: "a@example.com" }, `https://${PREVIEW_HOST}`);
    expect(sendPortalInvite).toHaveBeenCalledWith("a@example.com", `https://${PREVIEW_HOST}/invite`);
    expect(res.body.inviteUrl).toBe(`https://${PREVIEW_HOST}/invite`);
  });

  it("uses APP_URL when there's no matching Origin", async () => {
    const { invite, sendPortalInvite } = setup();
    await invite({ email: "a@example.com" });
    expect(sendPortalInvite).toHaveBeenCalledWith("a@example.com", "https://www.example.com/invite");
  });

  it("links to the redirect URL in both email templates, not the Site URL", async () => {
    const { readFileSync } = await import("node:fs");
    for (const name of ["magic-link", "invite"]) {
      const html = readFileSync(`supabase/templates/${name}.html`, "utf8");
      expect(html, name).toContain('href="{{ .RedirectTo }}"');
      expect(html, name).not.toContain("{{ .SiteURL }}/invite");
    }
  });
});
