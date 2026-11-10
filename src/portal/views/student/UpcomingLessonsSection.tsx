import type { VM } from "../../vm/types";

const h3 = { fontFamily: "'Cinzel',Georgia,serif", fontWeight: "500", fontSize: "14px", letterSpacing: ".14em", textTransform: "uppercase", color: "#1D2A44", margin: "0" } as const;
const ghost = { background: "transparent", border: "1px solid rgba(17,22,27,.15)", color: "#1D2A44", borderRadius: "2px", padding: "8px 12px", fontSize: "11px", letterSpacing: ".1em", fontWeight: "600", cursor: "pointer", whiteSpace: "nowrap" } as const;

/** Every upcoming lesson as a card: date, time, location, status, and a pay link while it's held for payment. */
export default function UpcomingLessonsSection({ v }: { v: VM }) {
  const rows = v.sched ?? [];
  return (
    <section id="portal-upcoming" style={{ gridColumn: "1/-1", minWidth: "0", background: "#fff", border: "1px solid rgba(17,22,27,.1)", borderRadius: "2px", padding: "24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "14px" }}>
        <h3 style={h3}>Upcoming lessons</h3>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {v.canBookNow && <button className="dc-h1" onClick={v.openBook} style={ghost}>Book a lesson</button>}
          {v.pkgLive && !v.readOnly && <button className="dc-h1" onClick={v.openPackages} style={ghost}>Buy 4-lesson package</button>}
        </div>
      </div>
      {rows.length === 0 && <div style={{ fontSize: "14px", color: "rgba(17,22,27,.55)" }}>No lessons booked yet.</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: "12px" }}>
        {rows.map((l: any) => (
          <div key={l.id} style={{ border: `1px solid ${l.held ? "rgba(194,125,56,.45)" : "rgba(17,22,27,.1)"}`, borderStyle: l.held ? "dashed" : "solid", borderRadius: "2px", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ fontWeight: "600", color: "#1D2A44" }}>{l.fullDate}</div>
            <div style={{ fontSize: "13px", color: "rgba(17,22,27,.7)" }}>{l.time}</div>
            <div style={{ fontSize: "13px", color: "rgba(17,22,27,.7)", display: "flex", alignItems: "center", gap: "6px" }}><i className={l.icon}></i>{l.loc}{l.locSub ? ` · ${l.locSub}` : ""}</div>
            <span style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: "600", color: l.badgeColor, background: l.badgeBg, borderRadius: "2px", padding: "4px 8px", lineHeight: "1.4" }}>
              <i className={l.badgeIcon}></i>{l.badge}
            </span>
            {l.held && !v.readOnly && (
              <button className="dc-h4" onClick={l.pay} style={{ alignSelf: "flex-start", background: "none", border: "0", padding: "0", color: "#9C5F22", fontSize: "12px", fontWeight: "600", cursor: "pointer", textDecoration: "underline" }}>Pay this lesson's invoice</button>
            )}
            {l.canAct && (
              <div style={{ display: "flex", gap: "12px", marginTop: "2px" }}>
                <button className="dc-h4" onClick={l.move} disabled={l.moveLocked} style={{ background: "none", border: "0", padding: "0", color: l.moveLocked ? "rgba(17,22,27,.35)" : "#1D2A44", fontSize: "12px", cursor: l.moveLocked ? "default" : "pointer" }}>Reschedule</button>
                <button className="dc-h4" onClick={l.cancel} style={{ background: "none", border: "0", padding: "0", color: "#9C5F22", fontSize: "12px", cursor: "pointer" }}>Cancel</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
