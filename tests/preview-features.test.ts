import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { createApp } from "../server/app";
import { FUTURE, STUDENT_A, buildDeps, fakeGhl } from "./helpers";

const parent = { role: "guardian" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] };
const previewFeatures = { packages: true, autopay: true, referrals: true, recurring: true, invoiceActions: true };

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

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

describe("preview copy and routes", () => {
  it("has no coming soon or not connected copy in the portal", () => {
    const hits = walk("src/portal").flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [/coming soon/i, /not connected/i].filter((pattern) => pattern.test(text)).map((pattern) => `${file} matches ${pattern}`);
    });
    expect(hits).toEqual([]);
  });

  it("returns no 501 from portal routes when preview safe mode is on", async () => {
    const deps = buildDeps({ parent, t: { role: "teacher", aal: "aal2" } }, fakeGhl({
      config: { token: "t", locationId: "loc", lessonCalendarId: "cal", timezone: "UTC", invoiceSenderUserId: "sender1", safeMode: true },
    }));
    deps.config.safeMode = true;
    deps.config.features = previewFeatures;
    const app = createApp(deps);
    const routes = routesOf(app).filter((route) => route.path.startsWith("/api"));
    expect(routes.length).toBeGreaterThan(10);
    const failures: string[] = [];
    for (const route of routes) {
      const path = route.path.replace(/:([^/]+)/g, "x");
      const token = path.includes("/teacher/") ? "t" : "parent";
      const call = request(app)[route.method.toLowerCase() as "get" | "post" | "put"](path).set("Authorization", `Bearer ${token}`);
      const res = route.method === "GET" ? await call : await call.send({});
      if (res.status === 501) failures.push(`${route.method} ${path}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("preview feature behavior", () => {
  function ready(store: Record<string, unknown> = {}, ghl = fakeGhl()) {
    const deps = buildDeps({ parent, t: { role: "teacher", aal: "aal2" } }, ghl, store);
    deps.config.safeMode = true;
    deps.config.features = previewFeatures;
    return createApp(deps);
  }

  it("records a placeholder package and does not charge", async () => {
    const rows: { action: string; target: string; meta: Record<string, unknown> }[] = [];
    const sendInvoice = vi.fn(async () => ({}));
    const app = ready({
      audit: async (_actor: string, action: string, target: string, meta: Record<string, unknown> = {}) => { rows.push({ action, target, meta }); },
      listAudit: async (action: string) => rows.filter((row) => row.action === action).map((row) => ({ target: row.target, meta: row.meta })),
    }, fakeGhl({ sendInvoice }));
    const res = await request(app).post("/api/packages/purchase").set("Authorization", "Bearer parent").send({ studentId: STUDENT_A, packageId: "placeholder-4" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ suppressed: true, lessonsAdded: 4, lessonsRemaining: 4, placeholder: true });
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("saves autopay without calling Stripe or GoHighLevel", async () => {
    const sendInvoice = vi.fn(async () => ({}));
    const createContact = vi.fn(async () => ({ contact: { id: "c", name: "n", email: null }, created: true }));
    const app = ready({}, fakeGhl({ sendInvoice, createContact }));
    const res = await request(app).post("/api/autopay").set("Authorization", "Bearer parent").send({ studentId: STUDENT_A, enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ suppressed: true, enabled: true, processor: "stripe-test-log" });
    expect(sendInvoice).not.toHaveBeenCalled();
    expect(createContact).not.toHaveBeenCalled();
  });

  it("suppresses referral email and still tags a portal-test contact", async () => {
    const createContact = vi.fn(async ({ name, email }: { name: string; email: string }) => ({ contact: { id: "ref", name, email }, created: true }));
    const app = ready({}, fakeGhl({
      config: { token: "t", locationId: "loc", lessonCalendarId: "cal", timezone: "UTC", invoiceSenderUserId: "sender1", safeMode: true },
      createContact,
    }));
    const blocked = await request(app).post("/api/referrals/invite").set("Authorization", "Bearer parent").send({ studentId: STUDENT_A, email: "friend@example.com" });
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({ suppressed: true, emailed: false, allowlisted: false, contactId: "ref" });
    const allowed = await request(app).post("/api/referrals/invite").set("Authorization", "Bearer t").send({ email: "luperdev@gmail.com" });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ suppressed: true, emailed: false, allowlisted: true, mailer: "not_configured" });
    expect(createContact).toHaveBeenCalledTimes(2);
  });

  it("books eight weekly lessons only while safe mode is on", async () => {
    const createAppointment = vi.fn(async (input: { startTime: string }) => ({ id: input.startTime, calendarId: "cal", contactId: "contactA", startTime: input.startTime, endTime: input.startTime }));
    const ghl = fakeGhl({
      config: { token: "t", locationId: "loc", lessonCalendarId: "cal", timezone: "UTC", invoiceSenderUserId: "sender1", safeMode: true },
      createAppointment,
      getFreeSlots: async () => ({ day: [FUTURE] }),
      listInvoices: async () => ({ invoices: [], total: 0 }),
    });
    const app = ready({}, ghl);
    const res = await request(app).post("/api/lessons").set("Authorization", "Bearer parent").send({ studentId: STUDENT_A, startTime: FUTURE, location: "Zoom", repeatWeekly: true });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(8);
    expect(createAppointment).toHaveBeenCalledTimes(8);

    const live = buildDeps({ parent }, fakeGhl());
    live.config.safeMode = false;
    live.config.features = previewFeatures;
    const refused = await request(createApp(live)).post("/api/lessons").set("Authorization", "Bearer parent").send({ studentId: STUDENT_A, startTime: FUTURE, location: "Zoom", repeatWeekly: true });
    expect(refused.status).toBe(501);
  });
});
