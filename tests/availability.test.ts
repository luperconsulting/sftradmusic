// Open times = the teacher's weekly lesson hours (Supabase) minus Google Calendar busy times minus booked or held
// lessons. Used by the public booking widget (GET /api/booking/availability) and the portal (GET /api/lessons/slots).
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { googleFromEnv } from "../server/config";
import { createGoogleCalendar, failureReason, FREEBUSY_SCOPE, workloadIdentityOptions, workloadIdentityTokenSource } from "../server/integrations/googleCalendar";
import { bookingDate, openSlots, startOfBookingDate, zonedMinute } from "../server/services/availability";
import { buildDeps, fakeGoogle, fixtureTables } from "./helpers";
import { lessonRow, TEACHER_ACCOUNT } from "./memoryStore";

const NOW = Date.parse("2026-11-10T17:00:00Z"); // Tuesday 9:00 AM in Los Angeles
const iso = (s: string) => new Date(s).toISOString();
const TUESDAY = [{ weekday: 2, startMinute: 10 * 60, endMinute: 13 * 60 }]; // 10:00-13:00

describe("open times", () => {
  it("offers 60-minute starts every half hour inside the weekly hours", () => {
    const days = openSlots({ hours: TUESDAY, fromDate: "2026-11-10", toDate: "2026-11-10", busy: [], lessons: [], durationMinutes: 60, stepMinutes: 30, now: NOW });
    expect(days["2026-11-10"]).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00"].map((t) => iso(`2026-11-10T${t}:00-08:00`)));
  });

  it("drops a time that a Google Calendar event covers, including partial overlaps", () => {
    const busy = [{ start: Date.parse("2026-11-10T10:45:00-08:00"), end: Date.parse("2026-11-10T11:15:00-08:00") }];
    const days = openSlots({ hours: TUESDAY, fromDate: "2026-11-10", toDate: "2026-11-10", busy, lessons: [], durationMinutes: 60, stepMinutes: 30, now: NOW });
    expect(days["2026-11-10"]).toEqual(["11:30", "12:00"].map((t) => iso(`2026-11-10T${t}:00-08:00`)));
  });

  it("drops times taken by confirmed or held lessons, but not cancelled or released ones", () => {
    const lessons = [
      lessonRow("s", iso("2026-11-10T10:00:00-08:00")),
      lessonRow("s", iso("2026-11-10T12:00:00-08:00"), { status: "pending_payment", holdExpiresAt: iso("2026-11-11T00:00:00Z") }),
      lessonRow("s", iso("2026-11-10T11:00:00-08:00"), { status: "cancelled", cancelledAt: iso("2026-11-09T00:00:00Z") }),
    ];
    const days = openSlots({ hours: TUESDAY, fromDate: "2026-11-10", toDate: "2026-11-10", busy: [], lessons, durationMinutes: 60, stepMinutes: 30, now: NOW });
    expect(days["2026-11-10"]).toEqual([iso("2026-11-10T11:00:00-08:00")]);
  });

  it("never shows a time that has started or passed", () => {
    const later = Date.parse("2026-11-10T10:15:00-08:00");
    const days = openSlots({ hours: TUESDAY, fromDate: "2026-11-10", toDate: "2026-11-10", busy: [], lessons: [], durationMinutes: 60, stepMinutes: 30, now: later });
    expect(days["2026-11-10"][0]).toBe(iso("2026-11-10T10:30:00-08:00"));
  });

  it("only uses the weekdays that have hours", () => {
    const days = openSlots({ hours: TUESDAY, fromDate: "2026-11-10", toDate: "2026-11-16", busy: [], lessons: [], durationMinutes: 60, stepMinutes: 30, now: NOW });
    expect(Object.keys(days)).toEqual(["2026-11-10"]);
  });

  it("works out Los Angeles wall times across daylight-saving changes", () => {
    expect(new Date(startOfBookingDate("2026-11-10")).toISOString()).toBe("2026-11-10T08:00:00.000Z");
    expect(new Date(startOfBookingDate("2026-07-01")).toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(new Date(zonedMinute("2026-07-01", 600)).toISOString()).toBe("2026-07-01T17:00:00.000Z");
    expect(new Date(zonedMinute("2026-11-01", 600)).toISOString()).toBe("2026-11-01T18:00:00.000Z");
    expect(bookingDate(Date.parse("2026-11-11T07:59:00Z"))).toBe("2026-11-10");
  });
});

describe("GET /api/booking/availability (public widget)", () => {
  const future = new Date(Date.now() + 7 * 86400000);
  const date = bookingDate(future.getTime());
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  function setup(opts: { busy?: { start: number; end: number }[]; google?: null; hours?: boolean } = {}) {
    const tables = fixtureTables();
    if (opts.hours !== false) tables.hours[TEACHER_ACCOUNT] = [{ weekday, startMinute: 600, endMinute: 660 }];
    const g = fakeGoogle(opts.busy ?? []);
    const deps = buildDeps({}, {}, tables, { google: opts.google === null ? null : g.client });
    return { app: createApp(deps), g };
  }
  const get = (app: any, q = `from=${date}&to=${date}`) => request(app).get(`/api/booking/availability?${q}`);

  it("is public and returns lesson hours minus Google busy times, in Los Angeles time", async () => {
    const { app } = setup();
    const res = await get(app);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ timezone: "America/Los_Angeles", slotMinutes: 15 });
    expect(res.body.days[date]).toEqual([0, 15, 30, 45].map((m) => new Date(zonedMinute(date, 600 + m)).toISOString()));
  });

  it("removes Google busy times", async () => {
    const busyStart = zonedMinute(date, 600), busyEnd = zonedMinute(date, 630);
    const { app } = setup({ busy: [{ start: busyStart, end: busyEnd }] });
    expect((await get(app)).body.days[date]).toEqual([30, 45].map((m) => new Date(zonedMinute(date, 600 + m)).toISOString()));
  });

  it("returns the safe error, never unchecked times, when Google isn't configured or fails", async () => {
    for (const over of [{ google: null as null }]) {
      const res = await get(setup(over).app);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("availability_unavailable");
      expect(res.body.days).toBeUndefined();
    }
    const failing = buildDeps({}, {}, fixtureTables(), { google: { busy: async () => { throw new (await import("../server/http")).ApiError(503, "availability_unavailable", "x"); } } });
    failing.store!.listLessonHours = async () => [{ weekday, startMinute: 600, endMinute: 660 }];
    expect((await get(createApp(failing))).status).toBe(503);
  });

  it("returns no times when the teacher hasn't set lesson hours", async () => {
    expect((await get(setup({ hours: false }).app)).body.days).toEqual({});
  });

  it("slows down a client that asks too often", async () => {
    const { app } = setup();
    for (let i = 0; i < 60; i++) await get(app);
    expect((await get(app)).status).toBe(429);
  });

  it("refuses an invalid or overlong range", async () => {
    const { app } = setup();
    expect((await get(app, "from=2026-11-12&to=2026-11-10")).status).toBe(400);
    expect((await get(app, "from=2026-11-01&to=2026-12-31")).status).toBe(400);
    expect((await get(app, "from=nope&to=2026-11-10")).status).toBe(400);
  });
});

