import { Fragment } from "react";
import type { VM } from "../../vm/types";

const h3 = { fontFamily: "'Cinzel',Georgia,serif", fontWeight: "500", fontSize: "14px", letterSpacing: ".14em", textTransform: "uppercase", color: "#1D2A44", margin: "0" } as const;
const muted = { fontSize: "13px", color: "rgba(17,22,27,.55)" } as const;
const btn = { background: "none", border: "1px solid rgba(17,22,27,.12)", borderRadius: "2px", padding: "6px 10px", fontSize: "11px", letterSpacing: ".08em", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap" } as const;
const pill = (color: string) => ({ fontSize: "11px", letterSpacing: ".12em", textTransform: "uppercase", fontWeight: "600", color, whiteSpace: "nowrap" }) as const;

/** Payments families say they sent by Zelle. The invoice stays unpaid until the teacher confirms. */
export default function ReportedPaymentsSection({ v }: { v: VM }) {
  const r = v.rp;
  if (!r) return null;
  return (
    <section style={{ background: "#fff", border: "1px solid rgba(17,22,27,.1)", borderRadius: "2px", padding: "20px", marginBottom: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <h3 style={h3}>Reported payments{r.count > 0 ? ` (${r.count})` : ""}</h3>
        <button type="button" className="dc-h1" onClick={r.toggleAll} aria-pressed={r.all} style={{ ...btn, color: "#1D2A44" }}>{r.all ? "Show pending only" : "Show history"}</button>
      </div>
      {r.loading && <div style={muted}>Loading…</div>}
      {r.error && <div role="alert" style={{ ...muted, color: "#9C5F22" }}>{r.error}</div>}
      {r.empty && <div style={muted}>{r.all ? "No reported payments yet." : "Nothing to confirm. When a family taps \"I've sent it\", it shows here."}</div>}
      {r.rows.map((x: any) => (
        <Fragment key={x.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap", borderTop: "1px solid rgba(17,22,27,.06)", paddingTop: "12px", fontSize: "14px" }}>
            <div style={{ minWidth: 0, flex: "1 1 260px", display: "flex", flexDirection: "column", gap: "3px" }}>
              <div><span style={{ fontWeight: 500, color: "#1D2A44" }}>{x.student}</span> <span style={{ color: "rgba(17,22,27,.55)" }}>· Invoice {x.invoice} · memo {x.memo}</span></div>
              <div style={{ fontSize: "13px", color: x.mismatch ? "#9C5F22" : "rgba(17,22,27,.7)", fontWeight: x.mismatch ? 600 : 400 }}>{x.method} · {x.amounts}</div>
              {x.note && <div style={{ fontSize: "13px", color: "rgba(17,22,27,.65)" }}>“{x.note}”</div>}
              <div style={{ fontSize: "11px", color: "rgba(17,22,27,.5)" }}>{x.when}</div>
            </div>
            {x.pending ? (
              <div style={{ display: "inline-flex", gap: "6px", flexWrap: "wrap" }}>
                <button type="button" className="dc-h2" onClick={x.confirm} style={{ ...btn, color: "#4A6149" }}>Confirm</button>
                <button type="button" className="dc-h2" onClick={x.notReceived} style={{ ...btn, color: "#9C5F22" }}>Not received</button>
              </div>
            ) : (
              <span style={pill(x.color)}>{x.status}</span>
            )}
          </div>
        </Fragment>
      ))}
    </section>
  );
}
