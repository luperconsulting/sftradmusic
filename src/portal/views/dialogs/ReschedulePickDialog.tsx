import type { VM } from "../../vm/types";

const button = {
  background: "#1D2A44",
  color: "#fff",
  border: "0",
  borderRadius: "2px",
  padding: "12px 18px",
  fontFamily: "'Cinzel',Georgia,serif",
  fontSize: "11px",
  letterSpacing: ".16em",
  textTransform: "uppercase" as const,
  fontWeight: 600,
  cursor: "pointer",
};

export default function ReschedulePickDialog({ v }: { v: VM }) {
  const lessons = v.rs?.choices ?? [];
  if (!lessons.length) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <p style={{ margin: 0, fontSize: "14px", lineHeight: 1.6, color: "rgba(17,22,27,.7)" }}>You don't have an upcoming lesson to move.</p>
        <button type="button" onClick={v.openBook} style={{ ...button, alignSelf: "flex-start" }}>Book a Lesson</button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <p style={{ margin: "0 0 8px", fontSize: "14px", lineHeight: 1.6, color: "rgba(17,22,27,.7)" }}>Choose the lesson you want to move. Then pick a new open time.</p>
      {lessons.map((lesson: { id: string; date: string; time: string; loc: string; pick: () => void }) => (
        <button key={lesson.id} type="button" onClick={lesson.pick} style={{ textAlign: "left", background: "#fff", border: "1px solid rgba(17,22,27,.12)", borderRadius: "2px", padding: "12px 14px", cursor: "pointer" }}>
          <div style={{ fontWeight: 600, color: "#1D2A44" }}>{lesson.date}</div>
          <div style={{ fontSize: "13px", color: "rgba(17,22,27,.6)" }}>{lesson.time} · {lesson.loc}</div>
        </button>
      ))}
    </div>
  );
}