describe("Google Calendar client", () => {
  const cfg = { projectNumber: "123456789", poolId: "vercel", providerId: "vercel-oidc", serviceAccountEmail: "booking@example.iam.gserviceaccount.com", calendarIds: ["primary-cal", "studio-cal"] };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const freeBusyFetch = (body: unknown, status = 200) => vi.fn(async (_url: any, _init: any) => json(body, status));
  const token = async () => "access";

  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("asks only for busy times with the federated token and merges every calendar", async () => {
    const f = freeBusyFetch({ calendars: { "primary-cal": { busy: [{ start: "2026-11-10T18:00:00Z", end: "2026-11-10T19:00:00Z" }] }, "studio-cal": { busy: [] } } });
    const busy = await createGoogleCalendar(cfg, token, f as any).busy(0, 1);
    expect(busy).toEqual([{ start: Date.parse("2026-11-10T18:00:00Z"), end: Date.parse("2026-11-10T19:00:00Z") }]);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
    expect(init.headers.Authorization).toBe("Bearer access");
    expect(JSON.parse(init.body).items).toEqual([{ id: "primary-cal" }, { id: "studio-cal" }]);
  });

  it("builds the Workload Identity Federation exchange for the pool, provider and service account, free/busy scope only", async () => {
    const opts = workloadIdentityOptions(cfg, async () => "vercel-oidc-token");
    expect(opts.audience).toBe("//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/vercel-oidc");
    expect(opts.subject_token_type).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(opts.token_url).toBe("https://sts.googleapis.com/v1/token");
    expect(opts.service_account_impersonation_url).toBe("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/booking%40example.iam.gserviceaccount.com:generateAccessToken");
    expect(opts.scopes).toEqual([FREEBUSY_SCOPE]);
    expect(FREEBUSY_SCOPE).toBe("https://www.googleapis.com/auth/calendar.freebusy");
    expect(await opts.subject_token_supplier!.getSubjectToken({} as any)).toBe("vercel-oidc-token");
  });

  it("exchanges the Vercel OIDC token at Google STS, impersonates the service account, and reuses the token", async () => {
    const calls: { url: string; body: string }[] = [];
    const fakeGoogle = vi.fn(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url ?? String(input);
      const body = init.body == null ? "" : typeof init.body === "string" ? init.body : init.body.toString();
      calls.push({ url, body });
      if (url.startsWith("https://sts.googleapis.com")) return json({ access_token: "federated", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 });
      if (url.startsWith("https://iamcredentials.googleapis.com")) return json({ accessToken: "impersonated", expireTime: new Date(Date.now() + 3600_000).toISOString() });
      return json({}, 404);
    });
    // google-auth-library's STS step always makes its own HTTP client, which takes window.fetch when there is one
    // (and caches it for this test file). Giving it this fake keeps the test offline.
    vi.stubGlobal("window", { fetch: fakeGoogle });
    const source = workloadIdentityTokenSource(cfg, async () => "vercel-oidc-token");
    expect(await source()).toBe("impersonated");
    expect(await source()).toBe("impersonated");
    const sts = calls.filter((c) => c.url.startsWith("https://sts.googleapis.com"));
    expect(sts).toHaveLength(1);
    const form = new URLSearchParams(sts[0].body);
    expect(form.get("subject_token")).toBe("vercel-oidc-token");
    expect(form.get("audience")).toBe("//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/vercel-oidc");
    const iam = calls.filter((c) => c.url.startsWith("https://iamcredentials.googleapis.com"));
    expect(iam).toHaveLength(1);
    expect(iam[0].url).toContain("booking%40example.iam.gserviceaccount.com:generateAccessToken");
    expect(JSON.parse(iam[0].body).scope).toEqual([FREEBUSY_SCOPE]);
  });

  it("fails safely, logging only a short reason, when the token exchange is refused or the OIDC token is missing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = Object.assign(new Error("Request failed: subject_token=vercel-oidc-token secret detail"), { response: { status: 403 } });
    await expect(createGoogleCalendar(cfg, async () => { throw refused; }, freeBusyFetch({}) as any).busy(0, 1)).rejects.toMatchObject({ status: 503, code: "availability_unavailable" });
    const missing = Object.assign(new Error("The 'x-vercel-oidc-token' header is missing"), { name: "AccessTokenMissingError" });
    await expect(createGoogleCalendar(cfg, async () => { throw missing; }, freeBusyFetch({}) as any).busy(0, 1)).rejects.toMatchObject({ code: "availability_unavailable" });
    const logged = log.mock.calls.map((c) => String(c[0]));
    expect(logged).toEqual(["[google] free/busy failed: google auth 403", "[google] free/busy failed: vercel oidc token unavailable"]);
    expect(logged.join(" ")).not.toMatch(/vercel-oidc-token|secret|subject_token/);
  });

  it("never logs an unexpected error's message", () => {
    expect(failureReason(new TypeError("token abc.def.ghi leaked"))).toBe("TypeError");
    expect(failureReason("nope")).toBe("unknown");
  });

  it("fails safely when a calendar can't be read, rather than treating it as free", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = freeBusyFetch({ calendars: { "primary-cal": { busy: [] }, "studio-cal": { errors: [{ domain: "global", reason: "notFound" }], busy: [] } } });
    await expect(createGoogleCalendar(cfg, token, f as any).busy(0, 1)).rejects.toMatchObject({ status: 503, code: "availability_unavailable" });
  });

  it("fails safely on an HTTP error or a network failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createGoogleCalendar(cfg, token, freeBusyFetch({}, 500) as any).busy(0, 1)).rejects.toMatchObject({ code: "availability_unavailable" });
    const offline = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(createGoogleCalendar(cfg, token, offline as any).busy(0, 1)).rejects.toMatchObject({ code: "availability_unavailable" });
  });

  it("reads the federation settings from the environment and needs all of them; no private key is read", () => {
    const env = { GCP_PROJECT_NUMBER: " 123456789 ", GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel", GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "vercel-oidc", GOOGLE_SERVICE_ACCOUNT_EMAIL: "booking@example.iam.gserviceaccount.com", GOOGLE_CALENDAR_IDS: "primary-cal, studio-cal" };
    expect(googleFromEnv(env)).toEqual(cfg);
    expect(googleFromEnv({})).toBeNull();
    for (const k of Object.keys(env)) expect(googleFromEnv({ ...env, [k]: "" })).toBeNull();
    expect(googleFromEnv({ ...env, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "ignored" })).toEqual(cfg);
  });
});

