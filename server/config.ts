// Server-only settings for the public booking widget. Nothing here is sent to the browser.
import type { GhlConfig } from "./integrations/ghl.js";
import type { GoogleCalendarConfig } from "./integrations/googleCalendar.js";

export interface ServerConfig {
  /** GoHighLevel, read-only: the booking calendar's open hours and rules. Null until the token and location are set. */
  ghl: GhlConfig | null;
  /** Google Calendar free/busy via Workload Identity Federation. Null until every setting is present. */
  google: GoogleCalendarConfig | null;
  /** Which GoHighLevel calendar's rules give the base times, and the slot length. */
  booking: { ghlCalendarId: string; slotMinutes: number };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const token = env.GHL_PRIVATE_INTEGRATION_TOKEN?.trim();
  const locationId = env.GHL_LOCATION_ID?.trim();
  return {
    ghl: token && locationId ? { token, locationId, timezone: env.GHL_TIMEZONE || "America/Los_Angeles" } : null,
    google: googleFromEnv(env),
    booking: {
      // The intro-call calendar the booking page has always used. Its open hours and rules stay in GoHighLevel.
      ghlCalendarId: env.BOOKING_GHL_CALENDAR_ID || "vc5JhcEjhKFs3MpJyj9p",
      slotMinutes: Number(env.BOOKING_SLOT_MINUTES) > 0 ? Number(env.BOOKING_SLOT_MINUTES) : 15,
    },
  };
}

export function googleFromEnv(env: Record<string, string | undefined>): GoogleCalendarConfig | null {
  const projectNumber = env.GCP_PROJECT_NUMBER?.trim();
  const poolId = env.GCP_WORKLOAD_IDENTITY_POOL_ID?.trim();
  const providerId = env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID?.trim();
  const serviceAccountEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const calendarIds = (env.GOOGLE_CALENDAR_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return projectNumber && poolId && providerId && serviceAccountEmail && calendarIds.length
    ? { projectNumber, poolId, providerId, serviceAccountEmail, calendarIds }
    : null;
}
