import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { FEATURE_REVIEWS, featuresForEnv } from "../server/features";
import { buildDeps } from "./helpers";
import { applySeed, buildArzoSeed, cleanupSeed, emptyStore, pageChecks, seedGuard } from "../scripts/arzoSeed";

const parent = { role: "guardian" as const, links: [{ studentId: "11111111-1111-4111-8111-111111111111", canBook: true, canPay: true }] };

describe("Arzo seed plan", () => {
  it("is idempotent, tagged, silent, and only about this test student", () => {
    const seed = buildArzoSeed();
    expect(seed.onlyEmail).toBe("luperdev@gmail.com");
    expect(seed.profile.ghlContactId).toBe("RQgd4luPVk9r2srPBlHr");
    expect(seed.sendsEmail).toBe(false);
    expect(seed.sendsSms).toBe(false);
    expect(seed.lessons.every((l) => l.toNotify === false && l.title.startsWith("portal-test:"))).toBe(true);
    const store = applySeed(emptyStore(), seed);
    const again = applySeed(store, seed);
    expect(again.rows.filter((r) => r.kind === "note")).toHaveLength(2);
    expect(again.appointments).toHaveLength(2);
    expect(again.emails).toEqual([]);
    expect(again.sms).toEqual([]);
    cleanupSeed(again);
    expect(again.rows.map((r) => r.kind)).toEqual(["profile"]);
    expect(again.appointments).toEqual([]);
  });

  it("checks every student and teacher page and leaves invoices and messages unwritten", () => {
    const checks = pageChecks(buildArzoSeed());
    const student = ["Student profile", "Student lessons", "Student notes", "Student practice", "Student videos", "Student balance", "Student messages"];
    const teacher = ["Teacher students", "Teacher profile", "Teacher notes", "Teacher videos", "Teacher assignments", "Teacher calendar", "Teacher invoices"];
    expect(checks.map((c) => c.page)).toEqual([...student, ...teacher]);
    expect(checks.find((c) => c.page === "Student videos")?.pass).toBe(true);
    expect(checks.find((c) => c.page === "Student balance")?.pass).toBe(false);
    expect(checks.find((c) => c.page === "Student messages")?.pass).toBe(false);
    expect(checks.find((c) => c.page === "Teacher invoices")?.pass).toBe(false);
  });

  it("refuses to run without write credentials or against production", () => {
    const missing = seedGuard({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.missing).toEqual(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GHL_PRIVATE_INTEGRATION_TOKEN", "GHL_LOCATION_ID", "GHL_LESSON_CALENDAR_ID"]);
    const prod = seedGuard({ VERCEL_ENV: "production", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", GHL_PRIVATE_INTEGRATION_TOKEN: "t", GHL_LOCATION_ID: "l", GHL_LESSON_CALENDAR_ID: "c" });
    expect(prod.ok).toBe(false);
    if (!prod.ok) expect(prod.blocked).toMatch(/production/);
  });
});

describe("feature flags", () => {
  it("keeps every flag off on preview and production because none passed", () => {
    expect(featuresForEnv({ VERCEL_ENV: "preview" })).toEqual({ packages: false, autopay: false, referrals: false, recurring: false, invoiceActions: false });
    expect(featuresForEnv({ VERCEL_ENV: "production" })).toEqual(featuresForEnv({ VERCEL_ENV: "preview" }));
    expect(Object.values(FEATURE_REVIEWS).every((r) => r.pass === false)).toBe(true);
  });

  it("leaves package, autopay, referral, and invoice actions returning 501", async () => {
    const app = createApp(buildDeps({ parent, t: { role: "teacher" } }));
    for (const path of ["/api/packages/purchase", "/api/autopay", "/api/referrals/invite", "/api/referrals/apply"]) {
      expect((await request(app).post(path).set("Authorization", "Bearer parent").send({})).status).toBe(501);
    }
    for (const action of ["send", "remind", "void", "mark-paid"]) {
      expect((await request(app).post(`/api/teacher/invoices/x/${action}`).set("Authorization", "Bearer t").send({})).status).toBe(501);
    }
  });
});
