import { useCallback, useEffect, useRef, useState } from "react";

export const TZ = "America/Los_Angeles";

export function useViewport() {
  const read = () => {
    const w = window.innerWidth;
    return { width: w, mobile: w < 860, wide: w >= 1100 };
  };
  const [vp, setVp] = useState(read);
  useEffect(() => {
    const onResize = () => setVp(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return vp;
}

export function useToast() {
  const [toast, setToast] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(msg);
    timer.current = setTimeout(() => setToast(""), 4000);
  }, []);
  return { toast, flash };
}

export const fmt = (iso: string | null | undefined, opts: Intl.DateTimeFormatOptions) =>
  iso ? new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts }).format(new Date(iso)) : "—";
// Date-only values are calendar dates, so they're formatted without any timezone shift.
export const fmtDay = (day: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) =>
  day ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(`${day.slice(0, 10)}T12:00:00Z`)) : "—";
export const fullDate = (iso: string) => fmt(iso, { weekday: "long", month: "long", day: "numeric" });
export const clock = (iso: string) => fmt(iso, { hour: "numeric", minute: "2-digit" });
export const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const todayLabel = () => fmt(new Date().toISOString(), { weekday: "long", month: "long", day: "numeric" });
export function greeting() {
  const h = Number(fmt(new Date().toISOString(), { hour: "numeric", hour12: false }));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
export const copy = (text: string) => {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable: the toast still shows the value where it matters */
  }
};
export const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

/** A wall-clock date and time in the studio's time zone, as an ISO instant. */
export function wallTimeToIso(date: string, time: string, tz = TZ) {
  const guess = new Date(`${date}T${time}:00Z`).getTime();
  const fmtParts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const offset = (t: number) => {
    const parts = fmtParts.formatToParts(new Date(t));
    const g = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first)).toISOString();
}

/** Today's date (YYYY-MM-DD) in the studio's time zone. */
export const studioToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** The booking picker's month `offset` months from now, in studio time: the month start and the slot range to ask for. */
export function bookingMonthRange(offset: number, now = new Date()) {
  const today = studioToday(now);
  const [ty, tm] = today.split("-").map(Number);
  const base = new Date(Date.UTC(ty, tm - 1 + offset, 1));
  const y = base.getUTCFullYear(), m = base.getUTCMonth();
  const p = (n: number) => String(n).padStart(2, "0");
  const first = `${y}-${p(m + 1)}-01`;
  const last = `${y}-${p(m + 1)}-${p(new Date(Date.UTC(y, m + 1, 0)).getUTCDate())}`;
  return { base, from: first < today ? today : first, to: last };
}

/** Every open date in the month, padded to full rows of 8 (never cut off). */
export const dateGrid = <T,>(days: T[]): (T | null)[] => Array.from({ length: Math.max(16, Math.ceil(days.length / 8) * 8) }, (_, i) => days[i] ?? null);
