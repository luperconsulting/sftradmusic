// The site's API: the public booking widget's open times and intro-call booking. Vercel serves it from
// api/index.ts, and server.ts mounts it for local development.
import express, { type Request } from "express";
import { loadConfig, type ServerConfig } from "./config.js";
import { ApiError, errorHandler, wrap } from "./http.js";
import { availabilityUnavailable, bookingUnavailable, createGoogleCalendar, slotTaken, type GoogleBusyClient } from "./integrations/googleCalendar.js";
import { createMailer, type Mailer } from "./mail/mailer.js";
import { memoryRateLimiter, type RateLimiter } from "./rateLimit.js";
import { BOOKING_TIMEZONE, bookingDate, openTimes, startOfBookingDate, weeklySlots } from "./services/availability.js";
import { clientConfirmation, introEvent, introInvite, parseIntroRequest, studioNotice, type IntroContext } from "./services/introBooking.js";

export interface Deps {
  config: ServerConfig;
  google: GoogleBusyClient | null;
  mailer: Mailer | null;
  limiter: RateLimiter;
  now: () => number;
}

export function defaultDeps(): Deps {
  const config = loadConfig();
  return {
    config,
    google: config.google ? createGoogleCalendar(config.google) : null,
    mailer: config.smtp ? createMailer(config.smtp) : null,
    limiter: memoryRateLimiter(),
    now: Date.now,
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;
const clientKey = (req: Request) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();

export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");
  const booking = deps.config.booking;

  /** Open times between two instants: weekly hours, minus Google busy times, minus notice and horizon. */
  async function openTimesBetween(fromDate: string, toDate: string) {
    if (!deps.google || !booking.hours) throw availabilityUnavailable();
    const now = deps.now();
    const fromMs = startOfBookingDate(fromDate);
    const toMs = startOfBookingDate(toDate) + DAY;
    const base = weeklySlots({ from: fromDate, to: toDate, hours: booking.hours, slotMinutes: booking.slotMinutes });
    let busy: Awaited<ReturnType<GoogleBusyClient["busy"]>>;
    try {
      // Busy times are read one slot-length past the range, so a slot at the end is checked in full.
      busy = await deps.google.busy(fromMs, toMs + booking.slotMinutes * 60000);
    } catch {
      throw availabilityUnavailable();
    }
    const days = openTimes({ base, busy, durationMinutes: booking.slotMinutes, now: now + booking.minNoticeMinutes * 60000 });
    const horizon = now + booking.maxDaysAhead * DAY;
    for (const [date, list] of Object.entries(days)) {
      const kept = list.filter((iso) => Date.parse(iso) <= horizon);
      if (kept.length) days[date] = kept;
      else delete days[date];
    }
    return days;
  }

  // Open intro-call times. If Google can't be read the answer is an error, never a guess.
  app.get("/api/booking/availability", wrap(async (req) => {
    deps.limiter.hit(`booking-availability:${clientKey(req)}`, 60, 60000);
    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    if (!DATE_ONLY.test(from) || !DATE_ONLY.test(to)) throw new ApiError(400, "invalid_input", "Some of the details provided aren't valid.");
    const fromMs = startOfBookingDate(from), toMs = startOfBookingDate(to) + DAY;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !(toMs > fromMs) || toMs - fromMs > 31 * DAY) throw new ApiError(400, "invalid_input", "That date range isn't valid.");
    return { timezone: BOOKING_TIMEZONE, slotMinutes: booking.slotMinutes, days: await openTimesBetween(from, to) };
  }));

  // Books an intro call: re-checks the time against the hours and Google, writes the Google event (its id is
  // tied to the start time, so the same slot can't be booked twice), then emails the client and the studio.
  app.post("/api/booking/intro", express.json({ limit: "16kb" }), wrap(async (req, res) => {
    deps.limiter.hit(`booking-intro:${clientKey(req)}`, 5, 10 * 60000);
    const intro = parseIntroRequest(req.body, BOOKING_TIMEZONE);
    if (intro.website) {
      // A bot filled in the hidden field. It gets an ordinary-looking answer and nothing is booked or sent.
      console.info("[booking] ignored a submission with the hidden field filled in.");
      return { booked: true, confirmationSent: true };
    }
    if (!deps.google || !deps.mailer || !booking.calendarId || !booking.notifyEmail) throw bookingUnavailable();
    const startMs = Date.parse(intro.start);
    const date = bookingDate(startMs);
    const open = await openTimesBetween(date, date).catch((e) => {
      if (e instanceof ApiError && e.code === "availability_unavailable") throw bookingUnavailable();
      throw e;
    });
    if (!(open[date] ?? []).includes(new Date(startMs).toISOString())) throw slotTaken();

    const ctx: IntroContext = { calendarId: booking.calendarId, hostZone: BOOKING_TIMEZONE, slotMinutes: booking.slotMinutes, meetingDetails: booking.meetingDetails, label: booking.production ? "" : "[Preview] " };
    const event = introEvent(intro, startMs, ctx);
    const created = await deps.google.createEvent(event);

    // The call is booked once the event exists. Mail problems are reported, but never undo the booking.
    const mailer = deps.mailer;
    const clientAllowed = booking.production || booking.testEmailAllowlist.includes(intro.email);
    if (!clientAllowed) console.info("[booking] preview: the client confirmation was not sent (address not on the test allowlist).");
    const confirmation = clientConfirmation(intro, event, ctx, "Zane");
    const clientEmailed = clientAllowed
      ? await mailer.send({ to: intro.email, replyTo: mailer.from, ...confirmation, invite: introInvite(intro, event, { name: "Zane Luper", email: mailer.from }, booking.meetingDetails, deps.now()) })
      : false;
    await mailer.send({ to: booking.notifyEmail, replyTo: intro.email, ...studioNotice(intro, event, ctx, { htmlLink: created.htmlLink, clientEmailed }) });
    res.status(201);
    return { booked: true, start: new Date(event.startMs).toISOString(), end: new Date(event.endMs).toISOString(), confirmationSent: clientEmailed };
  }));

  app.use("/api", (_req, _res, next) => next(new ApiError(404, "not_found", "Not found.")));
  app.use(errorHandler);
  return app;
}
