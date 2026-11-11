import { useState } from "react";
import type { VM } from "../../vm/types";

const cap = { fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.6)" } as const;
const muted = { fontSize: "13px", color: "rgba(17,22,27,.6)", lineHeight: 1.55 } as const;
const input = { width: "100%", boxSizing: "border-box", padding: "10px 12px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", fontSize: "14px", background: "#fff" } as const;
const copyBtn = { background: "none", border: "1px solid rgba(17,22,27,.12)", borderRadius: "2px", padding: "5px 10px", fontSize: "11px", letterSpacing: ".08em", fontWeight: "600", cursor: "pointer", color: "#1D2A44", display: "inline-flex", alignItems: "center", gap: "5px", whiteSpace: "nowrap" } as const;
const primary = { background: "#4A6149", color: "#fff", border: "0", borderRadius: "2px", padding: "13px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "11px", letterSpacing: ".2em", textTransform: "uppercase", fontWeight: "600", cursor: "pointer" } as const;

function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "88px 1fr auto", alignItems: "center", gap: "10px", fontSize: "14px" }}>
      <span style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>{label}</span>
      <span style={{ color: "#11161B", fontWeight: 600, overflowWrap: "anywhere" }}>{value}</span>
      <button type="button" className="dc-h2" onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`} style={copyBtn}><i className="ph ph-copy"></i> Copy</button>
    </div>
  );
}

/** Zelle is sent outside the portal. The payer reports it here; the invoice stays unpaid until the teacher confirms. */
export default function ZellePanel({ v }: { v: VM }) {
  const z = v.zp;
  const [showForCash, setShowForCash] = useState(false);
  if (!z?.show) return null;
  if (z.cash && !showForCash && !z.reported) {
    return (
      <button type="button" className="dc-h4" onClick={() => setShowForCash(true)} style={{ background: "none", border: "0", padding: "0", color: "#9C5F22", fontSize: "12px", cursor: "pointer", alignSelf: "flex-start" }}>Pay with Zelle instead</button>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", border: "1px solid rgba(17,22,27,.12)", borderRadius: "2px", padding: "14px 16px" }}>
      <span style={{ ...cap, display: "flex", alignItems: "center", gap: "8px" }}><i className="ph ph-paper-plane-tilt" style={{ fontSize: "16px", color: "#9C5F22" }}></i> Pay with Zelle</span>
      {z.loading && <span style={muted}>Loading…</span>}
      {z.error && <span style={muted}>{z.error}</span>}
      {z.unavailable && <span style={{ ...muted, color: "rgba(17,22,27,.75)" }}>{z.message}</span>}
      {z.available && (<>
        <div style={{ display: "flex", gap: "14px", alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px", display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 }}>
            <CopyRow label="Send to" value={z.recipient} onCopy={z.copyRecipient} />
            <CopyRow label="Amount" value={z.amount} onCopy={z.copyAmount} />
            <CopyRow label="Memo" value={z.memo} onCopy={z.copyMemo} />
          </div>
          {z.qr && <img src={z.qr} alt="Zelle QR code" style={{ width: "120px", height: "120px", objectFit: "contain", border: "1px solid rgba(17,22,27,.08)", borderRadius: "2px", background: "#fff" }} />}
        </div>
        <span style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>Send the exact amount and put the memo in the Zelle note.</span>
      </>)}
      {z.reported && (
        <div role="status" style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "13px", color: "#1D2A44", background: "rgba(74,97,73,.08)", border: "1px solid rgba(74,97,73,.2)", borderRadius: "2px", padding: "10px 12px", lineHeight: 1.5 }}>
          <i className="ph-fill ph-clock" style={{ color: "#4A6149", fontSize: "16px", marginTop: "1px" }}></i><span>{z.reportedLine}</span>
        </div>
      )}
      {z.canReport && !z.form.open && (
        <button type="button" className="dc-h1" onClick={z.toggle} style={{ alignSelf: "flex-start", background: "transparent", border: "1px solid rgba(17,22,27,.15)", color: "#1D2A44", borderRadius: "2px", padding: "10px 16px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "11px", letterSpacing: ".2em", textTransform: "uppercase", fontWeight: "600", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "8px" }}><i className="ph ph-check"></i> I've sent it</button>
      )}
      {z.canReport && z.form.open && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", borderTop: "1px solid rgba(17,22,27,.06)", paddingTop: "12px" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={cap}>Amount sent (optional)</span><input className="dc-f6" inputMode="decimal" value={z.form.amount} onChange={z.setAmount} placeholder={z.amount} style={input} /></label>
          <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={cap}>Note (optional)</span><textarea className="dc-f6" value={z.form.note} onChange={z.setNote} maxLength={500} rows={2} placeholder="Anything Zane should know" style={{ ...input, resize: "vertical", fontFamily: "inherit" }} /></label>
          {z.form.error && <div role="alert" style={{ fontSize: "13px", color: "#9C5F22" }}>{z.form.error}</div>}
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <button type="button" className="dc-h3" disabled={z.form.busy} onClick={z.submit} style={{ ...primary, flex: 1, opacity: z.form.busy ? ".7" : "1" }}>{z.form.busy ? "Sending…" : "Report payment"}</button>
            <button type="button" className="dc-h4" onClick={z.toggle} style={{ background: "none", border: "0", padding: "0 6px", color: "#9C5F22", fontSize: "12px", cursor: "pointer" }}>Cancel</button>
          </div>
          <span style={{ fontSize: "11px", color: "rgba(17,22,27,.5)" }}>This tells Zane to check for it. The invoice stays open until he confirms.</span>
        </div>
      )}
    </div>
  );
}
