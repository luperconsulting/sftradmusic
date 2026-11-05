import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import nodemailer from "nodemailer";
import type { Application } from "express";
import { createApp } from "../server/app";
import { invoicePayUrl } from "../server/integrations/ghl";
import { STUDENT_A, buildDeps, fakeGhl } from "./helpers";

const parent = { role: "guardian" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] };

function routesOf(app: Application) {
  const found: { method: string; path: string }[] = [];
  const stack = (app as any)._router?.stack ?? [];
  const mount = (layer: any) => {
    const source = String(layer?.regexp?.source ?? "");
    if (source.startsWith("^\\/api\\/teacher")) return "/api/teacher";
    if (source.startsWith("^\\/api")) return "/api";
    return "";
  };
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) found.push({ method: method.toUpperCase(), path: layer.route.path });
    } else if (layer.name === "router") {
      const prefix = mount(layer);
      for (const inner of layer.handle?.stack ?? []) {
        if (!inner.route) continue;
        for (const method of Object.keys(inner.route.methods)) found.push({ method: method.toUpperCase(), path: prefix + inner.route.path });
      }
    }
  }
  return found;
}

const PUBLIC = new Set([
  "GET /api/health",
  "POST /api/invitations/verify",
  "POST /api/invitations/redeem",
  "POST /api/invitations/verify-code",
  "POST /api/webhooks/ghl",
]);

describe("invoice pay links", () => {
  it("uses a GoHighLevel https link and drops it in safe mode", () => {
    expect(invoicePayUrl({ paymentLink: "https://pay.gohighlevel.com/invoice/abc" }, false)).toBe("https://pay.gohighlevel.com/invoice/abc");
    expect(invoicePayUrl({ paymentLink: "https://pay.gohighlevel.com/invoice/abc" }, true)).toBeNull();
    expect(invoicePayUrl({ url: "/portal" }, false)).toBeNull();
    expect(invoicePayUrl({}, false)).toBeNull();
  });
});

describe("referral mail on the route", () => {
  it("sends only the allowlisted address when SMTP is configured", async () => {
    const sendMail = vi.fn(async () => ({}));
    const transport = vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail } as any);
    const logs: string[] = [];
    const log = vi.spyOn(console, "info").mockImplementation((message?: unknown) => { logs.push(String(message ?? "")); });
    const deps = buildDeps({ parent, t: { role: "teacher", aal: "aal2" } }, fakeGhl({
      config: { token: "t", locationId: "loc", lessonCalendarId: "cal", timezone: "UTC", invoiceSenderUserId: "sender1", safeMode: true },
    }));
    deps.config.safeMode = true;
    deps.config.features = { packages: true, autopay: true, referrals: true, recurring: true, invoiceActions: true };
    deps.config.smtp = { user: "zane@sftradmusic.com", pass: "app-password-secret" };
    const app = createApp(deps);
    const sent = await request(app).post("/api/referrals/invite").set("Authorization", "Bearer parent").send({ studentId: STUDENT_A, email: "luperdev@gmail.com" });
    expect(sent.status).toBe(200);
    expect(sent.body.emailed).toBe(true);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "luperdev@gmail.com", from: "SF Trad Music <zane@sftradmusic.com>" }));
    const skipped = await request(app).post("/api/referrals/invite").set("Authorization", "Bearer parent").send({ studentId: STUDENT_A, email: "friend@example.com" });
    expect(skipped.body.emailed).toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).not.toContain("app-password-secret");
    log.mockRestore();
    transport.mockRestore();
  });
});

describe("password and 2FA coverage", () => {
  it("rejects every portal route at AAL1 and leaves only invite enrollment public", async () => {
    const app = createApp(buildDeps({ p: { role: "guardian", aal: "aal1", mfa: false, links: parent.links }, t: { role: "teacher", aal: "aal1", mfa: true } }));
    const routes = routesOf(app).filter((route) => route.path.startsWith("/api"));
    const open: string[] = [];
    const closed: string[] = [];
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (key === "GET /api/me") {
        // Open to AAL1 for routing only; it returns no account data until 2FA passes.
        const me = await request(app).get(route.path).set("Authorization", "Bearer p");
        expect(Object.keys(me.body).sort(), key).toEqual(["mfaRequired", "user"]);
        continue;
      }
      if (PUBLIC.has(key)) {
        open.push(key);
        continue;
      }
      const path = route.path.replace(/:([^/]+)/g, "x");
      const token = path.includes("/teacher/") ? "t" : "p";
      const call = request(app)[route.method.toLowerCase() as "get" | "post" | "put"](path).set("Authorization", `Bearer ${token}`);
      const res = route.method === "GET" ? await call : await call.send({});
      expect(res.status, key).toBe(403);
      expect(res.body.error.code, key).toBe("mfa_required");
      closed.push(key);
    }
    expect(new Set(open)).toEqual(PUBLIC);
    expect(closed.length).toBeGreaterThan(10);
    expect(closed.some((route) => route.includes("/teacher/"))).toBe(true);
  });
});
