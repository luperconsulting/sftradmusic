import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { buildDeps } from "./helpers";
import { statSync } from "node:fs";
import { applySeed, buildArzoSeed, cleanupSeed, emptyStore, invoiceFixturePlan, pageChecks, seedGuard, videoSeedGuard } from "../scripts/arzoSeed";

const parent = { role: "guardian" as const, links: [{ studentId: "11111111-1111-4111-8111-111111111111", canBook: true, canPay: true }] };

describe("Arzo seed plan", () => {
  it("is idempotent, tagged, silent, and only about this test student", () => {
    const seed = buildArzoSeed();
    expect(seed.onlyEmail).toBe("luperdev@gmail.com");
    expect(seed.profile.ghlContactId).toBe("Nk2ovYQlqpRZJT3fwJzR");
    expect(seed.studentId).toBe("f6171db2-0a79-454f-8ef4-fcd9d8fc79fc");
    expect(seed.videos).toHaveLength(5);
    expect(seed.assignments[0].videoTitle).toBe("portal-test: Technique");
    expect(statSync(new URL("../scripts/fixtures/portal-test-arzo.mp4", import.meta.url)).size).toBeLessThan(50_000);
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
    const student = ["Student profile", "Student lessons", "Student notes", "Student practice", "Student videos", "Student balance"];
    const teacher = ["Teacher students", "Teacher profile", "Teacher notes", "Teacher videos", "Teacher assignments", "Teacher calendar", "Teacher invoices"];
    expect(checks.map((c) => c.page)).toEqual([...student, ...teacher]);
    expect(checks.find((c) => c.page === "Student videos")?.pass).toBe(true);
    expect(checks.find((c) => c.page === "Student balance")?.pass).toBe(false);
    expect(checks.some((c) => c.page === "Student messages")).toBe(false);
    expect(checks.find((c) => c.page === "Teacher invoices")?.pass).toBe(false);
  });

  it("refuses to run without write credentials or against production", () => {
    const videos = videoSeedGuard({});
    expect(videos.ok).toBe(false);
    if (!videos.ok) expect(videos.missing).toEqual(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
    expect(invoiceFixturePlan(false).write).toBe(false);
    const ready = invoiceFixturePlan(true);
    expect(ready.write && ready.rows.every((row) => row.liveMode === false)).toBe(true);
    const missing = seedGuard({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.missing).toEqual(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GHL_PRIVATE_INTEGRATION_TOKEN", "GHL_LOCATION_ID", "GHL_LESSON_CALENDAR_ID"]);
    const prod = seedGuard({ VERCEL_ENV: "production", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", GHL_PRIVATE_INTEGRATION_TOKEN: "t", GHL_LOCATION_ID: "l", GHL_LESSON_CALENDAR_ID: "c" });
    expect(prod.ok).toBe(false);
    if (!prod.ok) expect(prod.blocked).toMatch(/production/);
  });
});
