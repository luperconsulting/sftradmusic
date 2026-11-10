import type { VM } from "../../vm/types";

const label = { display: "flex", flexDirection: "column", gap: "6px" } as const;
const cap = { fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.6)" } as const;
const input = { width: "100%", boxSizing: "border-box", padding: "11px 14px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", fontSize: "14px" } as const;
const primary = { background: "#1D2A44", color: "#fff", border: "0", borderRadius: "2px", padding: "14px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "12px", letterSpacing: ".2em", textTransform: "uppercase", fontWeight: "600", cursor: "pointer" } as const;

/** Teacher adds or moves a lesson. Saved in Supabase only; nobody is notified. */
export default function TeacherLessonDialog({ v }: { v: VM }) {
  const l = v.tl;
  return (
    <>
      <label style={label}><span style={cap}>Date</span><input className="dc-f6" type="date" value={l.form.date ?? ""} onChange={l.set("date")} style={input} /></label>
      <label style={label}><span style={cap}>Start time</span><input className="dc-f6" type="time" step={900} value={l.form.time ?? ""} onChange={l.set("time")} style={input} /></label>
      <label style={label}><span style={cap}>Length (minutes)</span><input className="dc-f6" type="number" min={15} max={240} step={15} value={l.form.minutes ?? "60"} onChange={l.set("minutes")} style={input} /></label>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <span style={cap}>Location</span>
        <div style={{ display: "inline-flex", border: "1px solid rgba(17,22,27,.12)", borderRadius: "2px", padding: "3px", gap: "3px", alignSelf: "flex-start" }}>
          {l.locations.map((o: any) => (<button key={o.id} type="button" onClick={o.pick} aria-pressed={o.on} style={{ border: "0", borderRadius: "2px", padding: "7px 14px", fontSize: "12px", fontWeight: "600", cursor: "pointer", background: o.on ? "#1D2A44" : "transparent", color: o.on ? "#fff" : "rgba(17,22,27,.7)" }}>{o.label}</button>))}
        </div>
      </div>
      {l.error && <div role="alert" style={{ fontSize: "13px", color: "#9C5F22" }}>{l.error}</div>}
      <button className="dc-h3" disabled={l.saving} onClick={l.save} style={{ ...primary, opacity: l.saving ? ".7" : "1" }}>{l.saving ? "Saving…" : l.saveLabel}</button>
      <div style={{ fontSize: "11px", color: "rgba(17,22,27,.5)" }}>Times are in {v.TZ}. Saved in the portal only; no email or text is sent.</div>
    </>
  );
}
