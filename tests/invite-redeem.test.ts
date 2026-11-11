// QA regression: the code in "Your SF Trad Music code" must be the code /invite accepts.
// The fake below behaves like Supabase Auth email OTPs: one code per address, a newer send replaces the older
// code, and a code is used up the moment it is verified. Fixtures: luperdev+adultqa@gmail.com (Arzo Luper QA).
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import type { InvitationRecord } from "../server/store/types";
import { buildDeps, fixtureTables, studentRecord } from "./helpers";

const QA_EMAIL = "luperdev+adultqa@gmail.com";
const ADULTQA = "3dccf689-0000-4000-8000-000000000001";
const CHILD = "3dccf689-0000-4000-8000-000000000002";

function harness(opts: { accountFor?: string[] } = {}) {
  const tables = fixtureTables();
  tables.students.push(
    studentRecord(ADULTQA, "aaaaaaaa-1111-4111-8111-000000000001", { firstName: "Adultqa", fullName: "Adultqa Luper", email: QA_EMAIL }),
    studentRecord(CHILD, "aaaaaaaa-1111-4111-8111-000000000002", { firstName: "Kidqa", fullName: "Kidqa Luper", isMinor: true, email: null, guardianName: "Arzo Luper", guardianEmail: "luperdev+parentqa@gmail.com" }),
  );
  const invitations: InvitationRecord[] = [];
  const accounts: { userId: string; role: string; studentIds: string[] }[] = [];
  const linked: Record<string, { accountId: string; status: "active" }> = Object.fromEntries((opts.accountFor ?? []).map((id) => [id, { accountId: "existing", status: "active" as const }]));
  const otp = new Map<string, string>();
  const emailed: { to: string; code: string }[] = [];
  let n = 0;
  const verifyCalls: string[] = [];
  const deps = buildDeps({ teach: { role: "teacher" } }, {
    createInvitation: async (i) => { const row = { ...i, id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, status: "pending" as const }; invitations.push(row); return row; },
    revokePendingForEmail: async (email, keepId) => { for (const i of invitations) if (i.email === email && i.status === "pending" && i.id !== keepId) i.status = "revoked"; },
    findPendingInvitationByEmail: async (email) => [...invitations].reverse().find((i) => i.email === email.toLowerCase() && i.status === "pending") ?? null,
    getInvitation: async (id) => invitations.find((x) => x.id === id) ?? null,
    claimInvitation: async (id) => { const i = invitations.find((x) => x.id === id); if (!i || i.status !== "pending") return false; i.status = "accepted"; return true; },
    releaseInvitation: async (id) => { invitations.find((x) => x.id === id)!.status = "pending"; },
    createAccountForInvitation: async (invite, userId) => { accounts.push({ userId, role: invite.role, studentIds: invite.studentIds }); for (const s of invite.studentIds) linked[s] = { accountId: userId, status: "active" }; },
    studentAccounts: async () => ({ ...linked }),
  }, tables);
  deps.config.safeMode = false;
  // Supabase: signInWithOtp emails an 8-digit code; verifyOtp type "email" accepts it once.
  (deps.auth as any).sendPortalInvite = async (email: string) => {
    const code = String(10000000 + ((n * 7919 + emailed.length * 104729) % 89999999));
    otp.set(email.toLowerCase(), code);
    emailed.push({ to: email, code });
    return null;
  };
  (deps.auth as any).verifyEmailOtp = async (email: string, code: string) => {
    verifyCalls.push(email);
    if (otp.get(email.toLowerCase()) !== code) return null;
    otp.delete(email.toLowerCase());
    return { userId: `user-${email}`, accessToken: "access-token", refreshToken: "refresh-token" };
  };
  const app = createApp(deps);
  const teacher = (body: object) => request(app).post("/api/teacher/invitations").set("Authorization", "Bearer teach").send(body);
  const redeem = (email: string, code: string) => request(app).post("/api/invitations/verify-code").send({ email, code });
  return { app, invitations, accounts, emailed, verifyCalls, linked, teacher, redeem };
}

