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
