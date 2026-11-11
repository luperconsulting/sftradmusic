// Calendar dates in the studio's time zone. Invoice issue and due dates are plain dates (YYYY-MM-DD) that mean
// a day in Los Angeles, so "today", "due today" and "overdue by N days" are all counted there, never in UTC.
export const STUDIO_TZ = "America/Los_Angeles";

/** The Los Angeles calendar date of an instant, as YYYY-MM-DD. */
export function studioDate(ms: number = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: STUDIO_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** Whole calendar days from date `a` to date `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string) {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}

/** Days past the due date, counted in Los Angeles: 0 on the due date itself ("due today"), negative before it. */
export function daysOverdue(dueDate: string, nowMs: number = Date.now()) {
  return daysBetween(dueDate.slice(0, 10), studioDate(nowMs));
}

/** "Due today", "Due tomorrow", "Overdue · 1 day", ... for an unpaid invoice. */
export function dueLabel(dueDate: string, nowMs: number = Date.now()) {
  const d = daysOverdue(dueDate, nowMs);
  if (d > 0) return `Overdue · ${d} day${d === 1 ? "" : "s"}`;
  if (d === 0) return "Due today";
  if (d === -1) return "Due tomorrow";
  return "Awaiting payment";
}
