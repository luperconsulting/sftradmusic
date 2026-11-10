// Open booking times: the base availability from GoHighLevel's calendar rules (open hours, notice, buffers,
// existing appointments), minus anything busy in Google Calendar, minus anything that has started.
import type { BusyInterval } from "../integrations/googleCalendar.js";

export const BOOKING_TIMEZONE = "America/Los_Angeles";

/** The calendar date of an instant in the booking time zone, as YYYY-MM-DD. */
export function bookingDate(ms: number, timeZone = BOOKING_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** Midnight at the start of a YYYY-MM-DD date in the booking time zone, as epoch ms (handles DST). */
export function startOfBookingDate(date: string, timeZone = BOOKING_TIMEZONE) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const offset = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute")) - guess;
  return guess - offset;
}

export function openTimes(input: {
  base: Record<string, string[]>;
  busy: BusyInterval[];
  durationMinutes: number;
  now: number;
  timeZone?: string;
}): Record<string, string[]> {
  const length = input.durationMinutes * 60_000;
  const days: Record<string, string[]> = {};
  const seen = new Set<number>();
  for (const slots of Object.values(input.base)) {
    for (const iso of slots) {
      const start = Date.parse(iso);
      if (!Number.isFinite(start) || seen.has(start)) continue;
      seen.add(start);
      if (start <= input.now) continue;
      const end = start + length;
      // Any overlap blocks the time, including a busy block that starts before the slot and runs into it.
      if (input.busy.some((b) => b.start < end && start < b.end)) continue;
      // Grouped by the date the slot falls on in Los Angeles, not by whatever key the base used.
      (days[bookingDate(start, input.timeZone)] ??= []).push(new Date(start).toISOString());
    }
  }
  for (const list of Object.values(days)) list.sort();
  return days;
}
