// Manual "Pay with Zelle": report-then-confirm. Fixtures: Arzo Luper (adult, STUDENT_A) and Arzo Luper Jr
// (child, STUDENT_B, guardian on a luperdev alias). luperdev@gmail.com addresses only.
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { buildDeps, captureMail, fakeGoogle, fixtureTables, PAYER_A, PAYER_B, STUDENT_A, STUDENT_B } from "./helpers";
import { invoiceRow, TEACHER_ACCOUNT } from "./memoryStore";

const INV_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const INV_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const users = {
  arzo: { role: "student" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] },
  guardian: { role: "guardian" as const, links: [{ studentId: STUDENT_B, canBook: true, canPay: true }] },
  viewer: { role: "student" as const, links: [{ studentId: STUDENT_A, canBook: false, canPay: false }] },
  teach: { role: "teacher" as const },
  other: { role: "teacher" as const },
  weak: { role: "teacher" as const, aal: "aal1" },
};

function setup(recipient = "luperdev+zelle@gmail.com", qr: string | null = QR) {
  const tables = fixtureTables();
  for (const s of tables.students) s.teacherAccountId = TEACHER_ACCOUNT;
  tables.settings[TEACHER_ACCOUNT] = { teacherAccountId: TEACHER_ACCOUNT, holdWindowMinutes: 1440, rescheduleNoticeHours: 24, cancelNoticeHours: 24, zelleRecipient: recipient, zelleQrDataUrl: qr, timezone: "America/Los_Angeles" };
  tables.invoices.push(
    invoiceRow(STUDENT_A, PAYER_A, 38000, { id: INV_A, number: 1042, kind: "package", packageLessons: 4, paymentMethodChoice: "zelle" }),
    invoiceRow(STUDENT_B, PAYER_B, 10000, { id: INV_B, number: 1043, kind: "manual" }),
  );
  const mail = captureMail();
  const app = createApp(buildDeps(users, {}, tables, { mailer: mail.mailer, google: fakeGoogle().client }));
  const as = (who: string) => ({
    get: (p: string) => request(app).get(p).set("Authorization", `Bearer ${who}`),
    post: (p: string, b: object = {}) => request(app).post(p).set("Authorization", `Bearer ${who}`).send(b),
    put: (p: string, b: object = {}) => request(app).put(p).set("Authorization", `Bearer ${who}`).send(b),
  });
  return { tables, as, mail, app };
}

describe("Pay with Zelle panel", () => {
  it("shows the recipient, exact amount due, SFTM memo and QR to a payer linked to the invoice", async () => {
    const env = setup();
    const res = await env.as("arzo").get(`/api/invoices/${INV_A}/zelle`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, recipient: "luperdev+zelle@gmail.com", amountDue: 380, memo: "SFTM-1042", qrDataUrl: QR, report: null });
  });

  it("is hidden with 'Ask your teacher how to pay.' when no recipient is set", async () => {
    const env = setup("   ", null);
    const res = await env.as("arzo").get(`/api/invoices/${INV_A}/zelle`);
    expect(res.body).toEqual({ available: false, message: "Ask your teacher how to pay.", amountDue: 380, memo: "SFTM-1042", report: null });
    expect(res.body.recipient).toBeUndefined();
    expect(res.body.qrDataUrl).toBeUndefined();
  });

  it("serves the recipient only to signed-in payers linked to the invoice", async () => {
    const env = setup();
    expect((await request(env.app).get(`/api/invoices/${INV_A}/zelle`)).status).toBe(401);
    expect((await env.as("guardian").get(`/api/invoices/${INV_A}/zelle`)).status).toBe(403);
    expect((await env.as("viewer").get(`/api/invoices/${INV_A}/zelle`)).status).toBe(403);
    expect((await env.as("teach").get(`/api/invoices/${INV_A}/zelle`)).status).toBe(403);
    // The dashboard policy drops the recipient for a linked account that can't pay.
    expect((await env.as("viewer").get("/api/portal/dashboard")).body.policy.zelleRecipient).toBe("");
    expect((await env.as("arzo").get("/api/portal/dashboard")).body.policy.zelleRecipient).toBe("luperdev+zelle@gmail.com");
  });
});

