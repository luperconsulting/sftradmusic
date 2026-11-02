import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { createGhlClient } from "../server/integrations/ghl";
import { buildDeps, fakeGhl, FUTURE, rawInvoice, STUDENT_A } from "./helpers";

const parent = { role: "guardian" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] };

describe("invoice to booking", () => {
  it("blocks booking, sends the link, then unlocks booking once GoHighLevel reports it paid", async () => {
    let invoice = rawInvoice();
    const sendInvoice = vi.fn(async () => ({}));
    const ghl = fakeGhl({ sendInvoice, getInvoice: async () => invoice, listInvoices: async () => ({ invoices: [invoice], total: 1 }) });
    const app = createApp(buildDeps({ parent }, ghl));
    const as = (r: any) => r.set("Authorization", "Bearer parent");
    const book = () => as(request(app).post("/api/lessons")).send({ studentId: STUDENT_A, startTime: FUTURE, location: "Music City SF" });

    const before = await as(request(app).get(`/api/portal/dashboard?studentId=${STUDENT_A}`));
    expect(before.status).toBe(200);
    expect(JSON.stringify(before.body)).toContain("inv1");
    expect((await book()).status).toBe(402);

    expect((await as(request(app).post("/api/invoices/inv1/send-payment-link")).send({})).status).toBe(200);
    expect(sendInvoice).toHaveBeenCalledTimes(1);
    // Sending the link isn't payment.
    expect((await book()).status).toBe(402);

    invoice = rawInvoice({ status: "paid", amountDue: 0, amountPaid: 100 });
    expect((await book()).status).toBe(200);
  });
});

describe("invoice notifications", () => {
  it("asks GoHighLevel for email only", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const client = createGhlClient({ token: "t", locationId: "loc", lessonCalendarId: "cal", timezone: "UTC", invoiceSenderUserId: "sender1" }, fetchImpl as any);
    await client.sendInvoice("inv1", { userId: "sender1", liveMode: true });
    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).action).toBe("email");
  });
});
