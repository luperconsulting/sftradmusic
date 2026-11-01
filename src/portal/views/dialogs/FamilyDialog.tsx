import { Fragment } from "react";
import type { VM } from "../../vm/types";

export default function FamilyDialog({ v }: { v: VM }) {
  return (
    <><div style={{ display: "flex", flexDirection: "column" }}>{(v.familyRows ?? []).map((m: any, i0: number) => (<Fragment key={i0}><div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 0", borderTop: "1px solid rgba(17,22,27,.06)", fontSize: "14px" }}><span style={{ width: "34px", height: "34px", borderRadius: "50%", background: "#1D2A44", color: "#E0A363", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Cinzel',Georgia,serif", fontSize: "12px", fontWeight: "600" }}>{m.initials}</span><div style={{ flex: "1" }}><div style={{ fontWeight: "500" }}>{m.name}</div><div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>{m.meta}</div></div><span style={{ fontSize: "10px", letterSpacing: ".12em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.5)" }}>{m.role}</span></div></Fragment>))}</div><p style={{ margin: "0", fontSize: "13px", color: "rgba(17,22,27,.6)", lineHeight: "1.6" }}>{v.acct.familyNote} <a href="mailto:zane@sftradmusic.com">Contact Zane</a>.</p></>
  );
}
