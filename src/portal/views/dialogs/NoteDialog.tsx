import type { VM } from "../../vm/types";

export default function NoteDialog({ v }: { v: VM }) {
  return (
    <><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: "16px 24px", fontSize: "14px", lineHeight: "1.65", color: "rgba(17,22,27,.8)" }}><div style={{ gridColumn: "1/-1" }}><div style={{ fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.5)", marginBottom: "6px" }}>Lesson summary</div>{v.dn.summary}</div><div><div style={{ fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.5)", marginBottom: "6px" }}>Technique feedback</div>{v.dn.technique}</div><div><div style={{ fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.5)", marginBottom: "6px" }}>Practice this week</div>{v.dn.practice}</div><div><div style={{ fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.5)", marginBottom: "6px" }}>Musical goals</div>{v.dn.goals}</div><div><div style={{ fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.5)", marginBottom: "6px" }}>Before next lesson</div>{v.dn.prep}</div></div></>
  );
}
