// LEGACY. GoHighLevel settings for migration scripts only. The portal server does not read these.
import type { GhlConfig } from "./client.js";

/** Null unless the token, location and calendar are all set. */
export function ghlConfigFromEnv(env: Record<string, string | undefined>, safeMode: boolean): GhlConfig | null {
  const token = env.GHL_PRIVATE_INTEGRATION_TOKEN;
  const locationId = env.GHL_LOCATION_ID;
  const calendarId = env.GHL_LESSON_CALENDAR_ID;
  if (!token || !locationId || !calendarId) return null;
  return {
    token,
    locationId,
    lessonCalendarId: calendarId,
    timezone: env.GHL_TIMEZONE || "America/Los_Angeles",
    invoiceSenderUserId: env.GHL_INVOICE_SENDER_USER_ID || null,
    safeMode,
  };
}
