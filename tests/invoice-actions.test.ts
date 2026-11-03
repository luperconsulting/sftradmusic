import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { buildDeps, fakeGhl } from "./helpers";

describe("invoice actions", () => {
  it("logs send, remind, void, and mark-paid in safe mode and does not call GoHighLevel", async () => {
    const sendInvoice = vi.fn(async () => ({}));
    const deps = buildDeps({ t: { role: "teacher", aal: "aal2" } }, fakeGhl({ sendInvoice }));
    deps.config.safeMode = true;
    deps.config.features = { ...deps.config.features, invoiceActions: true };
    const app = createApp(deps);
    for (const action of ["send", "remind", "void", "mark-paid"]) {
      const res = await request(app).post(`/api/teacher/invoices/inv1/${action}`).set("Authorization", "Bearer t").send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, suppressed: true, action, invoiceId: "inv1" });
    }
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("refuses the same actions when safe mode is off, even if the flag is on", async () => {
    const sendInvoice = vi.fn(async () => ({}));
    const deps = buildDeps({ t: { role: "teacher", aal: "aal2" } }, fakeGhl({ sendInvoice }));
    deps.config.safeMode = false;
    deps.config.features = { ...deps.config.features, invoiceActions: true };
    const res = await request(createApp(deps)).post("/api/teacher/invoices/inv1/mark-paid").set("Authorization", "Bearer t");
    expect(res.status).toBe(501);
    expect(sendInvoice).not.toHaveBeenCalled();
  });
});
