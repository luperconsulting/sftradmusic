// Supabase as the source of truth for lessons, balances, invoices and payments. Fixtures: Arzo Luper only.
import { describe, expect, it } from "vitest";
import request from "supertest";
import { OUTSTANDING_BALANCE_MESSAGE } from "../shared/portal-types";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { buildBilling, derivePaymentStatus } from "../server/services/billing";
import { buildDeps, fixtureTables, PAYER_A, PAYER_B, STUDENT_A, STUDENT_B } from "./helpers";
import { invoiceRow, lessonRow, TEACHER_ACCOUNT } from "./memoryStore";

const DAY = 864e5;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const arzo = { role: "student" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] };
const guardian = { role: "guardian" as const, links: [{ studentId: STUDENT_B, canBook: true, canPay: true }] };
const viewer = { role: "student" as const, links: [{ studentId: STUDENT_B, canBook: false, canPay: false }] };
const users = { arzo, guardian, viewer, teach: { role: "teacher" as const }, other: { role: "teacher" as const } };

function setup(seed: (t: ReturnType<typeof fixtureTables>) => void = () => undefined) {
  const tables = fixtureTables();
  for (const s of tables.students) s.teacherAccountId = TEACHER_ACCOUNT;
  seed(tables);
  const app = createApp(buildDeps(users, {}, tables));
  const get = (path: string, who: string) => request(app).get(path).set("Authorization", `Bearer ${who}`);
  const post = (path: string, who: string, body: object = {}) => request(app).post(path).set("Authorization", `Bearer ${who}`).send(body);
  return { tables, get, post };
}

describe("student portal lesson loading", () => {
  it("shows upcoming and past lessons from Supabase, leaving out cancelled and replaced ones", async () => {
    const { get } = setup((t) => {
      t.lessons.push(
        lessonRow(STUDENT_A, at(14), { id: "next-week-2" }),
        lessonRow(STUDENT_A, at(7), { id: "next-week", locationKind: "zoom", location: "Zoom" }),
        lessonRow(STUDENT_A, at(3), { id: "cancelled", status: "cancelled", cancelledAt: at(0) }),
        lessonRow(STUDENT_A, at(-7), { id: "last-week", status: "completed" }),
        lessonRow(STUDENT_A, at(-14), { id: "moved", status: "rescheduled" }),
        lessonRow(STUDENT_B, at(5), { id: "someone-else" }),
      );
    });
    const res = await get("/api/portal/dashboard", "arzo");
    expect(res.status).toBe(200);
    expect(res.body.lessonsAvailable).toBe(true);
    expect(res.body.upcoming.map((l: any) => l.id)).toEqual(["next-week", "next-week-2"]);
    expect(res.body.upcoming[0]).toMatchObject({ status: "confirmed", isZoom: true, locationLabel: "Zoom" });
    expect(res.body.history.map((l: any) => l.id)).toEqual(["last-week"]);
  });

  it("reports lessons as unavailable, not empty, when Supabase can't be read", async () => {
    const app = createApp(buildDeps(users, { listLessons: async () => { throw new Error("db down"); } }));
    const res = await request(app).get("/api/portal/dashboard").set("Authorization", "Bearer arzo");
    expect(res.status).toBe(200);
    expect(res.body.lessonsAvailable).toBe(false);
  });
});

