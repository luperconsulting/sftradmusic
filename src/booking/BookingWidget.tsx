import { useEffect, useMemo, useState, type CSSProperties } from "react";
import "./booking-widget.css";

// The approved booking widget, fed by /api/booking/availability: GoHighLevel's intro-call rules minus Google
// Calendar busy times. This phase only shows open times. Nothing is booked, saved or sent.
const HOST_TZ = "America/Los_Angeles";
const TIMEZONES: [string, string][] = [
  ["America/Los_Angeles", "Pacific (PT)"], ["America/Denver", "Mountain (MT)"], ["America/Chicago", "Central (CT)"], ["America/New_York", "Eastern (ET)"],
  ["Europe/London", "London (GMT)"], ["Europe/Dublin", "Dublin (GMT)"], ["Australia/Sydney", "Sydney (AEDT)"],
];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

type Availability = { status: "loading" } | { status: "ready"; days: Record<string, string[]>; slotMinutes: number } | { status: "error"; message: string };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const todayInHost = () => new Intl.DateTimeFormat("en-CA", { timeZone: HOST_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
// Noon UTC keeps the calendar date the same in every time zone used for labels.
const dateAtNoon = (date: string) => new Date(`${date}T12:00:00Z`);
const longDate = (date: string | null) => (date ? new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(dateAtNoon(date)) : "");
const browserZone = () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return TIMEZONES.some(([z]) => z === tz) ? tz : HOST_TZ;
};

export default function BookingWidget() {
  const today = todayInHost();
  const [ty, tm] = today.split("-").map(Number);
  const [view, setView] = useState({ y: ty, m: tm - 1 });
  const [tz, setTz] = useState(browserZone);
  const [selDate, setSelDate] = useState<string | null>(null);
  const [selSlot, setSelSlot] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState({ name: "", email: "", phone: "", level: "new", notes: "" });
  const [errors, setErrors] = useState<{ name?: boolean; email?: boolean }>({});
  const [touched, setTouched] = useState(false);
  const [notice, setNotice] = useState("");
  const [avail, setAvail] = useState<Availability>({ status: "loading" });
  const [reload, setReload] = useState(0);

  const dim = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
  useEffect(() => {
    const first = ymd(view.y, view.m, 1);
    const from = first < today ? today : first;
    const to = ymd(view.y, view.m, dim);
    if (from > to) return setAvail({ status: "ready", days: {}, slotMinutes: 15 });
    const ctrl = new AbortController();
    setAvail({ status: "loading" });
    fetch(`/api/booking/availability?from=${from}&to=${to}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.days) throw new Error(body?.error?.message ?? "Open times can't be checked right now. Please try again shortly.");
        setAvail({ status: "ready", days: body.days, slotMinutes: body.slotMinutes ?? 15 });
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        // Never fall back to made-up times: show the error and nothing to pick.
        setAvail({ status: "error", message: e instanceof Error ? e.message : "Open times can't be checked right now. Please try again shortly." });
      });
    return () => ctrl.abort();
  }, [view.y, view.m, dim, today, reload]);

  const days: Record<string, string[]> = avail.status === "ready" ? avail.days : {};
  const slotsFor = (date: string) => (days[date] ?? []).filter((iso) => Date.parse(iso) > Date.now());
  const minutes = avail.status === "ready" ? avail.slotMinutes : 15;
  const fmtTime = (iso: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
  const tzShort = useMemo(() => new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? tz, [tz]);
  const validate = (f: typeof form) => {
    const e: { name?: boolean; email?: boolean } = {};
    if (!f.name.trim()) e.name = true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) e.email = true;
    return e;
  };
  const setField = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    const next = { ...form, [k]: e.target.value };
    setForm(next);
    if (touched) setErrors(validate(next));
  };
  const submit = (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    const found = validate(form);
    setErrors(found);
    setTouched(true);
    if (Object.keys(found).length) return;
    // Booking is the next phase. Saying "booked" here would be untrue, so nothing is sent.
    setNotice("Online booking isn't switched on yet, so this call hasn't been booked and nothing was sent.");
  };

  const lead = new Date(Date.UTC(view.y, view.m, 1)).getUTCDay();
  const minView = view.y * 12 + view.m <= ty * 12 + (tm - 1);
  const slots = selDate ? slotsFor(selDate) : [];
  const stepStyle = (n: number): CSSProperties => ({
    display: "flex", alignItems: "center", gap: 8, padding: "5px 12px 5px 6px", borderRadius: 999,
    border: `1px solid ${n === step ? "var(--color-accent)" : "transparent"}`,
    background: n === step ? "color-mix(in srgb, var(--color-accent) 8%, transparent)" : n < step ? "var(--color-neutral-200)" : "transparent",
    color: n === step ? "var(--color-accent-700)" : n < step ? "var(--color-text)" : "var(--color-neutral-500)",
  });
  const errStyle = (bad?: boolean): CSSProperties => (bad ? { borderColor: "var(--color-accent-700)" } : {});

  return (
    <div className="bw-root" style={{ width: "100%", display: "grid", placeItems: "start center" }}>
      <div data-screen-label="Booking widget" style={{ width: "100%", maxWidth: 820, background: "var(--color-bg)", border: "1px solid var(--color-divider)", borderRadius: 20, boxShadow: "var(--shadow-lg)", overflow: "hidden" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: "var(--space-3)", padding: "var(--space-6) var(--space-6) var(--space-4)", borderBottom: "1px solid var(--color-divider)", background: "linear-gradient(180deg, var(--color-neutral-100), var(--color-bg))" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-accent-700)", marginBottom: "var(--space-1)" }}>Zane Luper · Fiddle Lessons</div>
            <h2 style={{ fontSize: 32, fontWeight: 400 }}>Free {minutes}-minute intro call</h2>
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            <span className="tag tag-outline"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>{minutes} min</span>
            <span className="tag tag-neutral"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" /><rect x="2" y="6" width="14" height="12" rx="2" /></svg>Video or phone</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: "var(--space-4)", padding: "var(--space-3) var(--space-6)", borderBottom: "1px solid var(--color-divider)", fontSize: 12, flexWrap: "wrap" }}>
          {[["1", "Pick a time"], ["2", "Your details"], ["3", "Confirmed"]].map(([n, label]) => (
            <div key={n} style={stepStyle(Number(n))}><span style={{ width: 20, height: 20, borderRadius: "50%", border: "1px solid currentColor", display: "grid", placeItems: "center", fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{n}</span><span>{label}</span></div>
          ))}
        </div>

        {step === 1 && (
          <>
            <div className="bw-pick" data-screen-label="Pick a time">
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-3)" }}>
                  <h3 style={{ fontSize: 22 }}>{new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(view.y, view.m, 15)))}</h3>
                  <div style={{ display: "flex", gap: "var(--space-1)" }}>
                    <button className="btn btn-icon btn-secondary" aria-label="Previous month" disabled={minView} onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }))}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg></button>
                    <button className="btn btn-icon btn-secondary" aria-label="Next month" onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }))}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg></button>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4, textAlign: "center" }}>
                  {WEEKDAYS.map((w) => <div key={w} style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-neutral-600)", padding: "6px 0" }}>{w}</div>)}
                  {Array.from({ length: lead }, (_, i) => <span key={`lead${i}`} />)}
                  {Array.from({ length: dim }, (_, i) => {
                    const date = ymd(view.y, view.m, i + 1);
                    const open = date >= today && slotsFor(date).length > 0;
                    const sel = selDate === date;
                    const style: CSSProperties = { aspectRatio: "1", width: "100%", minHeight: 40, borderRadius: "50%", border: "1px solid transparent", background: open ? "var(--color-neutral-100)" : "transparent", font: "inherit", fontSize: 14, fontVariantNumeric: "tabular-nums", cursor: open ? "pointer" : "default", color: open ? "var(--color-text)" : "var(--color-neutral-400)", display: "grid", placeItems: "center", padding: 0 };
                    if (date === today) Object.assign(style, { textDecoration: "underline", textUnderlineOffset: "4px", textDecorationColor: "var(--color-accent)" });
                    if (sel) Object.assign(style, { borderColor: "var(--color-accent)", color: "var(--color-accent-700)", boxShadow: "0 0 0 4px color-mix(in srgb, var(--color-accent) 14%, transparent)", background: "color-mix(in srgb, var(--color-accent) 10%, transparent)" });
                    return <button key={date} className="bw-day" data-avail={open ? "1" : "0"} disabled={!open} aria-label={longDate(date)} style={style} onClick={() => { setSelDate(date); setSelSlot(null); }}>{i + 1}</button>;
                  })}
                </div>
                <p className="text-muted" style={{ fontSize: 12, marginTop: "var(--space-4)" }}>Pick a day to see open times.</p>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", minWidth: 0 }}>
                <div>
                  <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-neutral-600)", marginBottom: 4 }}>Open times</div>
                  <h4 style={{ fontSize: 20, fontWeight: 400 }}>{selDate ? longDate(selDate) : "Choose a day"}</h4>
                </div>
                <div className="field">
                  <label htmlFor="bw-tz">Time zone</label>
                  <select id="bw-tz" className="input" value={tz} onChange={(e) => setTz(e.target.value)} style={{ fontSize: 13 }}>
                    {TIMEZONES.map(([z, label]) => <option key={z} value={z}>{label}</option>)}
                  </select>
                </div>
                {avail.status === "loading" && <p role="status" className="text-muted" style={{ fontSize: 13 }}>Checking open times…</p>}
                {avail.status === "error" && (
                  <div role="alert" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>
                    <p>{avail.message}</p>
                    <button className="btn btn-secondary" style={{ marginTop: "var(--space-2)" }} onClick={() => setReload((n) => n + 1)}>Try again</button>
                  </div>
                )}
                {avail.status === "ready" && selDate && slots.length > 0 && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: "var(--space-2)", maxHeight: 300, overflowY: "auto", paddingRight: 2 }}>
                    {slots.map((iso) => {
                      const sel = selSlot === iso;
                      return <button key={iso} className="bw-time" onClick={() => setSelSlot(iso)} style={{ font: "inherit", fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14, fontVariantNumeric: "tabular-nums", padding: "10px 6px", borderRadius: 999, cursor: "pointer", background: sel ? "color-mix(in srgb, var(--color-accent) 10%, transparent)" : "transparent", border: `1px solid ${sel ? "var(--color-accent)" : "var(--color-divider)"}`, color: sel ? "var(--color-accent-700)" : "var(--color-text)", boxShadow: sel ? "inset 0 0 0 1px var(--color-accent)" : "none" }}>{fmtTime(iso)}</button>;
                    })}
                  </div>
                )}
                {avail.status === "ready" && selDate && slots.length === 0 && <p className="text-muted" style={{ fontSize: 13 }}>Nothing open that day — try another date.</p>}
                {avail.status === "ready" && !Object.values(days).some((l) => l.length) && <p className="text-muted" style={{ fontSize: 13 }}>No open times this month. Try the next month.</p>}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-4) var(--space-6)", borderTop: "1px solid var(--color-divider)", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>{selSlot ? `${longDate(selDate)} · ${fmtTime(selSlot)} ${tzShort}` : selDate ? "Now pick a time." : "Pick a day and time to continue."}</span>
              <button className="btn btn-primary" disabled={!selSlot} onClick={() => setStep(2)}>Continue</button>
            </div>
          </>
        )}

        {step === 2 && selSlot && (
          <>
            <div className="bw-details" data-screen-label="Your details">
              <div className="card" style={{ alignSelf: "start" }}>
                <div className="card-kicker">Your call</div>
                <div className="card-title">{longDate(selDate)}</div>
                <p className="card-body">{fmtTime(selSlot)}<br />{minutes} minutes · {tzShort}</p>
                <div className="card-meta"><a href="#" onClick={(e) => { e.preventDefault(); setNotice(""); setStep(1); }}>Change time</a></div>
              </div>
              <form onSubmit={submit} noValidate style={{ display: "grid", gap: "var(--space-4)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--space-3)" }}>
                  <div className="field">
                    <label htmlFor="bw-name">Name</label>
                    <input id="bw-name" className="input" type="text" placeholder="Your full name" autoComplete="name" value={form.name} onChange={setField("name")} style={errStyle(errors.name)} />
                    {errors.name && <div style={{ fontSize: 11, color: "var(--color-accent-700)", marginTop: 4 }}>Please tell me your name.</div>}
                  </div>
                  <div className="field">
                    <label htmlFor="bw-email">Email</label>
                    <input id="bw-email" className="input" type="email" placeholder="you@example.com" autoComplete="email" value={form.email} onChange={setField("email")} style={errStyle(errors.email)} />
                    {errors.email && <div style={{ fontSize: 11, color: "var(--color-accent-700)", marginTop: 4 }}>A valid email is needed for the confirmation.</div>}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="bw-phone">Phone <span className="text-muted">(optional — for a phone call instead of video)</span></label>
                  <input id="bw-phone" className="input" type="tel" placeholder="(415) 555-0100" autoComplete="tel" value={form.phone} onChange={setField("phone")} />
                </div>
                <div className="field">
                  <label>Where are you with the fiddle?</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4) var(--space-6)", paddingTop: 4 }}>
                    {[["new", "Brand new"], ["some", "Some playing"], ["exp", "Experienced"]].map(([v, label]) => (
                      <label key={v} className="radio"><input type="radio" name="level" checked={form.level === v} onChange={() => setForm((f) => ({ ...f, level: v }))} /><span className="dot" />{label}</label>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="bw-notes">Anything you'd like to talk through?</label>
                  <textarea id="bw-notes" className="input" placeholder="Tunes or traditions you're drawn to, goals, questions about lessons…" value={form.notes} onChange={setField("notes")} />
                </div>
                {notice && <p role="status" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{notice}</p>}
              </form>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-4) var(--space-6)", borderTop: "1px solid var(--color-divider)", flexWrap: "wrap" }}>
              <button className="btn btn-secondary" onClick={() => { setNotice(""); setStep(1); }}>Back</button>
              <button className="btn btn-primary" onClick={() => submit()}>Confirm call</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
