import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { googleFromEnv } from "../server/config";
import { createGoogleCalendar, failureReason, FREEBUSY_SCOPE, workloadIdentityOptions, workloadIdentityTokenSource } from "../server/integrations/googleCalendar";
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