describe("teacher portal lesson loading", () => {
  it("lists the week's lessons in the calendar with student names, and next lessons on the roster", async () => {
    const soon = at(1);
    const { get } = setup((t) => {
      t.lessons.push(lessonRow(STUDENT_A, soon, { id: "a" }), lessonRow(STUDENT_B, at(2), { id: "b" }), lessonRow(STUDENT_A, at(40), { id: "later" }), lessonRow(STUDENT_B, at(3), { id: "x", status: "cancelled", cancelledAt: at(0) }));
    });
    const now = Date.now();
    const cal = await get(`/api/teacher/calendar?from=${now}&to=${now + 7 * DAY}`, "teach");
    expect(cal.status).toBe(200);
    expect(cal.body.events.map((e: any) => [e.id, e.studentName])).toEqual([["a", "Arzo Luper"], ["b", "Arzo Luper Jr"]]);
    const roster = await get("/api/teacher/students", "teach");
    expect(roster.body.students.find((s: any) => s.id === STUDENT_A).nextLesson).toBe(soon);
    const profile = await get(`/api/teacher/students/${STUDENT_A}`, "teach");
    expect(profile.body.lessons.map((l: any) => l.id)).toEqual(["a", "later"]);
  });

  it("shows a teacher only their own students", async () => {
    const { get } = setup((t) => { t.lessons.push(lessonRow(STUDENT_A, at(1))); });
    expect((await get("/api/teacher/students", "other")).body.students).toEqual([]);
    expect((await get(`/api/teacher/students/${STUDENT_A}`, "other")).status).toBe(403);
    const now = Date.now();
    expect((await get(`/api/teacher/calendar?from=${now}&to=${now + 7 * DAY}`, "other")).body.events).toEqual([]);
  });

  it("adds, moves and cancels a lesson in Supabase, keeping the reschedule link", async () => {
    const { post, get, tables } = setup();
    const start = new Date(Date.now() + 3 * DAY).toISOString();
    const added = await post("/api/teacher/lessons", "teach", { studentId: STUDENT_A, startTime: start, location: "Music City SF" });
    expect(added.status).toBe(200);
    expect(tables.bookings).toHaveLength(1);
    const clash = await post("/api/teacher/lessons", "teach", { studentId: STUDENT_B, startTime: start, location: "Zoom" });
    expect(clash.status).toBe(409);

    const moved = await post(`/api/teacher/lessons/${added.body.lesson.id}/reschedule`, "teach", { startTime: new Date(Date.now() + 4 * DAY).toISOString() });
    expect(moved.status).toBe(200);
    expect(moved.body.lesson.rescheduledFromId).toBe(added.body.lesson.id);
    expect(tables.lessons.find((l) => l.id === added.body.lesson.id)?.status).toBe("rescheduled");

    const cancelled = await post(`/api/teacher/lessons/${moved.body.lesson.id}/cancel`, "teach", { reason: "Sick" });
    expect(cancelled.status).toBe(200);
    expect(tables.lessons.find((l) => l.id === moved.body.lesson.id)).toMatchObject({ status: "cancelled", cancellationReason: "Sick" });
    expect((await get("/api/portal/dashboard", "arzo")).body.upcoming).toEqual([]);
    expect((await post(`/api/teacher/lessons/${moved.body.lesson.id}/cancel`, "teach")).status).toBe(409);
    expect((await post("/api/teacher/lessons", "arzo", { studentId: STUDENT_A, startTime: start, location: "Zoom" })).status).toBe(403);
  });
});

