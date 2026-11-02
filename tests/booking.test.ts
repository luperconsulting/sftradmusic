import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { OUTSTANDING_BALANCE_MESSAGE } from "../shared/portal-types";
import { createApp } from "../server/app";
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

  it("refuses an appointment belonging to another family", async () => {
    const updateAppointment = vi.fn();
    const ghl = fakeGhl({ updateAppointment, getAppointment: async () => ({ id: "ev", calendarId: "cal", contactId: "contactB", startTime: FUTURE, endTime: FUTURE }) });
    expect((await move(createApp(buildDeps({ parent }, ghl)))).status).toBe(403);
    expect(updateAppointment).not.toHaveBeenCalled();
  });
});

describe("payment links", () => {
  const pay = (app: any) => request(app).post("/api/invoices/inv1/payment-link").set("Authorization", "Bearer parent");

  it("says plainly that no link is available for the payer's own unpaid invoice, and invents no URL", async () => {
    const res = await pay(createApp(buildDeps({ parent })));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("payment_link_unavailable");
    expect(res.body.url).toBeUndefined();
  });

  it("refuses another family's invoice", async () => {
    const ghl = fakeGhl({ getInvoice: async () => rawInvoice({ contactDetails: { id: "payerB" } }) });
    expect((await pay(createApp(buildDeps({ parent }, ghl)))).status).toBe(403);
  });

  it("won't return a link for a paid invoice", async () => {
    const ghl = fakeGhl({ getInvoice: async () => rawInvoice({ status: "paid", amountDue: 0 }) });
    expect((await pay(createApp(buildDeps({ parent }, ghl)))).status).toBe(409);
  });

  it("keeps a bad-actor booking for another student out", async () => {
    expect((await book(createApp(buildDeps({ parent })), "parent", STUDENT_B)).status).toBe(403);
  });
});
