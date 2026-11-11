import type { VM } from "../../vm/types";

const label = { display: "flex", flexDirection: "column", gap: "6px" } as const;
const cap = { fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.6)" } as const;
const input = { width: "100%", boxSizing: "border-box", padding: "11px 14px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", fontSize: "14px" } as const;
const primary = { background: "#4A6149", color: "#fff", border: "0", borderRadius: "2px", padding: "14px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "12px", letterSpacing: ".2em", textTransform: "uppercase", fontWeight: "600", cursor: "pointer" } as const;

/** Teacher records a Zelle or cash payment already received. Nothing is charged or emailed. */
export default function MarkPaidDialog({ v }: { v: VM }) {
  const m = v.mp;
  return (
    <>
      {m.line && <div style={{ fontSize: "14px", color: "rgba(17,22,27,.7)" }}>{m.line}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <span style={cap}>Received by</span>
        <div style={{ display: "inline-flex", border: "1px solid rgba(17,22,27,.12)", borderRadius: "2px", padding: "3px", gap: "3px", alignSelf: "flex-start" }}>
          {m.methods.map((o: any) => (<button key={o.id} type="button" onClick={o.pick} aria-pressed={o.on} style={{ border: "0", borderRadius: "2px", padding: "7px 14px", fontSize: "12px", fontWeight: "600", cursor: "pointer", background: o.on ? "#1D2A44" : "transparent", color: o.on ? "#fff" : "rgba(17,22,27,.7)" }}>{o.label}</button>))}
        </div>
      </div>
      <label style={label}><span style={cap}>Date received</span><input className="dc-f6" type="date" value={m.form.paidAt ?? ""} onChange={m.set("paidAt")} style={input} /></label>
      <label style={label}><span style={cap}>Reference (optional)</span><input className="dc-f6" value={m.form.reference ?? ""} onChange={m.set("reference")} placeholder="Zelle confirmation or note" style={input} /></label>
      {m.error && <div role="alert" style={{ fontSize: "13px", color: "#9C5F22" }}>{m.error}</div>}
      <button className="dc-h3" disabled={m.saving} onClick={m.save} style={{ ...primary, opacity: m.saving ? ".7" : "1" }}>{m.saving ? "Saving…" : "Mark paid"}</button>
      <div style={{ fontSize: "11px", color: "rgba(17,22,27,.5)" }}>Records the full amount due. A package adds its 4 credits; a held lesson is confirmed.</div>
    </>
  );
}
