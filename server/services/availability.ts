// Open booking times: the studio's weekly intro-call hours (BOOKING_HOURS), minus anything busy in Google
// Calendar, minus anything inside the minimum notice or past the booking horizon.
import type { BusyInterval } from "../integrations/googleCalendar.js";

export const BOOKING_TIMEZONE = "America/Los_Angeles";

/** The calendar date of an instant in the booking time zone, as YYYY-MM-DD. */
export function bookingDate(ms: number, timeZone = BOOKING_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** An instant for a wall-clock time on a YYYY-MM-DD date in the booking time zone (handles DST). */
export function zonedTime(date: string, minuteOfDay: number, timeZone = BOOKING_TIMEZONE) {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  const offsetAt = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute")) - Math.floor(ms / 60000) * 60000;
  };
  // Two passes: the offset at the first guess can differ from the offset at the answer on a DST change day.
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
}

export const startOfBookingDate = (date: string, timeZone = BOOKING_TIMEZONE) => zonedTime(date, 0, timeZone);

/** Weekday (0 = Sunday) to open ranges in minutes after midnight. */
export type WeeklyHours = Record<number, [number, number][]>;

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Parses hours like "mon-fri 10:00-18:00; sat 10:00-14:00" or "tue,thu 09:30-12:00,13:00-17:00".
 * Throws on anything it can't read, so a typo can't silently open or close the calendar.
 */
export function parseWeeklyHours(spec: string): WeeklyHours {
  const hours: WeeklyHours = {};
  const minute = (t: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new Error(`booking hours: bad time "${t}"`);
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const day = (name: string) => {
    const i = DAY_NAMES.indexOf(name.trim().slice(0, 3).toLowerCase());
    if (i < 0) throw new Error(`booking hours: bad day "${name}"`);
    return i;
  };
  for (const part of spec.split(";").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\S+)\s+(.+)$/.exec(part);
    if (!m) throw new Error(`booking hours: can't read "${part}"`);
    const days = new Set<number>();
    for (const group of m[1].split(",")) {
      const [a, b] = group.split("-");
      if (b === undefined) days.add(day(a));
      else for (let i = day(a), end = day(b); ; i = (i + 1) % 7) { days.add(i); if (i === end) break; }
    }
    const ranges = m[2].split(",").map((r) => {
      const [a, b] = r.split("-");
      if (b === undefined) throw new Error(`booking hours: bad range "${r}"`);
      const range: [number, number] = [minute(a), minute(b)];
      if (!(range[1] > range[0])) throw new Error(`booking hours: range ends before it starts "${r}"`);
      return range;
    });
    for (const d of days) (hours[d] ??= []).push(...ranges);
  }
  return hours;
}

/** Every slot start in the weekly hours between two dates (inclusive), as base times for openTimes. */
export function weeklySlots(input: { from: string; to: string; hours: WeeklyHours; slotMinutes: number; timeZone?: string }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const [fy, fm, fd] = input.from.split("-").map(Number);
  const [ty, tm, td] = input.to.split("-").map(Number);
  for (let t = Date.UTC(fy, fm - 1, fd); t <= Date.UTC(ty, tm - 1, td); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    for (const [start, end] of input.hours[new Date(t).getUTCDay()] ?? []) {
      for (let m = start; m + input.slotMinutes <= end; m += input.slotMinutes) {
        (out[date] ??= []).push(new Date(zonedTime(date, m, input.timeZone)).toISOString());
      }
    }
  }
  return out;
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
