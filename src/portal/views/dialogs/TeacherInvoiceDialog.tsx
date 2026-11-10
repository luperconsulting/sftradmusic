import type { VM } from "../../vm/types";

const label = { display: "flex", flexDirection: "column", gap: "6px" } as const;
const cap = { fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.6)" } as const;
const input = { width: "100%", boxSizing: "border-box", padding: "11px 14px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", fontSize: "14px" } as const;
const primary = { background: "#1D2A44", color: "#fff", border: "0", borderRadius: "2px", padding: "14px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "12px", letterSpacing: ".2em", textTransform: "uppercase", fontWeight: "600", cursor: "pointer" } as const;

/** Teacher creates an invoice for one student. Saved in Supabase only; nothing is emailed or charged. */
export default function TeacherInvoiceDialog({ v }: { v: VM }) {
  const t = v.ti;
  return (
    <>
      <label style={label}><span style={cap}>Item</span><input className="dc-f6" value={t.form.label ?? ""} onChange={t.set("label")} placeholder="Lesson" style={input} /></label>
      <label style={label}><span style={cap}>Amount (USD)</span><input className="dc-f6" type="number" min={1} step="0.01" value={t.form.amount ?? ""} onChange={t.set("amount")} style={input} /></label>
      <label style={label}><span style={cap}>Due date</span><input className="dc-f6" type="date" value={t.form.dueDate ?? ""} onChange={t.set("dueDate")} style={input} /></label>
      {t.error && <div role="alert" style={{ fontSize: "13px", color: "#9C5F22" }}>{t.error}</div>}
      <button className="dc-h3" disabled={t.saving} onClick={t.save} style={{ ...primary, opacity: t.saving ? ".7" : "1" }}>{t.saving ? "Saving…" : "Create invoice"}</button>
      <div style={{ fontSize: "11px", color: "rgba(17,22,27,.5)" }}>{t.payerLine}</div>
    </>
  );
}