describe("outstanding balance calculation", () => {
  it("adds what is still due on sent and part-paid invoices, and ignores paid, void and draft ones", () => {
    const billing = buildBilling([
      invoiceRow(STUDENT_A, PAYER_A, 9000, { id: "sent" }),
      invoiceRow(STUDENT_A, PAYER_A, 9000, { id: "part", status: "partially_paid", amountPaidCents: 4550 }),
      invoiceRow(STUDENT_A, PAYER_A, 9000, { id: "paid", status: "paid", amountPaidCents: 9000 }),
      invoiceRow(STUDENT_A, PAYER_A, 9000, { id: "void", status: "void" }),
      invoiceRow(STUDENT_A, PAYER_A, 9000, { id: "draft", status: "draft" }),
    ], []);
    expect(billing.outstanding).toBe(134.5);
    expect(billing.openInvoices.map((i) => i.id)).toEqual(["sent", "part"]);
    expect(billing.bookingBlocked).toBe(true);
    expect(billing.paymentsOpen).toBe(false);
    expect(buildBilling([], []).outstanding).toBe(0);
  });

  it("derives payment status from the amount paid", () => {
    expect(derivePaymentStatus(9000, 0, "sent")).toBe("sent");
    expect(derivePaymentStatus(9000, 100, "sent")).toBe("partially_paid");
    expect(derivePaymentStatus(9000, 9000, "partially_paid")).toBe("paid");
    expect(derivePaymentStatus(9000, 9000, "void")).toBe("void");
  });

  it("blocks portal booking with the exact message while a balance is owed, and records a teacher payment to clear it", async () => {
    const { post, get, tables } = setup((t) => { t.invoices.push(invoiceRow(STUDENT_A, PAYER_A, 9000, { id: "11111111-aaaa-4aaa-8aaa-111111111111" })); });
    const book = () => post("/api/lessons", "arzo", { studentId: STUDENT_A, startTime: at(3), location: "Zoom" });
    const blocked = await book();
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.message).toBe(OUTSTANDING_BALANCE_MESSAGE);
    expect((await get("/api/portal/dashboard", "arzo")).body.billing.outstanding).toBe(90);

    const part = await post("/api/teacher/invoices/11111111-aaaa-4aaa-8aaa-111111111111/payments", "teach", { amount: 40, method: "cash" });
    expect(part.status).toBe(200);
    expect(part.body.invoice).toMatchObject({ status: "partially_paid", amountDue: 50 });
    const rest = await post("/api/teacher/invoices/11111111-aaaa-4aaa-8aaa-111111111111/mark-paid", "teach");
    expect(rest.body.invoice).toMatchObject({ status: "paid", amountDue: 0 });
    expect(tables.payments.map((p) => p.amountCents)).toEqual([4000, 5000]);

    const dash = await get("/api/portal/dashboard", "arzo");
    expect(dash.body.billing).toMatchObject({ outstanding: 0, bookingBlocked: false });
    // No longer blocked by the balance (the slot itself isn't inside lesson hours in this fixture).
    expect((await book()).body.error.code).toBe("slot_unavailable");
    // Nothing is charged: Pay Now on a paid invoice has nothing to pay.
    expect((await post("/api/invoices/11111111-aaaa-4aaa-8aaa-111111111111/send-payment-link", "arzo")).status).toBe(409);
  });
});

describe("invoice history", () => {
  it("shows the payer every issued invoice and each recorded payment, but never drafts", async () => {
    const { get, post } = setup((t) => {
      t.invoices.push(
        invoiceRow(STUDENT_B, PAYER_B, 9000, { id: "old", number: 2001, status: "paid", amountPaidCents: 9000, issueDate: "2026-10-01" }),
        invoiceRow(STUDENT_B, PAYER_B, 9000, { id: "new", number: 2002, issueDate: "2026-11-01" }),
        invoiceRow(STUDENT_B, PAYER_B, 9000, { id: "draft", number: 2003, status: "draft" }),
        invoiceRow(STUDENT_A, PAYER_A, 5000, { id: "arzo-own", number: 2004 }),
      );
      t.payments.push({ id: "p1", invoiceId: "old", payerId: PAYER_B, amountCents: 9000, method: "check", status: "succeeded", paidAt: "2026-10-03T18:00:00.000Z", note: "", reference: "" });
    });
    const res = await get("/api/portal/dashboard", "guardian");
    expect(res.body.billing.history.map((i: any) => i.id)).toEqual(["old", "new"]);
    expect(res.body.billing.history[0]).toMatchObject({ number: "2001", total: 90, amountPaid: 90, contactName: "Arzo Luper", studentId: STUDENT_B, payUrl: null });
    expect(res.body.billing.payments).toEqual([expect.objectContaining({ invoiceNumber: "2001", amount: 90, method: "check" })]);
    expect(res.body.billing.outstanding).toBe(90);

    // A linked account that can't pay sees no invoices at all.
    expect((await get("/api/portal/dashboard", "viewer")).body.billing).toBeNull();
    // Pay Now refuses another family's invoice.
    expect((await post("/api/invoices/aaaaaaaa-0000-4000-8000-000000000000/send-payment-link", "guardian")).status).toBe(403);
  });

  it("lets the teacher list, create, issue and void invoices in Supabase", async () => {
    const { get, post } = setup();
    const draft = await post("/api/teacher/invoices", "teach", { studentId: STUDENT_B, lines: [{ label: "60-min lesson", amount: 90 }], draft: true });
    expect(draft.status).toBe(200);
    expect(draft.body.invoice).toMatchObject({ status: "draft", total: 90, contactId: PAYER_B, contactName: "Arzo Luper" });
    expect((await get("/api/portal/dashboard", "guardian")).body.billing.history).toEqual([]);
    const issued = await post(`/api/teacher/invoices/${draft.body.invoice.id}/send`, "teach");
    expect(issued.body.invoice.status).toBe("sent");
    expect((await get("/api/portal/dashboard", "guardian")).body.billing.outstanding).toBe(90);
    const list = await get("/api/teacher/invoices", "teach");
    expect(list.body.invoices.map((i: any) => i.id)).toEqual([draft.body.invoice.id]);
    expect((await post(`/api/teacher/invoices/${draft.body.invoice.id}/void`, "teach")).body.invoice.status).toBe("void");
    expect((await get("/api/portal/dashboard", "guardian")).body.billing.outstanding).toBe(0);
    const remind = await post(`/api/teacher/invoices/${draft.body.invoice.id}/remind`, "teach");
    expect(remind.body.suppressed).toBe(true);
  });
});

