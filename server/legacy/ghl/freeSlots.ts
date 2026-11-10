// LEGACY. Read-only GoHighLevel free slots from the old booking page. Kept for migration only; nothing imports it.
// GoHighLevel API v2, read-only: open slots for a calendar. Path and fields follow GoHighLevel's published
// OpenAPI file (github.com/GoHighLevel/highlevel-api-docs: apps/calendars.json).
import { ApiError } from "../../http.js";

const BASE = "https://services.leadconnectorhq.com";
const CALENDAR_VERSION = "2021-04-15";

export interface GhlConfig {
  token: string;
  locationId: string;
  timezone: string;
}

export interface GhlClient {
  /** Open slots by date for a calendar. */
  getFreeSlots(fromMs: number, toMs: number, calendarId: string): Promise<Record<string, string[]>>;
}

export function createGhlClient(config: GhlConfig, fetchImpl: typeof fetch = fetch): GhlClient {
  return {
    async getFreeSlots(fromMs, toMs, calendarId) {
      const q = new URLSearchParams({ startDate: String(fromMs), endDate: String(toMs), timezone: config.timezone });
      const path = `/calendars/${encodeURIComponent(calendarId)}/free-slots?${q}`;
      let res: Response;
      try {
        res = await fetchImpl(BASE + path, {
          headers: { Authorization: `Bearer ${config.token}`, Version: CALENDAR_VERSION, Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        throw new ApiError(503, "ghl_unavailable", "We couldn't reach the scheduling system. Please try again shortly.");
      }
      if (!res.ok) {
        console.error(`[ghl] GET /calendars/:id/free-slots -> ${res.status}`);
        throw new ApiError(503, "ghl_unavailable", "We couldn't reach the scheduling system. Please try again shortly.");
      }
      const data = (await res.json()) as Record<string, any>;
      const days: Record<string, string[]> = {};
      for (const [day, value] of Object.entries<any>(data)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(value?.slots)) days[day] = value.slots;
      }
      return days;
    },
  };
}
