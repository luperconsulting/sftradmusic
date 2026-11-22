import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "../server/app";
import { googleFromEnv, loadConfig } from "../server/config";
import { createGoogleCalendar, failureReason, FREEBUSY_SCOPE, EVENTS_SCOPE, workloadIdentityOptions, workloadIdentityTokenSource } from "../server/integrations/googleCalendar";
import { createMailer, smtpFromEnv, type OutgoingMail } from "../server/mail/mailer";
import { memoryRateLimiter } from "../server/rateLimit";
import { bookingDate, openTimes, parseWeeklyHours, startOfBookingDate, weeklySlots, zonedTime } from "../server/services/availability";
import { introEventId, introInvite, parseIntroRequest } from "../server/services/introBooking";

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

describe("weekly intro-call hours", () => {
  it("reads day ranges, lists and several ranges a day, and refuses typos", () => {
    expect(parseWeeklyHours("mon-fri 10:00-18:00; sat 10:00-14:00")).toEqual({ 1: [[600, 1080]], 2: [[600, 1080]], 3: [[600, 1080]], 4: [[600, 1080]], 5: [[600, 1080]], 6: [[600, 840]] });
    expect(parseWeeklyHours("tue,thu 09:30-12:00,13:00-17:00")).toEqual({ 2: [[570, 720], [780, 1020]], 4: [[570, 720], [780, 1020]] });
    expect(parseWeeklyHours("Saturday 10:00-11:00")).toEqual({ 6: [[600, 660]] });
    for (const bad of ["mon 10-18", "funday 10:00-11:00", "mon 18:00-10:00", "mon"]) expect(() => parseWeeklyHours(bad)).toThrow();
  });

  it("makes 15-minute slots inside the hours in Los Angeles time, across daylight saving", () => {
    const tue = weeklySlots({ from: "2026-11-10", to: "2026-11-10", hours: { 2: [[600, 660]] }, slotMinutes: 15 });
    expect(tue["2026-11-10"]).toEqual(["18:00", "18:15", "18:30", "18:45"].map((t) => `2026-11-10T${t}:00.000Z`));
    const summer = weeklySlots({ from: "2026-07-07", to: "2026-07-07", hours: { 2: [[600, 615]] }, slotMinutes: 15 });
    expect(summer["2026-07-07"]).toEqual(["2026-07-07T17:00:00.000Z"]);
    // The day clocks fall back: 10:00 AM is already PST.
    expect(new Date(zonedTime("2026-11-01", 600)).toISOString()).toBe("2026-11-01T18:00:00.000Z");
    expect(new Date(zonedTime("2026-03-08", 600)).toISOString()).toBe("2026-03-08T17:00:00.000Z");
    // A Sunday has no hours, so no slots.
    expect(weeklySlots({ from: "2026-11-08", to: "2026-11-08", hours: { 2: [[600, 660]] }, slotMinutes: 15 })).toEqual({});
  });
});

const NOW_TUE = Date.parse("2026-11-10T16:00:00Z"); // Tue 8:00 AM in Los Angeles
const SLOT = "2026-11-11T18:00:00.000Z"; // Wed 10:00 AM in Los Angeles

function testDeps(over: { env?: Record<string, string>; busy?: () => Promise<any>; createEvent?: (e: any) => Promise<any>; send?: (m: OutgoingMail) => Promise<boolean>; google?: null; mailer?: null } = {}) {
  const env = { BOOKING_HOURS: "mon-fri 10:00-12:00", GCP_PROJECT_NUMBER: "1", GCP_WORKLOAD_IDENTITY_POOL_ID: "p", GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "v", GOOGLE_SERVICE_ACCOUNT_EMAIL: "sa@example.iam.gserviceaccount.com", GOOGLE_CALENDAR_IDS: "studio-cal", SMTP_USER: "studio@example.com", SMTP_PASS: "app pass word xxxx", ...over.env };
  const busy = vi.fn(over.busy ?? (async () => []));
  const createEvent = vi.fn(over.createEvent ?? (async (e: any) => ({ id: e.id, htmlLink: "https://calendar.google.com/event?eid=x" })));
  const sent: OutgoingMail[] = [];
  const send = vi.fn(over.send ?? (async (m: OutgoingMail) => { sent.push(m); return true; }));
  const deps: Deps = {
    config: loadConfig(env),
    google: over.google === null ? null : { busy, createEvent },
    mailer: over.mailer === null ? null : { from: "studio@example.com", send },
    limiter: memoryRateLimiter(),
    now: () => NOW_TUE,
  };
  return { deps, busy, createEvent, send, sent };
}

