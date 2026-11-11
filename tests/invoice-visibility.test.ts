// QA #10: a session invoice created by a student's booking must be visible to that student's payer and to the
// teacher, and an unreadable payment_reports table (migration 0007 not applied) must not hide invoices.
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { buildDeps, captureMail, fakeGoogle, fixtureTables, STUDENT_A, STUDENT_B } from "./helpers";
import { TEACHER_ACCOUNT } from "./memoryStore";

const T0 = Date.parse("2026-11-16T17:00:00Z");
const users = {
  adultqa: { role: "student" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] },
  guardian: { role: "guardian" as const, links: [{ studentId: STUDENT_B, canBook: true, canPay: true }] },
  teach: { role: "teacher" as const },
};
const MISSING = Object.assign(new Error("store: payment_reports is missing (apply supabase/migrations/0007_payment_reports.sql): Could not find the table 'public.payment_reports' in the schema cache"), {});

function setup(opts: { reportsBroken?: boolean } = {}) {
  const tables = fixtureTables();
  for (const s of tables.students) s.teacherAccountId = TEACHER_ACCOUNT;
  tables.hours[TEACHER_ACCOUNT] = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 480, endMinute: 1020 }));
  const deps = buildDeps(users, opts.reportsBroken ? { listPaymentReports: async () => { throw MISSING; } } : {}, tables, { mailer: captureMail().mailer, google: fakeGoogle().client, now: () => T0 });
  const app = createApp(deps);
  const as = (who: string) => ({
    get: (p: string) => request(app).get(p).set("Authorization", `Bearer ${who}`),
    post: (p: string, b: object = {}) => request(app).post(p).set("Authorization", `Bearer ${who}`).send(b),
  });
  return { tables, as };
}

async function bookSession(env: ReturnType<typeof setup>) {
  const res = await env.as("adultqa").post("/api/lessons", { studentId: STUDENT_A, startTime: "2026-12-05T10:00:00-08:00", location: "Music City SF" });
  expect(res.status).toBe(200);
  return env.tables.invoices[0];
}

afterEach(() => vi.restoreAllMocks());

describe("a session invoice from a student's booking", () => {
  for (const reportsBroken of [false, true]) {
    it(`is visible to the payer and the teacher${reportsBroken ? " even when payment reports can't be read" : ""}`, async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const env = setup({ reportsBroken });
      const invoice = await bookSession(env);
      expect(invoice).toMatchObject({ kind: "session", status: "sent", paymentMethodChoice: "zelle", totalCents: 10000, studentId: STUDENT_A });

      const dash = await env.as("adultqa").get("/api/portal/dashboard");
      expect(dash.status).toBe(200);
      expect(dash.body.billing).not.toBeNull();
      expect(dash.body.billing).toMatchObject({ outstanding: 100, bookingBlocked: true, payments: [] });
      expect(dash.body.billing.history).toEqual([expect.objectContaining({ id: invoice.id, number: String(invoice.number), kind: "session", total: 100, status: "sent" })]);

      const list = await env.as("teach").get("/api/teacher/invoices");
      expect(list.status).toBe(200);
      expect(list.body.invoices).toEqual([expect.objectContaining({ id: invoice.id, studentId: STUDENT_A, amountDue: 100 })]);
      const profile = await env.as("teach").get(`/api/teacher/students/${STUDENT_A}`);
      expect(profile.body.billing.outstanding).toBe(100);

      // Another family never sees it.
      expect((await env.as("guardian").get("/api/portal/dashboard")).body.billing.history).toEqual([]);

      const logged = log.mock.calls.map((c) => c.join(" ")).join("\n");
      if (reportsBroken) expect(logged).toContain("[billing] payment reports unavailable, showing invoices without them: store: payment_reports is missing (apply supabase/migrations/0007_payment_reports.sql)");
      else expect(logged).not.toContain("payment reports unavailable");
    });
  }

  it("logs the real cause when billing itself can't be read, instead of swallowing it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = setup();
    await bookSession(env);
    const broken = buildDeps(users, { listInvoices: async () => { throw new Error("store: column invoices.kind does not exist"); } }, env.tables, { google: fakeGoogle().client, now: () => T0 });
    const app = createApp(broken);
    const dash = await request(app).get("/api/portal/dashboard").set("Authorization", "Bearer adultqa");
    expect(dash.body.billing).toBeNull();
    const list = await request(app).get("/api/teacher/invoices").set("Authorization", "Bearer teach");
    expect(list.status).toBe(500);
    const logged = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[api] dashboard: billing unavailable: store: column invoices.kind does not exist");
    expect(logged).toContain("store: column invoices.kind does not exist");
  });
});
