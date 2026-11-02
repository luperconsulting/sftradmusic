import { generateKeyPairSync, createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { supabaseKeyKind } from "../shared/supabase-keys";
import { hashCredential, newEnrollmentCode } from "../server/services/invitations";
import { verifyWebhookSignature } from "../server/webhooks";
import { memoryRateLimiter } from "../server/rateLimit";
import { buildDeps, STUDENT_A, STUDENT_B } from "./helpers";

const parent = { role: "guardian" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] };
const get = (app: any, path: string, token?: string) => {
  const r = request(app).get(path);
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};

describe("authentication", () => {
  it.each(["/api/me", "/api/portal/dashboard", "/api/lessons/slots", "/api/teacher/students", "/api/teacher/invoices", "/api/teacher/invitations"])("rejects %s without a session", async (path) => {
    expect((await get(createApp(buildDeps({})), path)).status).toBe(401);
  });

  it("returns 503 rather than simulating sign-in when Supabase isn't configured", async () => {
    const deps = { ...buildDeps({}), store: null, auth: null };
    expect((await get(createApp(deps), "/api/me", "x")).status).toBe(503);
  });

  it("blocks suspended accounts", async () => {
    const app = createApp(buildDeps({ s: { ...parent, status: "suspended" } }));
    const res = await get(app, "/api/portal/dashboard", "s");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("account_suspended");
  });
});

describe("role and 2FA enforcement", () => {
  it("keeps families out of teacher routes", async () => {
    expect((await get(createApp(buildDeps({ parent })), "/api/teacher/students", "parent")).status).toBe(403);
  });

  it("requires a verified second factor for the teacher, whatever the UI does", async () => {
    const res = await get(createApp(buildDeps({ t: { role: "teacher", aal: "aal1" } })), "/api/teacher/students", "t");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("mfa_required");
  });

  it.each(["guardian", "student"] as const)("requires a verified second factor for a %s account", async (role) => {
    const u = { role, links: parent.links };
    const passwordOnly = await get(createApp(buildDeps({ p: { ...u, mfa: true, aal: "aal1" } })), "/api/portal/dashboard", "p");
    expect(passwordOnly.body.error.code).toBe("mfa_required");
    const notEnrolled = await get(createApp(buildDeps({ p: { ...u, mfa: false, aal: "aal1" } })), "/api/portal/dashboard", "p");
    expect(notEnrolled.body.error.code).toBe("mfa_required");
  });

  it("rejects a 2FA-level session whose account no longer has a factor", async () => {
    const res = await get(createApp(buildDeps({ p: { ...parent, mfa: false, aal: "aal2" } })), "/api/portal/dashboard", "p");
    expect(res.body.error.code).toBe("mfa_required");
  });

  it("still lets a password-only session read its profile, so setup can start", async () => {
    const deps = buildDeps({ p: { ...parent, mfa: false, aal: "aal1" } }, null, { getAccount: async () => ({ id: "p", userId: "p", role: "guardian", status: "active", email: "", displayName: "T U", ghlContactId: null }) });
    expect((await get(createApp(deps), "/api/me", "p")).status).toBe(200);
  });

  it("lets a fully verified teacher in", async () => {
    const deps = buildDeps({ t: { role: "teacher", aal: "aal2" } }, null, { studentCounts: async () => ({}), studentAccounts: async () => ({}) });
    expect((await get(createApp(deps), "/api/teacher/students", "t")).status).toBe(200);
  });
});

describe("family boundaries", () => {
  it("refuses another family's student", async () => {
    expect((await get(createApp(buildDeps({ parent })), `/api/portal/dashboard?studentId=${STUDENT_B}`, "parent")).status).toBe(403);
  });

  it("only ever asks the store for published notes on the family dashboard", async () => {
    const listNotes = vi.fn(async () => []);
    await get(createApp(buildDeps({ parent }, null, { listNotes })), "/api/portal/dashboard", "parent");
    expect(listNotes).toHaveBeenCalledWith(STUDENT_A, { publishedOnly: true });
  });

  it("never sends GoHighLevel contact IDs to the browser", async () => {
    const res = await get(createApp(buildDeps({ parent })), "/api/portal/dashboard", "parent");
    expect(JSON.stringify(res.body)).not.toMatch(/contactA|payerA|ghlContactId|billingContactId/);
  });

  it("reports unreadable billing as null, never as a zero balance", async () => {
    const res = await get(createApp(buildDeps({ parent }, null)), "/api/portal/dashboard", "parent");
    expect(res.status).toBe(200);
    expect(res.body.billing).toBeNull();
  });

  it("keeps a teacher preview read-only and audits it", async () => {
    const audit = vi.fn(async () => undefined);
    const app = createApp(buildDeps({ t: { role: "teacher", aal: "aal2" } }, null, { audit }));
    const res = await get(app, `/api/portal/dashboard?studentId=${STUDENT_A}`, "t");
    expect(res.body.readOnly).toBe(true);
    expect(res.body.canBook).toBe(false);
    expect(audit).toHaveBeenCalledWith("t", "teacher.preview_student", STUDENT_A, undefined);
  });
});