describe("I've sent it", () => {
  it("records a pending report without marking the invoice paid", async () => {
    const env = setup();
    const res = await env.as("arzo").post(`/api/invoices/${INV_A}/payment-reports`, { amount: 380, note: "Sent from my bank app" });
    expect(res.status).toBe(200);
    expect(res.body.report).toMatchObject({ method: "zelle", amount: 380, note: "Sent from my bank app", status: "pending", reviewedAt: null });
    expect(env.tables.invoices.find((i) => i.id === INV_A)).toMatchObject({ status: "sent", amountPaidCents: 0 });
    expect(env.tables.payments).toHaveLength(0);
    expect(env.tables.ledger).toHaveLength(0);
    expect(env.mail.sent).toHaveLength(0);
    const dash = await env.as("arzo").get("/api/portal/dashboard");
    const inv = dash.body.billing.history.find((i: any) => i.id === INV_A);
    expect(inv).toMatchObject({ status: "sent", amountDue: 380, paymentReport: { status: "pending", amount: 380 } });
    expect(dash.body.billing.outstanding).toBe(380);
    expect((await env.as("arzo").get(`/api/invoices/${INV_A}/zelle`)).body.report).toMatchObject({ status: "pending" });
  });

  it("allows one open report per invoice, an empty body, and a generic method name", async () => {
    const env = setup();
    expect((await env.as("arzo").post(`/api/invoices/${INV_A}/payment-reports`)).body.report).toMatchObject({ method: "zelle", amount: null, note: "" });
    const again = await env.as("arzo").post(`/api/invoices/${INV_A}/payment-reports`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("report_pending");
    expect((await env.as("guardian").post(`/api/invoices/${INV_B}/payment-reports`, { method: "Venmo" })).body.report.method).toBe("venmo");
    expect((await env.as("guardian").post(`/api/invoices/${INV_B}/payment-reports`, { method: "not a method!" })).status).toBe(400);
  });

  it("refuses a report on someone else's invoice, a paid one, or from an account that can't pay", async () => {
    const env = setup();
    expect((await env.as("guardian").post(`/api/invoices/${INV_A}/payment-reports`, {})).status).toBe(403);
    expect((await env.as("viewer").post(`/api/invoices/${INV_A}/payment-reports`, {})).status).toBe(403);
    expect((await env.as("teach").post(`/api/invoices/${INV_A}/payment-reports`, {})).status).toBe(403);
    expect(env.tables.paymentReports).toHaveLength(0);
    env.tables.invoices.find((i) => i.id === INV_A)!.status = "paid";
    expect((await env.as("arzo").post(`/api/invoices/${INV_A}/payment-reports`, {})).body.error.code).toBe("invoice_not_payable");
  });
});

describe("teacher review", () => {
  it("lists reported payments for the teacher's own students only", async () => {
    const env = setup();
    await env.as("arzo").post(`/api/invoices/${INV_A}/payment-reports`, { amount: 380 });
    const list = await env.as("teach").get("/api/teacher/payment-reports");
    expect(list.body.reports).toEqual([expect.objectContaining({ studentName: "Arzo Luper", invoiceNumber: "1042", memo: "SFTM-1042", amount: 380, amountDue: 380, status: "pending" })]);
    expect((await env.as("other").get("/api/teacher/payment-reports")).body.reports).toEqual([]);
    const id = list.body.reports[0].id;
    expect((await env.as("other").post(`/api/teacher/payment-reports/${id}/confirm`)).status).toBe(403);
    expect((await env.as("arzo").get("/api/teacher/payment-reports")).status).toBe(403);
    // Teachers see their invoices flagged as reported, still unpaid.
    const invoices = (await env.as("teach").get("/api/teacher/invoices")).body.invoices;
    expect(invoices.find((i: any) => i.id === INV_A)).toMatchObject({ status: "sent", paymentReport: { status: "pending" } });
  });

  it("Confirm records a zelle payment in the payment history and updates amount paid, status and balance", async () => {
    const env = setup();
    await env.as("arzo").post(`/api/invoices/${INV_A}/payment-reports`, { amount: 380, note: "Sent" });
    const id = env.tables.paymentReports[0].id;
    const res = await env.as("teach").post(`/api/teacher/payment-reports/${id}/confirm`, { paidAt: "2026-11-10", reference: "BANK-1" });
    expect(res.status).toBe(200);
    expect(res.body.invoice).toMatchObject({ status: "paid", amountPaid: 380, amountDue: 0 });
    expect(res.body.report).toMatchObject({ status: "confirmed" });
    expect(env.tables.payments).toEqual([expect.objectContaining({ invoiceId: INV_A, amountCents: 38000, method: "zelle", reference: "BANK-1" })]);
    expect(env.tables.paymentReports[0]).toMatchObject({ status: "confirmed", paymentId: env.tables.payments[0].id, reviewedByAccountId: "teach" });
    // A package invoice paid in full adds its 4 credits through the normal paid path.
    expect(env.tables.ledger).toEqual([expect.objectContaining({ studentId: STUDENT_A, delta: 4, reason: "package_paid" })]);
    const dash = await env.as("arzo").get("/api/portal/dashboard");
    expect(dash.body.billing).toMatchObject({ outstanding: 0, bookingBlocked: false });
    expect(dash.body.billing.payments).toEqual([expect.objectContaining({ amount: 380, method: "zelle" })]);
    // A second click does nothing more.
    expect((await env.as("teach").post(`/api/teacher/payment-reports/${id}/confirm`)).status).toBe(409);
    expect(env.tables.payments).toHaveLength(1);
  });

  it("Confirm of a smaller amount records a part payment and leaves the rest due", async () => {
    const env = setup();
    await env.as("guardian").post(`/api/invoices/${INV_B}/payment-reports`, { amount: 40 });
    const id = env.tables.paymentReports[0].id;
    const res = await env.as("teach").post(`/api/teacher/payment-reports/${id}/confirm`);
    expect(res.body.invoice).toMatchObject({ status: "partially_paid", amountPaid: 40, amountDue: 60 });
    expect((await env.as("guardian").get("/api/portal/dashboard")).body.billing.outstanding).toBe(60);
  });

  it("Not received returns the invoice to unpaid, keeps the report for history, and allows a new report", async () => {
    const env = setup();
    await env.as("arzo").post(`/api/invoices/${INV_A}/payment-reports`, { amount: 380 });
    const id = env.tables.paymentReports[0].id;
    const res = await env.as("teach").post(`/api/teacher/payment-reports/${id}/not-received`);
    expect(res.status).toBe(200);
    expect(res.body.report.status).toBe("not_received");
    expect(res.body.invoice).toMatchObject({ status: "sent", amountDue: 380 });
    expect(env.tables.payments).toHaveLength(0);
    const inv = (await env.as("arzo").get("/api/portal/dashboard")).body.billing.history.find((i: any) => i.id === INV_A);
    expect(inv.paymentReport).toBeNull();
    expect((await env.as("teach").get("/api/teacher/payment-reports")).body.reports).toEqual([]);
    expect((await env.as("teach").get("/api/teacher/payment-reports?status=all")).body.reports).toEqual([expect.objectContaining({ id, status: "not_received" })]);
    expect((await env.as("teach").post(`/api/teacher/payment-reports/${id}/confirm`)).status).toBe(409);
    expect((await env.as("arzo").post(`/api/invoices/${INV_A}/payment-reports`, {})).status).toBe(200);
  });

  it("requires AAL2 for every teacher review endpoint", async () => {
    const env = setup();
    await env.as("arzo").post(`/api/invoices/${INV_A}/payment-reports`, {});
    const id = env.tables.paymentReports[0].id;
    for (const call of [
      env.as("weak").get("/api/teacher/payment-reports"),
      env.as("weak").post(`/api/teacher/payment-reports/${id}/confirm`),
      env.as("weak").post(`/api/teacher/payment-reports/${id}/not-received`),
      env.as("weak").put("/api/teacher/studio", { zelleRecipient: "luperdev+x@gmail.com" }),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("mfa_required");
    }
    expect(env.tables.paymentReports[0].status).toBe("pending");
  });
});

describe("Zelle settings", () => {
  it("stores the recipient and optional QR in the teacher's studio settings, not in code", async () => {
    const env = setup("", null);
    const saved = await env.as("teach").put("/api/teacher/studio", { zelleRecipient: "luperdev+pay@gmail.com", zelleQrDataUrl: QR });
    expect(saved.body.settings).toMatchObject({ zelleRecipient: "luperdev+pay@gmail.com", zelleQrDataUrl: QR });
    expect((await env.as("arzo").get(`/api/invoices/${INV_A}/zelle`)).body).toMatchObject({ available: true, recipient: "luperdev+pay@gmail.com", qrDataUrl: QR });
    expect((await env.as("teach").put("/api/teacher/studio", { zelleQrDataUrl: "https://example.com/qr.png" })).status).toBe(400);
    expect((await env.as("teach").put("/api/teacher/studio", { zelleQrDataUrl: null })).body.settings.zelleQrDataUrl).toBeNull();
  });
});

describe("migration 0007", () => {
  const sql = readFileSync("supabase/migrations/0007_payment_reports.sql", "utf8");

  it("adds payment_reports with RLS: payers read and file only for their own linked invoices, teachers read their students'", () => {
    expect(sql).toMatch(/NOT APPLIED/);
    expect(sql).toContain("alter table public.payment_reports enable row level security;");
    expect(sql).toContain("create policy payment_reports_read on public.payment_reports for select using (public.can_see_student_billing(student_id));");
    expect(sql).toMatch(/create policy payment_reports_insert on public\.payment_reports for insert with check \([\s\S]*reported_by_account_id = public\.current_account_id\(\)[\s\S]*i\.student_id = payment_reports\.student_id[\s\S]*l\.can_pay/);
    expect(sql).toContain("revoke all on table public.payment_reports from anon, authenticated, public;");
    expect(sql).not.toMatch(/grant [^;]* to anon/);
    expect(sql).not.toMatch(/for (update|delete)/);
    expect(sql).toContain("create unique index payment_reports_one_pending on public.payment_reports (invoice_id) where status = 'pending';");
  });

  it("keeps payment methods generic text so another method needs no schema change", () => {
    expect(sql).toContain("alter table public.payments add constraint payments_method_check check (method ~ '^[a-z][a-z_]{1,31}$');");
    expect(sql).toContain("method text not null default 'zelle' check (method ~ '^[a-z][a-z_]{1,31}$')");
  });
});
