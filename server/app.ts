// The site's API: only the public booking widget's open times. Vercel serves it from api/index.ts,
// and server.ts mounts it for local development.
import express, { type Request } from "express";
import { loadConfig, type ServerConfig } from "./config.js";
import { ApiError, errorHandler, wrap } from "./http.js";
import { createGhlClient, type GhlClient } from "./integrations/ghl.js";
import { availabilityUnavailable, createGoogleCalendar, type GoogleBusyClient } from "./integrations/googleCalendar.js";
import { memoryRateLimiter, type RateLimiter } from "./rateLimit.js";
import { BOOKING_TIMEZONE, openTimes, startOfBookingDate } from "./services/availability.js";

export interface Deps {
  config: ServerConfig;
  ghl: GhlClient | null;
  google: GoogleBusyClient | null;
  limiter: RateLimiter;
}

export function defaultDeps(): Deps {
  const config = loadConfig();
  return {
    config,
    ghl: config.ghl ? createGhlClient(config.ghl) : null,
    google: config.google ? createGoogleCalendar(config.google) : null,
    limiter: memoryRateLimiter(),
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const clientKey = (req: Request) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();

export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");

  // Open intro-call times: GoHighLevel's calendar rules as the base, minus Google Calendar busy times and
  // anything already started. If either source can't be read the answer is an error, never a guess.
  app.get("/api/booking/availability", wrap(async (req) => {
    deps.limiter.hit(`booking-availability:${clientKey(req)}`, 60, 60000);
    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    if (!DATE_ONLY.test(from) || !DATE_ONLY.test(to)) throw new ApiError(400, "invalid_input", "Some of the details provided aren't valid.");
    const fromMs = startOfBookingDate(from);
    const toMs = startOfBookingDate(to) + 86400000;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !(toMs > fromMs) || toMs - fromMs > 31 * 86400000) throw new ApiError(400, "invalid_input", "That date range isn't valid.");
    const booking = deps.config.booking;
    if (!deps.ghl || !deps.google) throw availabilityUnavailable();
    const ghl = deps.ghl, google = deps.google;
    let base: Record<string, string[]>, busy: Awaited<ReturnType<GoogleBusyClient["busy"]>>;
    try {
      // Busy times are read one slot-length past the range, so a slot at the end is checked in full.
      [base, busy] = await Promise.all([ghl.getFreeSlots(fromMs, toMs, booking.ghlCalendarId), google.busy(fromMs, toMs + booking.slotMinutes * 60000)]);
    } catch {
      throw availabilityUnavailable();
    }
    return { timezone: BOOKING_TIMEZONE, slotMinutes: booking.slotMinutes, days: openTimes({ base, busy, durationMinutes: booking.slotMinutes, now: Date.now() }) };
  }));

  app.use("/api", (_req, _res, next) => next(new ApiError(404, "not_found", "Not found.")));
  app.use(errorHandler);
  return app;
}
