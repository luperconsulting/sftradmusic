import { generateKeyPairSync, createVerify } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { googleFromEnv } from "../server/config";
import { createGoogleCalendar } from "../server/integrations/googleCalendar";
import { bookingDate, openTimes, startOfBookingDate } from "../server/services/availability";
import { buildDeps, fakeGhl } from "./helpers";

const NOW = Date.parse("2026-11-10T17:00:00Z"); // 9:00 AM in Los Angeles
const iso = (s: string) => new Date(s).toISOString();
const base = (...slots: string[]) => ({ "2026-11-10": slots.map(iso) });

describe("open times", () => {
  it("shows a normal open time", () => {
    const days = openTimes({ base: base("2026-11-10T19:00:00-08:00"), busy: [], durationMinutes: 15, now: NOW });
    expect(days).toEqual({ "2026-11-10": [iso("2026-11-10T19:00:00-08:00")] });
  });

  it("drops a time that a Google Calendar event covers", () => {
    const busy = [{ start: Date.parse("2026-11-10T10:00:00-08:00"), end: Date.parse("2026-11-10T11:00:00-08:00") }];
    const days = openTimes({ base: base("2026-11-10T10:30:00-08:00", "2026-11-10T12:00:00-08:00"), busy, durationMinutes: 15, now: NOW });
    expect(days["2026-11-10"]).toEqual([iso("2026-11-10T12:00:00-08:00")]);
  });

  it("never shows a time that has started or passed", () => {
    const days = openTimes({ base: base("2026-11-10T08:00:00-08:00", "2026-11-10T09:00:00-08:00", "2026-11-10T09:15:00-08:00"), busy: [], durationMinutes: 15, now: NOW });
    expect(days["2026-11-10"]).toEqual([iso("2026-11-10T09:15:00-08:00")]);
  });

  it("blocks partial overlaps at either end, but not an event that ends as the slot starts", () => {
    const at = (t: string) => Date.parse(`2026-11-10T${t}:00-08:00`);
    const busy = [
      { start: at("13:50"), end: at("14:05") }, // runs into the 2:00 slot
      { start: at("15:10"), end: at("16:00") }, // starts inside the 3:00 slot
      { start: at("16:30"), end: at("17:00") }, // ends exactly when the 5:00 slot starts
    ];
    const days = openTimes({ base: base("2026-11-10T14:00:00-08:00", "2026-11-10T15:00:00-08:00", "2026-11-10T17:00:00-08:00"), busy, durationMinutes: 15, now: NOW });
    expect(days["2026-11-10"]).toEqual([iso("2026-11-10T17:00:00-08:00")]);
  });

  it("files times under their Los Angeles date, whatever the source's keys", () => {
    // 11:30 PM on Nov 10 in Los Angeles is already Nov 11 in UTC.
    const days = openTimes({ base: { "2026-11-11": [iso("2026-11-10T23:30:00-08:00")] }, busy: [], durationMinutes: 15, now: NOW });
    expect(Object.keys(days)).toEqual(["2026-11-10"]);
  });

  it("works out Los Angeles midnight across daylight-saving changes", () => {
    expect(new Date(startOfBookingDate("2026-11-10")).toISOString()).toBe("2026-11-10T08:00:00.000Z");
    expect(new Date(startOfBookingDate("2026-07-01")).toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(new Date(startOfBookingDate("2026-11-01")).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(new Date(startOfBookingDate("2026-03-08")).toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(bookingDate(Date.parse("2026-11-11T07:59:00Z"))).toBe("2026-11-10");
  });
});

describe("GET /api/booking/availability", () => {
  const get = (deps: ReturnType<typeof buildDeps>, query = "from=2026-11-10&to=2026-11-12") => request(createApp(deps)).get(`/api/booking/availability?${query}`);
  const future = new Date(Date.now() + 3 * 86400000);
  const futureIso = (h: number) => { const d = new Date(future); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };

  function deps(over: { busy?: () => Promise<any>; slots?: () => Promise<any>; google?: null } = {}) {
    const getFreeSlots = vi.fn(over.slots ?? (async () => ({ x: [futureIso(18), futureIso(19)] })));
    const busy = vi.fn(over.busy ?? (async () => [{ start: Date.parse(futureIso(19)), end: Date.parse(futureIso(20)) }]));
    const d = buildDeps({}, fakeGhl({ getFreeSlots }));
    d.google = over.google === null ? null : { busy };
    return { d, getFreeSlots, busy };
  }

  it("is public and returns GoHighLevel's open times minus Google busy times, in Los Angeles time", async () => {
    const { d, getFreeSlots } = deps();
    const res = await get(d);
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("America/Los_Angeles");
    expect(Object.values(res.body.days).flat()).toEqual([futureIso(18)]);
    // The base rules come from the intro-call calendar, not the lesson calendar.
    expect((getFreeSlots.mock.calls[0] as any[])[2]).toBe("vc5JhcEjhKFs3MpJyj9p");
  });

  it("asks Google about one slot-length past the range, so the last slot is fully checked", async () => {
    const { d, busy } = deps();
    await get(d, "from=2026-11-10&to=2026-11-10");
    const [from, to] = busy.mock.calls[0] as unknown as [number, number];
    expect(new Date(from).toISOString()).toBe("2026-11-10T08:00:00.000Z");
    expect(new Date(to).toISOString()).toBe("2026-11-11T08:15:00.000Z");
  });

  it("returns a safe error and no times when Google fails", async () => {
    const { ApiError } = await import("../server/http");
    const { d } = deps({ busy: async () => { throw new ApiError(503, "availability_unavailable", "Open times can't be checked right now. Please try again shortly."); } });
    const res = await get(d);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("availability_unavailable");
    expect(res.body.days).toBeUndefined();
  });

  it("returns the same safe error for an unexpected Google failure, a GoHighLevel failure, or no Google settings", async () => {
    for (const over of [{ busy: async () => { throw new Error("boom"); } }, { slots: async () => { throw new Error("down"); } }, { google: null as null }]) {
      const res = await get(deps(over).d);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("availability_unavailable");
      expect(res.body.days).toBeUndefined();
    }
  });

  it("refuses an invalid or overlong range", async () => {
    expect((await get(deps().d, "from=2026-11-12&to=2026-11-10")).status).toBe(400);
    expect((await get(deps().d, "from=2026-11-01&to=2026-12-31")).status).toBe(400);
    expect((await get(deps().d, "from=nope&to=2026-11-10")).status).toBe(400);
  });
});

describe("Google Calendar client", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const cfg = { clientEmail: "booking@example.iam.gserviceaccount.com", privateKey, calendarIds: ["primary-cal", "studio-cal"] };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function fakeFetch(freeBusy: unknown, freeBusyStatus = 200) {
    return vi.fn(async (url: any, init: any) => {
      if (String(url).includes("oauth2")) return json({ access_token: "access", expires_in: 3600 });
      return json(freeBusy, freeBusyStatus);
    });
  }

  it("signs a free/busy-only token request and merges busy times from every calendar", async () => {
    const f = fakeFetch({ calendars: { "primary-cal": { busy: [{ start: "2026-11-10T18:00:00Z", end: "2026-11-10T19:00:00Z" }] }, "studio-cal": { busy: [] } } });
    const busy = await createGoogleCalendar(cfg, f as any).busy(0, 1);
    expect(busy).toEqual([{ start: Date.parse("2026-11-10T18:00:00Z"), end: Date.parse("2026-11-10T19:00:00Z") }]);
    const assertion = new URLSearchParams((f.mock.calls[0] as any)[1].body.toString()).get("assertion")!;
    const [h, c, s] = assertion.split(".");
    expect(JSON.parse(Buffer.from(c, "base64url").toString()).scope).toBe("https://www.googleapis.com/auth/calendar.freebusy");
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
    const sent = JSON.parse((f.mock.calls[1] as any)[1].body);
    expect(sent.items).toEqual([{ id: "primary-cal" }, { id: "studio-cal" }]);
  });

  it("reuses the access token until it nears expiry", async () => {
    const f = fakeFetch({ calendars: { "primary-cal": { busy: [] }, "studio-cal": { busy: [] } } });
    const client = createGoogleCalendar(cfg, f as any);
    await client.busy(0, 1);
    await client.busy(0, 1);
    expect(f.mock.calls.filter((c: any) => String(c[0]).includes("oauth2"))).toHaveLength(1);
  });

  it("fails safely when a calendar can't be read, rather than treating it as free", async () => {
    const f = fakeFetch({ calendars: { "primary-cal": { busy: [] }, "studio-cal": { errors: [{ domain: "global", reason: "notFound" }], busy: [] } } });
    await expect(createGoogleCalendar(cfg, f as any).busy(0, 1)).rejects.toMatchObject({ status: 503, code: "availability_unavailable" });
  });

  it("fails safely on an HTTP error or a network failure", async () => {
    await expect(createGoogleCalendar(cfg, fakeFetch({}, 500) as any).busy(0, 1)).rejects.toMatchObject({ code: "availability_unavailable" });
    const offline = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(createGoogleCalendar(cfg, offline as any).busy(0, 1)).rejects.toMatchObject({ code: "availability_unavailable" });
  });

  it("reads settings from the environment, with escaped newlines in the key", () => {
    expect(googleFromEnv({})).toBeNull();
    const g = googleFromEnv({ GOOGLE_SERVICE_ACCOUNT_EMAIL: "a@b", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN\\nKEY\\n-----END", GOOGLE_CALENDAR_IDS: "one, two" });
    expect(g).toEqual({ clientEmail: "a@b", privateKey: "-----BEGIN\nKEY\n-----END", calendarIds: ["one", "two"] });
  });
});
