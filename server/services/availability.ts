// Open times: the teacher's weekly lesson hours (Supabase), minus Google Calendar busy times (read-only,
// keyless), minus lessons already booked or held, minus anything that has started. If a source can't be read
// the caller gets an error, never unchecked times.
import type { BusyInterval } from "../integrations/googleCalendar.js";
import type { LessonHoursRow, LessonRecord } from "../store/types.js";

export const BOOKING_TIMEZONE = "America/Los_Angeles";
const DAY = 86400000;

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

/** A wall-clock minute on a date in the booking time zone, as epoch ms (handles DST). */
export function zonedMinute(date: string, minute: number, timeZone = BOOKING_TIMEZONE) {
  const guess = startOfBookingDate(date, timeZone) + minute * 60000;
  // Re-anchor in case a DST change happened between midnight and this minute.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric" }).formatToParts(new Date(guess));
  const local = (Number(parts.find((p) => p.type === "hour")?.value) % 24) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  return guess + (minute - local) * 60000;
}

const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Candidate starts inside the weekly hours for each date in [fromDate, toDate], every `stepMinutes`. */
export function candidateStarts(hours: LessonHoursRow[], fromDate: string, toDate: string, durationMinutes: number, stepMinutes: number, timeZone = BOOKING_TIMEZONE) {
  const out: number[] = [];
  for (let ms = startOfBookingDate(fromDate, timeZone) + 12 * 3600000; bookingDate(ms, timeZone) <= toDate && out.length < 5000; ms += DAY) {
    const date = bookingDate(ms, timeZone);
    for (const h of hours.filter((x) => x.weekday === weekdayOf(date))) {
      for (let m = h.startMinute; m + durationMinutes <= h.endMinute; m += stepMinutes) out.push(zonedMinute(date, m, timeZone));
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Lessons that occupy their slot: confirmed or held for payment. */
export const isLive = (l: Pick<LessonRecord, "status">) => l.status === "scheduled" || l.status === "pending_payment";

export function openSlots(input: {
  hours: LessonHoursRow[];
  fromDate: string;
  toDate: string;
  busy: BusyInterval[];
  lessons: Pick<LessonRecord, "startsAt" | "endsAt" | "status">[];
  durationMinutes: number;
  stepMinutes: number;
  now: number;
  timeZone?: string;
}): Record<string, string[]> {
  const length = input.durationMinutes * 60000;
  const taken = input.lessons.filter(isLive).map((l) => ({ start: Date.parse(l.startsAt), end: Date.parse(l.endsAt) }));
  const blocks = [...input.busy, ...taken];
  const days: Record<string, string[]> = {};
  for (const start of candidateStarts(input.hours, input.fromDate, input.toDate, input.durationMinutes, input.stepMinutes, input.timeZone)) {
    if (start <= input.now) continue;
    const end = start + length;
    // Any overlap blocks the time, including a block that starts before the slot and runs into it.
    if (blocks.some((b) => b.start < end && start < b.end)) continue;
    (days[bookingDate(start, input.timeZone)] ??= []).push(new Date(start).toISOString());
  }
  return days;
}

/** True when a lesson starting at `startMs` is a slot inside the weekly hours. */
export function fitsLessonHours(hours: LessonHoursRow[], startMs: number, durationMinutes: number, stepMinutes: number, timeZone = BOOKING_TIMEZONE) {
  const date = bookingDate(startMs, timeZone);
  return candidateStarts(hours, date, date, durationMinutes, stepMinutes, timeZone).includes(startMs);
}