describe("GET /api/booking/availability", () => {
  const get = (deps: Deps, query = "from=2026-11-10&to=2026-11-12") => request(createApp(deps)).get(`/api/booking/availability?${query}`);

  it("is public and returns the weekly hours minus Google busy times, in Los Angeles time", async () => {
    const { deps } = testDeps({ busy: async () => [{ start: Date.parse("2026-11-11T18:10:00Z"), end: Date.parse("2026-11-11T19:00:00Z") }] });
    const res = await get(deps, "from=2026-11-11&to=2026-11-11");
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("America/Los_Angeles");
    // 10:00–12:00 in 15-minute slots, with 10:00–11:00 busy (10:00 overlaps the event starting 10:10).
    expect(res.body.days["2026-11-11"]).toEqual(["19:00", "19:15", "19:30", "19:45"].map((t) => `2026-11-11T${t}:00.000Z`));
  });

  it("never offers a time inside the minimum notice or past the horizon", async () => {
    const { deps } = testDeps({ env: { BOOKING_MIN_NOTICE_HOURS: "3", BOOKING_MAX_DAYS_AHEAD: "1" } });
    const res = await get(deps, "from=2026-11-10&to=2026-11-12");
    // Now is 8:00 AM Tue; 3 hours' notice leaves 11:15 onward today. One day ahead ends 8:00 AM Wed.
    expect(res.body.days).toEqual({ "2026-11-10": ["2026-11-10T19:15:00.000Z", "2026-11-10T19:30:00.000Z", "2026-11-10T19:45:00.000Z"] });
  });

  it("asks Google about one slot-length past the range, so the last slot is fully checked", async () => {
    const { deps, busy } = testDeps();
    await get(deps, "from=2026-11-10&to=2026-11-10");
    const [from, to] = busy.mock.calls[0] as unknown as [number, number];
    expect(new Date(from).toISOString()).toBe("2026-11-10T08:00:00.000Z");
    expect(new Date(to).toISOString()).toBe("2026-11-11T08:15:00.000Z");
  });

  it("returns the same safe error when Google fails, isn't set up, or the hours can't be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const d of [testDeps({ busy: async () => { throw new Error("boom"); } }).deps, testDeps({ google: null }).deps, testDeps({ env: { BOOKING_HOURS: "mon 25:00" } }).deps]) {
      const res = await get(d);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("availability_unavailable");
      expect(res.body.days).toBeUndefined();
    }
  });

  it("refuses an invalid or overlong range, and slows down a client that asks too often", async () => {
    const { deps } = testDeps();
    expect((await get(deps, "from=2026-11-12&to=2026-11-10")).status).toBe(400);
    expect((await get(deps, "from=2026-11-01&to=2026-12-31")).status).toBe(400);
    expect((await get(deps, "from=nope&to=2026-11-10")).status).toBe(400);
    const app = createApp(testDeps().deps);
    for (let i = 0; i < 60; i++) await request(app).get("/api/booking/availability?from=2026-11-10&to=2026-11-10");
    expect((await request(app).get("/api/booking/availability?from=2026-11-10&to=2026-11-10")).status).toBe(429);
  });
});

