import { Fragment } from "react";
import type { VM } from "../../vm/types";

export default function ScheduleDialog({ v }: { v: VM }) {
  return (
    <><div style={{ display: "flex", flexDirection: "column" }}>{(v.sched ?? []).map((s: any, i0: number) => (<Fragment key={i0}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", padding: "12px 0", borderTop: "1px solid rgba(17,22,27,.06)", fontSize: "14px" }}><div><div style={{ fontWeight: "500" }}>{s.date}</div><div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>{s.time} · {s.loc}</div></div><span style={{ fontSize: "10px", letterSpacing: ".12em", textTransform: "uppercase", fontWeight: "600", color: s.color }}>{s.status}</span></div></Fragment>))}</div><div style={{ fontSize: "11px", color: "rgba(17,22,27,.5)", display: "flex", alignItems: "center", gap: "6px" }}><i className="ph ph-info"></i> To add a lesson, use Book a Lesson on your dashboard.</div></>
  );
}