describe("invite code: the code that is emailed is the code that is verified", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates an invite and redeems its exact emailed code, linking the existing adult student", async () => {
    const h = harness();
    const created = await h.teacher({ email: "LuperDev+AdultQA@gmail.com" });
    expect(created.status).toBe(200);
    expect(created.body.studentName).toBe("Adultqa Luper");
    expect(h.invitations[0]).toMatchObject({ email: QA_EMAIL, role: "student", studentIds: [ADULTQA], status: "pending" });
    const { to, code } = h.emailed[0];
    expect(to).toBe(QA_EMAIL);
    expect(code).toMatch(/^\d{8}$/);
    // Typed with different case, exactly as received.
    const res = await h.redeem("LuperDev+AdultQA@gmail.com", code);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accessToken: "access-token", refreshToken: "refresh-token", email: QA_EMAIL });
    expect(h.accounts).toEqual([{ userId: `user-${QA_EMAIL}`, role: "student", studentIds: [ADULTQA] }]);
    expect(h.invitations[0].status).toBe("accepted");
  });

  it("checks setup before spending the code, so a refused sign-up doesn't burn it (the QA failure)", async () => {
    const h = harness({ accountFor: [ADULTQA] });
    // An invite for an email that isn't linkable (the adult already has an account) and has no student chosen.
    await h.teacher({ email: QA_EMAIL });
    expect(h.invitations[0].studentIds).toEqual([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { code } = h.emailed[0];
    const refused = await h.redeem(QA_EMAIL, code);
    expect(refused.status).toBe(409);
    expect(h.verifyCalls).toHaveLength(0);
    expect(h.invitations[0].status).toBe("pending");
    // The cause is fixed (here: the stale account link goes away); the same emailed code still works.
    delete h.linked[ADULTQA];
    const ok = await h.redeem(QA_EMAIL, code);
    expect(ok.status).toBe(200);
    const logs = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain("[invite] verify-code rejected: account setup check failed before the code was used: student_already_exists (invitation 00000000-0000-4000-8000-000000000001)");
    expect(logs).not.toContain(code);
    expect(logs).not.toContain(QA_EMAIL);
  });

  it("logs why a code was refused, without the code or the address", async () => {
    const h = harness();
    await h.teacher({ email: QA_EMAIL });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const wrong = await h.redeem(QA_EMAIL, "12345678");
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toBe("That code isn't valid or has expired.");
    const none = await h.redeem("luperdev+nobody@gmail.com", h.emailed[0].code);
    expect(none.status).toBe(404);
    const logs = warn.mock.calls.map((c) => String(c[0]));
    expect(logs).toEqual([
      "[invite] verify-code rejected: Supabase did not accept the email code (wrong, already used, replaced by a newer code, or expired) (invitation 00000000-0000-4000-8000-000000000001)",
      "[invite] verify-code rejected: no pending invitation for this email",
    ]);
    expect(logs.join(" ")).not.toContain(h.emailed[0].code);
    expect(logs.join(" ")).not.toContain("12345678");
    expect(logs.join(" ")).not.toContain("luperdev");
    // The real code still works afterwards.
    expect((await h.redeem(QA_EMAIL, h.emailed[0].code)).status).toBe(200);
  });

  it("after a resend only the newest emailed code works", async () => {
    const h = harness();
    await h.teacher({ email: QA_EMAIL });
    const resent = await request(h.app).post(`/api/teacher/invitations/${h.invitations[0].id}/resend`).set("Authorization", "Bearer teach");
    expect(resent.status).toBe(200);
    expect(h.emailed).toHaveLength(2);
    expect(h.emailed[0].code).not.toBe(h.emailed[1].code);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await h.redeem(QA_EMAIL, h.emailed[0].code)).status).toBe(401);
    expect((await h.redeem(QA_EMAIL, h.emailed[1].code)).status).toBe(200);
    expect(h.invitations.map((i) => i.status)).toEqual(["revoked", "accepted"]);
  });

  it("a guardian invite with a picked child links that child; with no pick it links the children with that guardian email", async () => {
    const h = harness();
    const picked = await h.teacher({ email: "luperdev+parentqa@gmail.com", role: "guardian", studentIds: [CHILD] });
    expect(picked.body.studentName).toBe("Kidqa Luper");
    const auto = harness();
    const matched = await auto.teacher({ email: "luperdev+parentqa@gmail.com", role: "guardian" });
    expect(matched.status).toBe(200);
    expect(auto.invitations[0]).toMatchObject({ role: "guardian", studentIds: [CHILD] });
    expect((await auto.redeem("luperdev+parentqa@gmail.com", auto.emailed[0].code)).status).toBe(200);
    expect(auto.accounts[0]).toMatchObject({ role: "guardian", studentIds: [CHILD] });
  });
});