describe("financial features stay off", () => {
  it.each(["/api/packages/purchase", "/api/autopay", "/api/referrals/invite", "/api/referrals/apply"])("%s is not enabled", async (path) => {
    const res = await request(createApp(buildDeps({ parent }))).post(path).set("Authorization", "Bearer parent").send({});
    expect(res.status).toBe(501);
  });

  it("the portal can't mark an invoice paid", async () => {
    const res = await request(createApp(buildDeps({ t: { role: "teacher", aal: "aal2" } }))).post("/api/teacher/invoices/x/mark-paid").set("Authorization", "Bearer t");
    expect(res.status).toBe(501);
  });
});

describe("invitations", () => {
  const invite = { id: "i", tokenHash: "h", method: "code", email: "n@example.com", name: "N", role: "guardian", studentIds: [STUDENT_A], status: "pending", expiresAt: new Date(Date.now() + 864e5).toISOString(), preview: {} };

  it("has no open registration: a bad code gets nothing", async () => {
    const deps = buildDeps({}, null, { findInvitationByHash: async () => null });
    const res = await request(createApp(deps)).post("/api/invitations/redeem").send({ credential: "SFTM-AAAA-BBBB", password: "a-long-enough-password" });
    expect(res.status).toBe(404);
  });

  it("refuses an expired invitation", async () => {
    const deps = buildDeps({}, null, { findInvitationByHash: async () => ({ ...invite, expiresAt: new Date(0).toISOString() }) as any });
    expect((await request(createApp(deps)).post("/api/invitations/verify").send({ credential: "SFTM-AAAA-BBBB" })).status).toBe(410);
  });

  it("only lets one redemption win", async () => {
    const deps = buildDeps({}, null, { findInvitationByHash: async () => invite as any, claimInvitation: async () => false });
    const createUser = vi.fn();
    (deps.auth as any).createUser = createUser;
    const res = await request(createApp(deps)).post("/api/invitations/redeem").send({ credential: "SFTM-AAAA-BBBB", password: "a-long-enough-password" });
    expect(res.status).toBe(404);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("rejects short passwords", async () => {
    const res = await request(createApp(buildDeps({}))).post("/api/invitations/redeem").send({ credential: "SFTM-AAAA-BBBB", password: "short" });
    expect(res.status).toBe(400);
  });

  it("rate limits code guessing", async () => {
    const app = createApp(buildDeps({}, null, { findInvitationByHash: async () => null }));
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await request(app).post("/api/invitations/verify").send({ credential: "SFTM-AAAA-BBBB" })).status;
    expect(last).toBe(429);
  });

  it("generates long codes and hashes them case-insensitively", () => {
    const code = newEnrollmentCode();
    expect(code).toMatch(/^SFTM-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(hashCredential(code.toLowerCase())).toBe(hashCredential(code));
    expect(hashCredential(code)).not.toContain(code);
  });
});

describe("request hygiene", () => {
  it("rejects cross-origin writes", async () => {
    const res = await request(createApp(buildDeps({}))).post("/api/invitations/verify").set("Origin", "https://evil.example.com").send({ credential: "SFTM-AAAA-BBBB" });
    expect(res.status).toBe(403);
  });

  it("doesn't leak internal errors", async () => {
    const deps = buildDeps({ parent }, null, { getStudents: async () => { throw new Error("secret db detail"); } });
    const res = await get(createApp(deps), "/api/portal/dashboard", "parent");
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("the limiter resets after its window", () => {
    let t = 0;
    const l = memoryRateLimiter(() => t);
    l.hit("k", 1, 10);
    expect(() => l.hit("k", 1, 10)).toThrow();
    t = 11;
    expect(() => l.hit("k", 1, 10)).not.toThrow();
  });
});

describe("webhook signatures", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const body = Buffer.from('{"type":"InvoicePaid"}');
  const sig = createSign("RSA-SHA256").update(body).end().sign(privateKey, "base64");

  it("accepts a valid signature and rejects anything else", () => {
    expect(verifyWebhookSignature(body, sig, pem)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from("tampered"), sig, pem)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, pem)).toBe(false);
    expect(verifyWebhookSignature(body, sig, null)).toBe(false);
  });

  it("the route refuses unsigned events", async () => {
    const res = await request(createApp(buildDeps({}))).post("/api/webhooks/ghl").send({ type: "InvoicePaid" });
    expect(res.status).toBe(401);
  });
});

describe("account creation and roles", () => {
  const invite = { id: "i", tokenHash: "h", method: "code", email: "n@example.com", name: "N", role: "guardian", studentIds: [STUDENT_A], status: "pending", expiresAt: new Date(Date.now() + 864e5).toISOString(), preview: {} };
  const body = { credential: "SFTM-AAAA-BBBB", password: "a-long-enough-password" };

  it("gives a Supabase login with no portal account no access, so a public sign-up gets nothing", async () => {
    const deps = buildDeps({});
    (deps.auth as any).verifyToken = async () => ({ userId: "stranger", email: "x@example.com", aal: "aal2", mfaEnrolled: false });
    const res = await get(createApp(deps), "/api/me", "any");
    expect(res.status).toBe(403);
  });

  it("can't invite a teacher, even as the teacher", async () => {
    const res = await request(createApp(buildDeps({ t: { role: "teacher", aal: "aal2" } })))
      .post("/api/teacher/invitations").set("Authorization", "Bearer t")
      .send({ method: "code", role: "teacher", email: "a@example.com", name: "A", studentIds: [STUDENT_A] });
    expect(res.status).toBe(400);
  });

  it("takes the role from the invitation, ignoring anything in the request", async () => {
    const createAccountForInvitation = vi.fn(async () => undefined);
    const deps = buildDeps({}, null, { findInvitationByHash: async () => invite as any, claimInvitation: async () => true, createAccountForInvitation });
    (deps.auth as any).createUser = async () => "new-user";
    const res = await request(createApp(deps)).post("/api/invitations/redeem").send({ ...body, role: "teacher", studentIds: [STUDENT_B] });
    expect(res.status).toBe(200);
    expect((createAccountForInvitation.mock.calls as any)[0][0]).toMatchObject({ role: "guardian", studentIds: [STUDENT_A] });
  });

  it("removes the login and reopens the invitation if account setup fails", async () => {
    const releaseInvitation = vi.fn(async () => undefined);
    const deleteUser = vi.fn(async () => undefined);
    const deps = buildDeps({}, null, { findInvitationByHash: async () => invite as any, claimInvitation: async () => true, releaseInvitation, createAccountForInvitation: async () => { throw new Error("db"); } });
    Object.assign(deps.auth as any, { createUser: async () => "new-user", deleteUser });
    expect((await request(createApp(deps)).post("/api/invitations/redeem").send(body)).status).toBe(500);
    expect(deleteUser).toHaveBeenCalledWith("new-user");
    expect(releaseInvitation).toHaveBeenCalledWith("i");
  });
});

describe("billing visibility", () => {
  it("hides invoices from a linked account that can't pay", async () => {
    const viewer = { role: "student" as const, links: [{ studentId: STUDENT_A, canBook: false, canPay: false }] };
    const res = await get(createApp(buildDeps({ viewer })), "/api/portal/dashboard", "viewer");
    expect(res.status).toBe(200);
    expect(res.body.billing).toBeNull();
  });

  it("shows invoices to the payer", async () => {
    const res = await get(createApp(buildDeps({ parent })), "/api/portal/dashboard", "parent");
    expect(res.body.billing).not.toBeNull();
  });
});

describe("Supabase configuration", () => {
  const jwt = (role: string) => `h.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.s`;
  const base = { SUPABASE_URL: "https://x.supabase.co" };

  it("recognizes new and legacy key formats", () => {
    expect(supabaseKeyKind("sb_publishable_abc")).toBe("public");
    expect(supabaseKeyKind("sb_secret_abc")).toBe("secret");
    expect(supabaseKeyKind(jwt("anon"))).toBe("public");
    expect(supabaseKeyKind(jwt("service_role"))).toBe("secret");
    expect(supabaseKeyKind("nonsense")).toBe("unknown");
  });

  it("accepts either secret format on the server", () => {
    expect(loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc" }).supabase).not.toBeNull();
    expect(loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: jwt("service_role") }).supabase).not.toBeNull();
  });

  it("stays not configured when given a public key or nothing", () => {
    expect(loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_abc" }).supabase).toBeNull();
    expect(loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: jwt("anon") }).supabase).toBeNull();
    expect(loadConfig(base).supabase).toBeNull();
  });
});

describe("Vercel routing", () => {
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  const sources: string[] = vercel.rewrites.map((r: any) => r.source);

  it("sends every portal route to the portal page and the API to the function", () => {
    for (const s of ["/signin", "/signup", "/invite", "/verify", "/denied", "/reset-password", "/portal/(.*)", "/teacher", "/teacher/(.*)"]) {
      expect(vercel.rewrites.find((r: any) => r.source === s)?.destination).toBe("/portal");
    }
    expect(vercel.rewrites.find((r: any) => r.source === "/api/(.*)")?.destination).toBe("/api");
    expect(existsSync("portal.html")).toBe(true);
    expect(vercel.cleanUrls).toBe(true); // this is what serves /portal itself from portal.html
    expect(sources).not.toContain("/");
    expect(sources).not.toContain("/book");
  });

  it("keeps portal pages out of search engines and API responses out of caches", () => {
    for (const s of ["/signin", "/reset-password", "/portal", "/teacher", "/api/(.*)"]) {
      const headers = vercel.headers.find((h: any) => h.source === s)?.headers.map((x: any) => x.key);
      expect(headers).toEqual(expect.arrayContaining(["X-Robots-Tag", "Cache-Control"]));
    }
  });
});
