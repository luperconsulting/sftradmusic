import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { ghlSafeMode, loadConfig } from "../server/config";
import { createGhlClient } from "../server/integrations/ghl";
import { buildDeps, fakeGhl, rawInvoice, STUDENT_A } from "./helpers";

const ARZO_EMAIL = "luperdev@gmail.com";
const ARZO_CONTACT = "RQgd4luPVk9r2srPBlHr";
const TOKEN = "server-only-token";

const ghlConfig = (safeMode?: boolean) => ({
  token: TOKEN,
  locationId: "loc",
  lessonCalendarId: "cal",
  timezone: "UTC",
  invoiceSenderUserId: "sender1",
  ...(safeMode === undefined ? {} : { safeMode }),
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GHL_SAFE_MODE", () => {
  const ghlEnv = {
    GHL_PRIVATE_INTEGRATION_TOKEN: TOKEN,
    GHL_LOCATION_ID: "loc",
    GHL_LESSON_CALENDAR_ID: "cal",
  };

  it("is on for local and Preview, and off for production, unless set explicitly", () => {
    expect(ghlSafeMode({})).toBe(true);
    expect(ghlSafeMode({ NODE_ENV: "development" })).toBe(true);
    expect(ghlSafeMode({ NODE_ENV: "production" })).toBe(false);
    expect(ghlSafeMode({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe(true);
    expect(ghlSafeMode({ NODE_ENV: "production", VERCEL_ENV: "production" })).toBe(false);
    expect(ghlSafeMode({ VERCEL_ENV: "production", GHL_SAFE_MODE: "true" })).toBe(true);
    expect(ghlSafeMode({ GHL_SAFE_MODE: "false" })).toBe(false);
    expect(ghlSafeMode({ GHL_SAFE_MODE: "0" })).toBe(false);
    expect(loadConfig({ ...ghlEnv, VERCEL_ENV: "preview", NODE_ENV: "production" }).ghl?.safeMode).toBe(true);
    expect(loadConfig({ ...ghlEnv, VERCEL_ENV: "production" }).ghl?.safeMode).toBe(false);
  });
});

describe("safe mode flags", () => {
  it("creates a contact as do-not-disturb with the portal-test tag, and looks up Arzo in the configured location", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/contacts/search/duplicate")) return json({ contact: { id: ARZO_CONTACT, contactName: "Arzo Luper", email: ARZO_EMAIL } });
      return json({ contact: { id: "created", firstName: "New", lastName: "Student", email: "new@example.com" } });
    });
    const safe = createGhlClient(ghlConfig(true), fetchImpl as any);
    const found = await safe.findContactByEmail(ARZO_EMAIL);
    expect(found).toEqual({ id: ARZO_CONTACT, name: "Arzo Luper", email: ARZO_EMAIL });
    const lookup = String((fetchImpl.mock.calls[0] as any[])[0]);
    expect(lookup).toContain("locationId=loc");
    expect(lookup).toContain(`email=${encodeURIComponent(ARZO_EMAIL)}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await safe.createContact({ name: "New Student", email: "new@example.com" });
    const init = (fetchImpl.mock.calls[1] as any[])[1];
    expect(JSON.parse(init.body)).toMatchObject({ dnd: true, tags: ["portal-test"], email: "new@example.com", locationId: "loc", source: "SF Trad Music portal" });
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("omits the safe-mode fields when safe mode is off", async () => {
    const fetchImpl = vi.fn(async () => json({ contact: { id: "created", firstName: "New", lastName: "Student" } }));
    const client = createGhlClient(ghlConfig(false), fetchImpl as any);
    await client.createContact({ name: "New Student", email: "new@example.com" });
    const body = JSON.parse((fetchImpl.mock.calls[0] as any[])[1].body);
    expect(body.dnd).toBeUndefined();
    expect(body.tags).toBeUndefined();
  });

  it("books and reschedules without notifying in safe mode, and notifies when it is off", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "ev", calendarId: "cal", contactId: ARZO_CONTACT }));
    const slot = { contactId: ARZO_CONTACT, startTime: "2026-12-01T16:00:00.000Z", endTime: "2026-12-01T17:00:00.000Z", title: "Lesson", address: "Zoom" };
    await createGhlClient(ghlConfig(true), fetchImpl as any).createAppointment(slot);
    await createGhlClient(ghlConfig(true), fetchImpl as any).updateAppointment("ev", { startTime: slot.startTime, endTime: slot.endTime });
    expect(JSON.parse((fetchImpl.mock.calls[0] as any[])[1].body).toNotify).toBe(false);
    expect(JSON.parse((fetchImpl.mock.calls[1] as any[])[1].body).toNotify).toBe(false);

    const live = vi.fn(async () => json({ id: "ev" }));
    await createGhlClient(ghlConfig(false), live as any).createAppointment(slot);
    await createGhlClient(ghlConfig(false), live as any).updateAppointment("ev", { startTime: slot.startTime, endTime: slot.endTime });
    expect(JSON.parse((live.mock.calls[0] as any[])[1].body).toNotify).toBe(true);
    expect(JSON.parse((live.mock.calls[1] as any[])[1].body).toNotify).toBe(true);
  });

  it("logs an invoice email in safe mode and never asks GoHighLevel to send SMS", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => json({}));
    const safe = createGhlClient(ghlConfig(true), fetchImpl as any);
    await expect(safe.sendInvoice("inv1", { userId: "sender1", liveMode: true })).resolves.toEqual({ suppressed: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    const logged = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("inv1");
    expect(logged).toContain("would email");
    expect(logged).not.toContain(TOKEN);
    log.mockRestore();

    const liveFetch = vi.fn(async () => json({}));
    await createGhlClient(ghlConfig(false), liveFetch as any).sendInvoice("inv1", { userId: "sender1", liveMode: true });
    const body = JSON.parse((liveFetch.mock.calls[0] as any[])[1].body);
    expect(body.action).toBe("email");
    expect(String(body.action)).not.toMatch(/sms/);
    expect((liveFetch.mock.calls[0] as any[])[1].body).not.toContain(TOKEN);
  });

  it("does not email or text from Pay Now while safe mode is on", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sendInvoice = vi.fn();
    const base = fakeGhl({ sendInvoice, getInvoice: async () => rawInvoice() });
    const ghl = { ...base, config: { ...base.config, safeMode: true, token: TOKEN } };
    const parent = { role: "guardian" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] };
    const res = await request(createApp(buildDeps({ parent }, ghl))).post("/api/invoices/inv1/send-payment-link").set("Authorization", "Bearer parent").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: false, suppressed: true, invoiceId: "inv1" });
    expect(sendInvoice).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain(TOKEN);
    log.mockRestore();
  });

  it("deletes a contact with GoHighLevel's documented call and does not require a body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const client = createGhlClient(ghlConfig(false), fetchImpl as any);
    await client.deleteContact("new-contact");
    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(url).toBe("https://services.leadconnectorhq.com/contacts/new-contact");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});

describe("server credentials stay on the server", () => {
  it("does not mention the service-role key or the GoHighLevel token in browser code", () => {
    const roots = ["src", "index.html", "book.html", "portal.html"].map((p) => path.resolve(p));
    const files: string[] = [];
    const walk = (entry: string) => {
      if (!statSync(entry).isDirectory()) {
        files.push(entry);
        return;
      }
      for (const name of readdirSync(entry)) walk(path.join(entry, name));
    };
    roots.forEach(walk);
    const banned = ["SUPABASE_SERVICE_ROLE_KEY", "GHL_PRIVATE_INTEGRATION_TOKEN", "sb_secret_", "pit-"];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const word of banned) expect(text, file).not.toContain(word);
    }
  });
});
