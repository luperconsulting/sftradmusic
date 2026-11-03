import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { OUTSTANDING_BALANCE_MESSAGE } from "../shared/portal-types";
import { createApp } from "../server/app";
import { LINK_COOLDOWN_MS } from "../server/services/billing";
import { buildDeps, fakeGhl, FUTURE, rawInvoice, STUDENT_A, STUDENT_B } from "./helpers";

const parent = { role: "guardian" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] };
const book = (app: any, token = "parent", studentId = STUDENT_A) =>
  request(app).post("/api/lessons").set("Authorization", `Bearer ${token}`).send({ studentId, startTime: FUTURE, location: "Music City SF" });

describe("booking restriction", () => {
  it("refuses to book when the payer owes money, with the exact message, and creates nothing", async () => {
    const createAppointment = vi.fn();
    const ghl = fakeGhl({ createAppointment, listInvoices: async () => ({ invoices: [rawInvoice()], total: 1 }) });
    const res = await book(createApp(buildDeps({ parent }, ghl)));
    expect(res.status).toBe(402);
    expect(res.body.error.message).toBe(OUTSTANDING_BALANCE_MESSAGE);
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("checks the balance of the billing contact, not the student contact", async () => {
    const listInvoices = vi.fn(async () => ({ invoices: [], total: 0 }));
    await book(createApp(buildDeps({ parent }, fakeGhl({ listInvoices }))));
    expect(listInvoices).toHaveBeenCalledWith(expect.objectContaining({ contactId: "payerA" }));
  });

  it("finds an unpaid invoice beyond the first page", async () => {
    const paid = Array.from({ length: 100 }, () => rawInvoice({ status: "paid", amountDue: 0 }));
    const listInvoices = vi.fn(async ({ offset }: any) => ({ invoices: offset === 0 ? paid : [rawInvoice()], total: 101 }));
    const res = await book(createApp(buildDeps({ parent }, fakeGhl({ listInvoices }))));
    expect(res.status).toBe(402);
  });

  it("treats an unfamiliar status with money due as outstanding", async () => {
    const ghl = fakeGhl({ listInvoices: async () => ({ invoices: [rawInvoice({ status: "something_new" })], total: 1 }) });
    expect((await book(createApp(buildDeps({ parent }, ghl)))).status).toBe(402);
  });

  it("ignores unpaid test-mode invoices but not live ones", async () => {
    const test = fakeGhl({ listInvoices: async () => ({ invoices: [rawInvoice({ liveMode: false })], total: 1 }) });
    expect((await book(createApp(buildDeps({ parent }, test)))).status).toBe(200);
    const live = fakeGhl({ listInvoices: async () => ({ invoices: [rawInvoice({ liveMode: true })], total: 1 }) });
    expect((await book(createApp(buildDeps({ parent }, live)))).status).toBe(402);
  });

  it("fails closed when the balance can't be read", async () => {
    const createAppointment = vi.fn();
    const ghl = fakeGhl({ createAppointment, listInvoices: async () => { throw new Error("down"); } });
    const res = await book(createApp(buildDeps({ parent }, ghl)));
    expect(res.status).toBe(500);
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("returns 503 and books nothing when GoHighLevel isn't configured", async () => {
    const res = await book(createApp(buildDeps({ parent }, null)));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("integration_not_configured");
  });

  it("books when paid up, using the server's contact rather than anything from the client", async () => {
    const createAppointment = vi.fn(async (i: any) => ({ id: "new", calendarId: "cal", contactId: i.contactId, startTime: i.startTime, endTime: i.endTime }));
    const res = await book(createApp(buildDeps({ parent }, fakeGhl({ createAppointment }))));
    expect(res.status).toBe(200);
    expect(createAppointment.mock.calls[0][0].contactId).toBe("contactA");
  });

  it("rejects a slot GoHighLevel doesn't list as open", async () => {
    const ghl = fakeGhl({ getFreeSlots: async () => ({}) });
    expect((await book(createApp(buildDeps({ parent }, ghl)))).status).toBe(409);
  });
});

describe("rescheduling", () => {
  const move = (app: any) => request(app).post("/api/lessons/ev/reschedule").set("Authorization", "Bearer parent").send({ studentId: STUDENT_A, startTime: FUTURE, location: "Zoom" });

  it("refuses inside the 24-hour window", async () => {
    const soon = new Date(Date.now() + 3600000).toISOString();
    const ghl = fakeGhl({ getAppointment: async () => ({ id: "ev", calendarId: "cal", contactId: "contactA", startTime: soon, endTime: soon }) });
    const res = await move(createApp(buildDeps({ parent }, ghl)));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("reschedule_closed");
  });

  it("refuses a past lesson and does not create a new appointment", async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const updateAppointment = vi.fn();
    const createAppointment = vi.fn();
    const ghl = fakeGhl({ updateAppointment, createAppointment, getAppointment: async () => ({ id: "ev", calendarId: "cal", contactId: "contactA", startTime: past, endTime: past }) });
    const res = await move(createApp(buildDeps({ parent }, ghl)));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("lesson_past");
    expect(updateAppointment).not.toHaveBeenCalled();
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("moves the same appointment instead of booking a second one", async () => {
    const updateAppointment = vi.fn(async (id: string) => ({ id, calendarId: "cal", contactId: "contactA", startTime: FUTURE, endTime: FUTURE }));
    const createAppointment = vi.fn();
    const ghl = fakeGhl({ updateAppointment, createAppointment, getAppointment: async () => ({ id: "ev", calendarId: "cal", contactId: "contactA", startTime: FUTURE, endTime: FUTURE }), getFreeSlots: async () => ({ day: [FUTURE] }), listInvoices: async () => ({ invoices: [], total: 0 }) });
    const res = await move(createApp(buildDeps({ parent }, ghl)));
    expect(res.status).toBe(200);
    expect(updateAppointment).toHaveBeenCalledWith("ev", expect.objectContaining({ startTime: FUTURE }));
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("refuses an appointment belonging to another family", async () => {
    const updateAppointment = vi.fn();
    const ghl = fakeGhl({ updateAppointment, getAppointment: async () => ({ id: "ev", calendarId: "cal", contactId: "contactB", startTime: FUTURE, endTime: FUTURE }) });
    expect((await move(createApp(buildDeps({ parent }, ghl)))).status).toBe(403);
    expect(updateAppointment).not.toHaveBeenCalled();
  });
});

describe("payment links", () => {
  const pay = (app: any) => request(app).post("/api/invoices/inv1/send-payment-link").set("Authorization", "Bearer parent").send({ email: "attacker@example.com" });

  it("sends the payer's own unpaid invoice through GoHighLevel and records it", async () => {
    const sendInvoice = vi.fn(async () => ({}));
    const audit = vi.fn(async () => undefined);
    const res = await pay(createApp(buildDeps({ parent }, fakeGhl({ sendInvoice }), { audit })));
    expect(res.status).toBe(200);
    expect(res.body.url).toBeUndefined();
    // The recipient isn't in the call at all: GoHighLevel uses the contact on the invoice.
    expect(sendInvoice).toHaveBeenCalledWith("inv1", { userId: "sender1", liveMode: true });
    expect(audit).toHaveBeenCalledWith("parent", "invoice.link_sent", "inv1", undefined);
  });

  it("refuses another family's invoice and sends nothing", async () => {
    const sendInvoice = vi.fn();
    const ghl = fakeGhl({ sendInvoice, getInvoice: async () => rawInvoice({ contactDetails: { id: "payerB" } }) });
    expect((await pay(createApp(buildDeps({ parent }, ghl)))).status).toBe(403);
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it.each([["paid", { status: "paid", amountDue: 0 }], ["draft", { status: "draft" }], ["void", { status: "void" }], ["test-mode", { liveMode: false }]])("won't send a %s invoice", async (_n, over) => {
    const sendInvoice = vi.fn();
    const ghl = fakeGhl({ sendInvoice, getInvoice: async () => rawInvoice(over) });
    expect((await pay(createApp(buildDeps({ parent }, ghl)))).status).toBe(409);
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("won't send twice within the cooldown", async () => {
    const sendInvoice = vi.fn();
    const deps = buildDeps({ parent }, fakeGhl({ sendInvoice }), { lastInvoiceLinkSentAt: async () => new Date(Date.now() - 60000).toISOString() });
    const res = await pay(createApp(deps));
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("link_recently_sent");
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("sends again after the cooldown", async () => {
    const deps = buildDeps({ parent }, fakeGhl(), { lastInvoiceLinkSentAt: async () => new Date(Date.now() - LINK_COOLDOWN_MS - 1000).toISOString() });
    expect((await pay(createApp(deps))).status).toBe(200);
  });

  it("says so and sends nothing when no sender is configured", async () => {
    const sendInvoice = vi.fn();
    const base = fakeGhl({ sendInvoice });
    const ghl = { ...base, config: { ...base.config, invoiceSenderUserId: null } };
    const res = await pay(createApp(buildDeps({ parent }, ghl)));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("payment_link_unavailable");
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("doesn't let a teacher or a non-paying account send", async () => {
    const sendInvoice = vi.fn();
    const viewer = { role: "student" as const, links: [{ studentId: STUDENT_A, canBook: false, canPay: false }] };
    const res = await request(createApp(buildDeps({ viewer }, fakeGhl({ sendInvoice })))).post("/api/invoices/inv1/send-payment-link").set("Authorization", "Bearer viewer");
    expect(res.status).toBe(403);
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("keeps a bad-actor booking for another student out", async () => {
    expect((await book(createApp(buildDeps({ parent })), "parent", STUDENT_B)).status).toBe(403);
  });
});
