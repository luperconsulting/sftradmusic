import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { buildDeps, PAYER_A, PAYER_B, STUDENT_A, STUDENT_B, studentRecord } from "./helpers";

// #23: the project has public sign-ups off, so signInWithOtp alone fails with 422 signup_disabled for any
// email that has no auth user yet. The adapter must create the login with the service role first.

type AuthResult = { data: { user?: { id: string } | null }; error: { status?: number; code?: string; message?: string } | null };
const calls: string[] = [];
const fake = {
  createUser: vi.fn<(...a: unknown[]) => Promise<AuthResult>>(),
  signInWithOtp: vi.fn<(...a: unknown[]) => Promise<AuthResult>>(),
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      admin: { createUser: (...a: unknown[]) => fake.createUser(...a) },
      signInWithOtp: (...a: unknown[]) => fake.signInWithOtp(...a),
    },
  }),
}));

const { createSupabaseAuthAdmin } = await import("../server/store/supabaseStore");

const minor = { ...studentRecord(STUDENT_A, PAYER_A), fullName: "Kiroqa Luper", isMinor: true };
const adult = { ...studentRecord(STUDENT_B, PAYER_B), fullName: "Ada Luper", isMinor: false };

function setup() {
  const order: string[] = [];
  const createInvitation = vi.fn(async (i: any) => { order.push("create"); return { ...i, id: "new-invite", status: "pending" }; });
  const revokePendingForEmail = vi.fn(async () => { order.push("revoke"); });
  const students: Record<string, any> = { [STUDENT_A]: minor, [STUDENT_B]: adult };
  const deps = buildDeps({ teach: { role: "teacher" } }, {
    createInvitation, revokePendingForEmail,
    getStudents: async (ids: string[]) => ids.map((id) => students[id]).filter(Boolean),
  } as any);
  deps.config.safeMode = false;
  deps.config.appUrl = "https://www.example.com";
  // The real adapter, talking to the mocked Supabase client. Only the invite send is swapped in.
  const real = createSupabaseAuthAdmin("https://proj.supabase.co", "service-role-key-for-tests", deps.config.appUrl);
  (deps.auth as any).sendPortalInvite = real.sendPortalInvite;
  const app = createApp(deps);
  const invite = (body: object) => request(app).post("/api/teacher/invitations").set("Authorization", "Bearer teach").send(body);
  return { invite, order, createInvitation, revokePendingForEmail };
}

beforeEach(() => {
  calls.length = 0;
  fake.createUser.mockReset().mockImplementation(async () => { calls.push("createUser"); return { data: { user: { id: "u-new" } }, error: null }; });
  fake.signInWithOtp.mockReset().mockImplementation(async () => { calls.push("signInWithOtp"); return { data: {}, error: null }; });
});

describe("#23 first-time email invites", () => {
  it("creates the adult's login with the service role, then emails the code without asking GoTrue to sign them up", async () => {
    const { invite, order, createInvitation } = setup();
    const res = await invite({ email: "adultqa@example.com", name: "Ada Luper", role: "student", studentIds: [STUDENT_B] });
    expect(res.status).toBe(200);
    expect(res.body.emailed).toBe(true);
    expect(calls).toEqual(["createUser", "signInWithOtp"]);
    expect(fake.createUser).toHaveBeenCalledWith({ email: "adultqa@example.com", email_confirm: true });
    expect(fake.signInWithOtp).toHaveBeenCalledWith({
      email: "adultqa@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: "https://www.example.com/invite" },
    });
    expect(order).toEqual(["create", "revoke"]);
    expect(createInvitation.mock.calls[0][0]).toMatchObject({ role: "student", studentIds: [STUDENT_B], email: "adultqa@example.com" });
  });

  it("does the same for a first-time guardian, keeping the invite linked to the child", async () => {
    const { invite, createInvitation } = setup();
    const res = await invite({ email: "parentqa@example.com", name: "Arzo Luper", role: "guardian", studentIds: [STUDENT_A] });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["createUser", "signInWithOtp"]);
    expect(fake.createUser).toHaveBeenCalledWith({ email: "parentqa@example.com", email_confirm: true });
    expect(createInvitation.mock.calls[0][0]).toMatchObject({ role: "guardian", studentIds: [STUDENT_A] });
    expect(createInvitation.mock.calls[0][0].preview).toMatchObject({ studentLine: "Kiroqa Luper", accountFor: "Arzo Luper · parent" });
  });

  it("reuses an existing login instead of failing when the email is already registered", async () => {
    fake.createUser.mockImplementation(async () => { calls.push("createUser"); return { data: { user: null }, error: { status: 422, code: "email_exists", message: "A user with this email address has already been registered" } }; });
    const { invite, createInvitation } = setup();
    const res = await invite({ email: "luperdev@example.com" });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["createUser", "signInWithOtp"]);
    expect(createInvitation).toHaveBeenCalledTimes(1);
  });

  it("gives the teacher a clear error if GoTrue still refuses to sign the email up, and keeps older invites", async () => {
    fake.signInWithOtp.mockImplementation(async () => { calls.push("signInWithOtp"); return { data: {}, error: { status: 422, code: "signup_disabled", message: "Signups not allowed for this instance" } }; });
    const { invite, createInvitation, revokePendingForEmail } = setup();
    const res = await invite({ email: "adultqa@example.com" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("invite_signup_disabled");
    expect(res.body.error.message).toMatch(/no login for this email/i);
    expect(createInvitation).not.toHaveBeenCalled();
    expect(revokePendingForEmail).not.toHaveBeenCalled();
  });

  it("sends nothing and creates nothing when the login can't be created", async () => {
    fake.createUser.mockImplementation(async () => { calls.push("createUser"); return { data: { user: null }, error: { status: 500, code: "unexpected_failure", message: "boom" } }; });
    const { invite, createInvitation } = setup();
    const res = await invite({ email: "adultqa@example.com" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("invite_email_failed");
    expect(calls).toEqual(["createUser"]);
    expect(createInvitation).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("service-role-key-for-tests");
  });

  it("still reports Supabase's resend cooldown with the wait", async () => {
    fake.signInWithOtp.mockImplementation(async () => { calls.push("signInWithOtp"); return { data: {}, error: { status: 429, code: "over_email_send_rate_limit", message: "For security purposes, you can only request this after 41 seconds." } }; });
    const { invite } = setup();
    const res = await invite({ email: "adultqa@example.com" });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe("Please wait 41 seconds before resending.");
  });
});