describe("portal behavior with all GHL env vars missing", () => {
  const env = {
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test_only_not_real",
    APP_URL: "https://preview.example.com",
    VERCEL_ENV: "preview",
  };

  it("loads both portals and creates and reads students, lessons, balances and invoices from Supabase alone", async () => {
    const saved = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("GHL_")).map((k) => [k, process.env[k]]));
    for (const k of Object.keys(saved)) delete process.env[k];
    try {
      const config = loadConfig(env);
      expect(Object.keys(config)).not.toContain("ghl");
      const tables = fixtureTables();
      for (const s of tables.students) s.teacherAccountId = TEACHER_ACCOUNT;
      const deps = buildDeps(users, {}, tables);
      deps.config = { ...config, appUrl: "https://app.example.com" };
      const app = createApp(deps);
      const as = (who: string) => ({
        get: (p: string) => request(app).get(p).set("Authorization", `Bearer ${who}`),
        post: (p: string, b: object = {}) => request(app).post(p).set("Authorization", `Bearer ${who}`).send(b),
      });
      const teach = as("teach");

      expect((await request(app).get("/api/health")).body).toEqual({ supabase: true });
      expect((await teach.get("/api/teacher/settings")).body.integrations).toMatchObject({ supabase: true, storage: true });

      const created = await teach.post("/api/teacher/students", { fullName: "Arzo Luper II", ageCategory: "child", guardianName: "Arzo Luper", guardianEmail: "luperdev+guardian@gmail.com" });
      expect(created.status).toBe(200);
      expect(created.body.guardian).toBe("reused");
      const id = created.body.student.id;
      expect((await teach.post("/api/teacher/lessons", { studentId: id, startTime: at(2), location: "Zoom" })).status).toBe(200);
      expect((await teach.post("/api/teacher/invoices", { studentId: id, lines: [{ label: "Lesson", amount: 90 }] })).status).toBe(200);

      for (const path of ["/api/teacher/students", "/api/teacher/overview", "/api/teacher/invoices", `/api/teacher/students/${id}`, `/api/teacher/calendar?from=${Date.now()}&to=${Date.now() + 7 * DAY}`]) {
        expect((await teach.get(path)).status, path).toBe(200);
      }
      const profile = await teach.get(`/api/teacher/students/${id}`);
      expect(profile.body.lessons).toHaveLength(1);
      // The lesson had no credit, so it carries its own $100 invoice, plus the $90 manual invoice.
      expect(profile.body.billing.outstanding).toBe(190);

      const family = await as("arzo").get("/api/portal/dashboard");
      expect(family.status).toBe(200);
      expect(family.body).toMatchObject({ lessonsAvailable: true, billing: { outstanding: 0 } });
      expect((await as("arzo").get("/api/me")).status).toBe(200);
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