describe("POST /api/booking/intro", () => {
  const body = { start: SLOT, name: "Arzo Luper", email: "luperdev@gmail.com", phone: "(415) 555-0100", level: "some", notes: "Irish tunes, please.", timeZone: "America/New_York" };
  const post = (deps: Deps, b: object = body) => request(createApp(deps)).post("/api/booking/intro").send(b);

  it("books the call on Google Calendar and emails the client and the studio", async () => {
    const { deps, createEvent, sent } = testDeps();
    const res = await post(deps);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ booked: true, start: SLOT, end: "2026-11-11T18:15:00.000Z", confirmationSent: true });
    const event = createEvent.mock.calls[0][0];
    expect(event).toMatchObject({ id: introEventId(Date.parse(SLOT)), calendarId: "studio-cal", summary: "[Preview] Intro call: Arzo Luper", startMs: Date.parse(SLOT), endMs: Date.parse(SLOT) + 15 * 60000, timeZone: "America/Los_Angeles" });
    expect(event.description).toContain("luperdev@gmail.com");
    expect(event.description).toContain("(415) 555-0100");
    const [client, studio] = sent;
    expect(client.to).toBe("luperdev@gmail.com");
    expect(client.subject).toContain("Your intro call is booked");
    // The client's own time zone, with the studio's time alongside.
    expect(client.text).toContain("1:00 PM EST");
    expect(client.text).toContain("10:00 AM PST for me");
    expect(client.invite).toContain("METHOD:REQUEST");
    expect(client.invite).toContain("DTSTART:20261111T180000Z");
    expect(studio.to).toBe("studio@example.com");
    expect(studio.replyTo).toBe("luperdev@gmail.com");
    expect(studio.subject).toContain("New intro call: Arzo Luper");
    expect(studio.text).toContain("https://calendar.google.com/event?eid=x");
  });

  it("refuses a time that's taken in Google, outside the hours, inside the notice, or already booked", async () => {
    const busyNow = testDeps({ busy: async () => [{ start: Date.parse(SLOT), end: Date.parse(SLOT) + 3600000 }] });
    const offHours = testDeps();
    const tooSoon = testDeps({ env: { BOOKING_MIN_NOTICE_HOURS: "48" } });
    const duplicate = testDeps({ createEvent: async () => { const { slotTaken } = await import("../server/integrations/googleCalendar"); throw slotTaken(); } });
    for (const [d, start] of [[busyNow, SLOT], [offHours, "2026-11-11T22:00:00.000Z"], [offHours, "2026-11-11T18:05:00.000Z"], [tooSoon, SLOT], [duplicate, SLOT]] as const) {
      const res = await post(d.deps, { ...body, start });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("slot_taken");
      expect(d.send).not.toHaveBeenCalled();
    }
    expect(busyNow.createEvent).not.toHaveBeenCalled();
  });

  it("books nothing and sends nothing when Google fails or isn't set up, or mail isn't set up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { bookingUnavailable } = await import("../server/integrations/googleCalendar");
    for (const d of [testDeps({ createEvent: async () => { throw bookingUnavailable(); } }), testDeps({ busy: async () => { throw new Error("down"); } }), testDeps({ google: null }), testDeps({ mailer: null })]) {
      const res = await post(d.deps);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("booking_unavailable");
      expect(d.send).not.toHaveBeenCalled();
    }
  });

  it("keeps the booking when the confirmation email fails, and tells the studio to follow up", async () => {
    const sent: OutgoingMail[] = [];
    const d = testDeps({ send: async (m) => { sent.push(m); return m.to !== "luperdev@gmail.com"; } });
    const res = await post(d.deps);
    expect(res.status).toBe(201);
    expect(res.body.confirmationSent).toBe(false);
    expect(sent[1].text).toContain("NOT sent");
  });

  it("outside production, only emails clients on the test allowlist; in production it emails anyone and drops the label", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const preview = testDeps();
    const res = await post(preview.deps, { ...body, email: "someone@example.com" });
    expect(res.status).toBe(201);
    expect(preview.sent.map((m) => m.to)).toEqual(["studio@example.com"]);
    const prod = testDeps({ env: { VERCEL_ENV: "production" } });
    await post(prod.deps, { ...body, email: "someone@example.com" });
    expect(prod.sent.map((m) => m.to)).toEqual(["someone@example.com", "studio@example.com"]);
    expect(prod.createEvent.mock.calls[0][0].summary).toBe("Intro call: Arzo Luper");
  });

  it("validates the details, ignores bots that fill the hidden field, and limits repeat bookings", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const d = testDeps();
    expect((await post(d.deps, { ...body, name: "" })).status).toBe(400);
    expect((await post(d.deps, { ...body, email: "nope" })).status).toBe(400);
    expect((await post(d.deps, { ...body, start: "soon" })).status).toBe(400);
    expect((await post(d.deps, { ...body, notes: "x".repeat(2001) })).status).toBe(400);
    const bot = testDeps();
    const res = await post(bot.deps, { ...body, website: "http://spam.example" });
    expect(res.body.booked).toBe(true);
    expect(bot.createEvent).not.toHaveBeenCalled();
    expect(bot.send).not.toHaveBeenCalled();
    const app = createApp(testDeps().deps);
    for (let i = 0; i < 5; i++) await request(app).post("/api/booking/intro").send({ ...body, name: "" });
    expect((await request(app).post("/api/booking/intro").send(body)).status).toBe(429);
  });

  it("keeps line breaks out of single-line fields and falls back to Los Angeles for an unknown time zone", () => {
    const r = parseIntroRequest({ ...body, name: "Arzo\r\nBcc: x@example.com", timeZone: "Mars/Olympus" }, "America/Los_Angeles");
    expect(r.name).toBe("Arzo Bcc: x@example.com");
    expect(r.timeZone).toBe("America/Los_Angeles");
  });

  it("writes a valid calendar invite with escaped text and folded lines", () => {
    const r = parseIntroRequest({ ...body, name: "Arzo; Luper, Jr" }, "America/Los_Angeles");
    const ics = introInvite(r, { id: "intro1", calendarId: "c", summary: "s", description: "d", startMs: Date.parse(SLOT), endMs: Date.parse(SLOT) + 900000, timeZone: "America/Los_Angeles" }, { name: "Zane Luper", email: "studio@example.com" }, "Bring your fiddle, a tuner; and questions.\n".repeat(4), 0);
    expect(ics.replace(/\r\n /g, "")).toContain("DESCRIPTION:Bring your fiddle\\, a tuner\\; and questions.\\n");
    expect(ics.replace(/\r\n /g, "")).toContain('ATTENDEE;CN="Arzo; Luper, Jr";');
    expect(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
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

  it("builds the Workload Identity Federation exchange for the pool, provider and service account, with free/busy and events scopes only", async () => {
    const opts = workloadIdentityOptions(cfg, async () => "vercel-oidc-token");
    expect(opts.audience).toBe("//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/vercel-oidc");
    expect(opts.subject_token_type).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(opts.token_url).toBe("https://sts.googleapis.com/v1/token");
    expect(opts.service_account_impersonation_url).toBe("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/booking%40example.iam.gserviceaccount.com:generateAccessToken");
    expect(opts.scopes).toEqual([FREEBUSY_SCOPE, EVENTS_SCOPE]);
    expect(EVENTS_SCOPE).toBe("https://www.googleapis.com/auth/calendar.events");
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
    expect(JSON.parse(iam[0].body).scope).toEqual([FREEBUSY_SCOPE, EVENTS_SCOPE]);
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

  describe("creating an intro-call event", () => {
    const event = { id: "intro1abc", calendarId: "studio@example.com", summary: "Intro call: Arzo Luper", description: "d", startMs: Date.parse("2026-11-11T18:00:00Z"), endMs: Date.parse("2026-11-11T18:15:00Z"), timeZone: "America/Los_Angeles" };

    it("posts the event with its id, times and no attendees", async () => {
      const f = vi.fn(async (_u: any, _i: any) => json({ id: "intro1abc", htmlLink: "https://calendar.google.com/x" }));
      expect(await createGoogleCalendar(cfg, token, f as any).createEvent(event)).toEqual({ id: "intro1abc", htmlLink: "https://calendar.google.com/x" });
      const [url, init] = f.mock.calls[0] as any;
      expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/studio%40example.com/events");
      expect(init.method).toBe("POST");
      const sent = JSON.parse(init.body);
      expect(sent).toMatchObject({ id: "intro1abc", summary: "Intro call: Arzo Luper", start: { dateTime: "2026-11-11T18:00:00.000Z", timeZone: "America/Los_Angeles" }, end: { dateTime: "2026-11-11T18:15:00.000Z" } });
      expect(sent.attendees).toBeUndefined();
    });

    it("says the slot is taken when a live event has the id, and reuses a cancelled one", async () => {
      const live = vi.fn(async (_u: any, init: any) => (init.method === "POST" ? json({}, 409) : json({ status: "confirmed" })));
      await expect(createGoogleCalendar(cfg, token, live as any).createEvent(event)).rejects.toMatchObject({ status: 409, code: "slot_taken" });
      const cancelled = vi.fn(async (_u: any, init: any) => (init.method === "POST" ? json({}, 409) : init.method === "GET" ? json({ status: "cancelled" }) : json({ id: "intro1abc" })));
      expect(await createGoogleCalendar(cfg, token, cancelled as any).createEvent(event)).toEqual({ id: "intro1abc", htmlLink: null });
      expect((cancelled.mock.calls[2] as any)[1].method).toBe("PUT");
    });

    it("fails safely, logging only a short reason, when Google refuses (for example, no edit access)", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(createGoogleCalendar(cfg, token, freeBusyFetch({}, 403) as any).createEvent(event)).rejects.toMatchObject({ status: 503, code: "booking_unavailable" });
      expect(log.mock.calls.map((c) => String(c[0]))).toEqual(["[google] create event failed: google events 403"]);
    });
  });

  it("reads the federation settings from the environment and needs all of them; no private key is read", () => {
    const env = { GCP_PROJECT_NUMBER: " 123456789 ", GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel", GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "vercel-oidc", GOOGLE_SERVICE_ACCOUNT_EMAIL: "booking@example.iam.gserviceaccount.com", GOOGLE_CALENDAR_IDS: "primary-cal, studio-cal" };
    expect(googleFromEnv(env)).toEqual(cfg);
    expect(googleFromEnv({})).toBeNull();
    for (const k of Object.keys(env)) expect(googleFromEnv({ ...env, [k]: "" })).toBeNull();
    expect(googleFromEnv({ ...env, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "ignored" })).toEqual(cfg);
  });
});

describe("Gmail mailer", () => {
  it("reads SMTP settings without the app password's spaces", () => {
    expect(smtpFromEnv({})).toBeNull();
    expect(smtpFromEnv({ SMTP_USER: "studio@example.com", SMTP_PASS: "abcd efgh ijkl mnop" })).toEqual({ user: "studio@example.com", pass: "abcdefghijklmnop", fromName: "Zane Luper" });
  });

  it("sends from the studio with the invite attached, and reports failures without details", async () => {
    const deliver = vi.fn(async (_m: any) => ({}));
    const mailer = createMailer({ user: "studio@example.com", pass: "x", fromName: "Zane Luper" }, deliver);
    expect(await mailer.send({ to: "luperdev@gmail.com", subject: "Hi", text: "t", html: "<p>t</p>", invite: "BEGIN:VCALENDAR" })).toBe(true);
    expect(deliver.mock.calls[0][0]).toMatchObject({ from: { name: "Zane Luper", address: "studio@example.com" }, to: "luperdev@gmail.com", icalEvent: { method: "REQUEST", content: "BEGIN:VCALENDAR" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = createMailer({ user: "studio@example.com", pass: "secret-pass", fromName: "Z" }, async () => { throw Object.assign(new Error("Invalid login secret-pass"), { responseCode: 535 }); });
    expect(await failing.send({ to: "luperdev@gmail.com", subject: "Hi", text: "t", html: "t" })).toBe(false);
    expect(String(log.mock.calls[0][0])).toBe('[mail] "Hi" was not sent (535).');
  });
});
