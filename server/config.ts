// Server-only settings for the public booking page. Nothing here is sent to the browser.
import type { GoogleCalendarConfig } from "./integrations/googleCalendar.js";
import { smtpFromEnv, type SmtpConfig } from "./mail/mailer.js";
import { parseWeeklyHours, type WeeklyHours } from "./services/availability.js";

export const DEFAULT_BOOKING_HOURS = "mon-fri 10:00-18:00";

export interface BookingConfig {
  /** Weekly intro-call hours in Los Angeles time. Null when BOOKING_HOURS can't be read. */
  hours: WeeklyHours | null;
  slotMinutes: number;
  /** No call can be booked sooner than this. */
  minNoticeMinutes: number;
  /** No call can be booked further out than this. */
  maxDaysAhead: number;
  /** The Google Calendar intro calls are written to. */
  calendarId: string | null;
  /** Who gets the "new intro call" notice. */
  notifyEmail: string | null;
  /** How the call happens, shown in the confirmation email and invite. */
  meetingDetails: string;
  /** Outside production, client emails go only to the test allowlist and titles start with "[Preview]". */
  production: boolean;
  testEmailAllowlist: string[];
}

export interface ServerConfig {
  /** Google Calendar via Workload Identity Federation. Null until every setting is present. */
  google: GoogleCalendarConfig | null;
  /** Gmail SMTP with an app password. Null until SMTP_USER and SMTP_PASS are set. */
  smtp: SmtpConfig | null;
  booking: BookingConfig;
}

const positive = (raw: string | undefined, fallback: number) => (Number(raw) > 0 ? Number(raw) : fallback);

export function isProduction(env: Record<string, string | undefined>) {
  return env.VERCEL_ENV ? env.VERCEL_ENV === "production" : env.NODE_ENV === "production";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const google = googleFromEnv(env);
  const smtp = smtpFromEnv(env);
  let hours: WeeklyHours | null = null;
  try {
    hours = parseWeeklyHours(env.BOOKING_HOURS?.trim() || DEFAULT_BOOKING_HOURS);
  } catch (e) {
    console.error(`[booking] BOOKING_HOURS can't be read, so no times are offered: ${e instanceof Error ? e.message : "unknown"}`);
  }
  return {
    google,
    smtp,
    booking: {
      hours,
      slotMinutes: positive(env.BOOKING_SLOT_MINUTES, 15),
      minNoticeMinutes: positive(env.BOOKING_MIN_NOTICE_HOURS, 4) * 60,
      maxDaysAhead: positive(env.BOOKING_MAX_DAYS_AHEAD, 60),
      calendarId: env.BOOKING_CALENDAR_ID?.trim() || google?.calendarIds[0] || null,
      notifyEmail: env.BOOKING_NOTIFY_EMAIL?.trim() || smtp?.user || null,
      meetingDetails: env.BOOKING_MEETING_DETAILS?.trim() || "I'll call you at the number you gave, or send you a video link before the call if you didn't leave one.",
      production: isProduction(env),
      testEmailAllowlist: (env.BOOKING_TEST_EMAIL_ALLOWLIST ?? "luperdev@gmail.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
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
