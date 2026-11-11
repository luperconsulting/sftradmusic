import type { VM } from "../../vm/types";

const label = { display: "flex", flexDirection: "column", gap: "6px" } as const;
const cap = { fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.6)" } as const;
const input = { width: "100%", boxSizing: "border-box", padding: "11px 14px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", fontSize: "14px" } as const;
const primary = { background: "#4A6149", color: "#fff", border: "0", borderRadius: "2px", padding: "14px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "12px", letterSpacing: ".2em", textTransform: "uppercase", fontWeight: "600", cursor: "pointer" } as const;

/** Teacher confirms a Zelle payment a family reported, after checking it arrived. Nothing is charged or emailed. */
export default function ConfirmReportDialog({ v }: { v: VM }) {
  const c = v.cr;
  return (
    <>
      {c.line && <div style={{ fontSize: "14px", color: "rgba(17,22,27,.7)" }}>{c.line}</div>}
      {c.note && <div style={{ fontSize: "13px", color: "rgba(17,22,27,.65)", borderLeft: "2px solid rgba(156,95,34,.4)", paddingLeft: "10px" }}>“{c.note}”</div>}
      <label style={label}><span style={cap}>Amount received ($)</span><input className="dc-f6" inputMode="decimal" value={c.form.amount ?? ""} onChange={c.set("amount")} style={input} /></label>
      <label style={label}><span style={cap}>Date received</span><input className="dc-f6" type="date" value={c.form.paidAt ?? ""} onChange={c.set("paidAt")} style={input} /></label>
      <label style={label}><span style={cap}>Reference (optional)</span><input className="dc-f6" value={c.form.reference ?? ""} onChange={c.set("reference")} placeholder="Zelle confirmation or note" style={input} /></label>
      {c.error && <div role="alert" style={{ fontSize: "13px", color: "#9C5F22" }}>{c.error}</div>}
      <button className="dc-h3" disabled={c.saving} onClick={c.save} style={{ ...primary, opacity: c.saving ? ".7" : "1" }}>{c.saving ? "Saving…" : "Confirm payment"}</button>
      <div style={{ fontSize: "11px", color: "rgba(17,22,27,.5)" }}>Only confirm once the money is in your account. A package adds its 4 credits; a held lesson is confirmed.</div>
    </>
  );
}
