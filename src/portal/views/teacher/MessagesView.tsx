import { useEffect, useState } from "react";
import type { MessageThreadDTO, TeacherStudentRow } from "../../../../shared/portal-types";
import { api, errorText } from "../../api/client";

export default function MessagesView() {
  const [threads, setThreads] = useState<MessageThreadDTO[]>([]);
  const [students, setStudents] = useState<TeacherStudentRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [studentId, setStudentId] = useState("");
  const [subject, setSubject] = useState("");
  const [reply, setReply] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  const load = () => {
    api<{ threads: MessageThreadDTO[] }>("/teacher/messages")
      .then((res) => {
        setThreads(res.threads);
        setActive((current) => current && res.threads.some((t) => t.id === current) ? current : res.threads[0]?.id ?? null);
      })
      .catch((e) => setError(errorText(e)));
  };

  useEffect(() => {
    load();
    api<{ students: TeacherStudentRow[] }>("/teacher/students").then((res) => {
      setStudents(res.students);
      setStudentId((current) => current || res.students[0]?.id || "");
    }).catch((e) => setError(errorText(e)));
  }, []);

  const selected = threads.find((t) => t.id === active) ?? null;
  const send = async (threadId: string | null, forStudent: string, text: string) => {
    if (!text.trim() || !forStudent || sending) return;
    setSending(true);
    try {
      await api("/teacher/messages", { method: "POST", body: { studentId: forStudent, threadId, subject: threadId ? null : subject, body: text } });
      if (threadId) setReply("");
      else { setDraft(""); setSubject(""); }
      setError("");
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <p style={{ margin: "0 0 16px", fontSize: "13px", color: "rgba(17,22,27,.55)" }}>In the portal only. Messages are not emailed or texted.</p>
      {error && <div role="alert" style={{ fontSize: "13px", color: "#9C5F22", marginBottom: "12px" }}>{error}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: "20px" }}>
        <div style={{ background: "#fff", border: "1px solid rgba(17,22,27,.1)", borderRadius: "2px" }}>
          {threads.map((t) => (
            <button key={t.id} onClick={() => setActive(t.id)} style={{ display: "block", width: "100%", textAlign: "left", background: t.id === active ? "rgba(29,42,68,.06)" : "transparent", border: "0", borderBottom: "1px solid rgba(17,22,27,.06)", padding: "12px 14px", cursor: "pointer" }}>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#1D2A44" }}>{t.subject}</div>
              <div style={{ fontSize: "12px", color: "rgba(17,22,27,.5)" }}>{t.studentName}</div>
            </button>
          ))}
          {threads.length === 0 && <div style={{ padding: "16px", fontSize: "13px", color: "rgba(17,22,27,.55)" }}>No messages yet.</div>}
        </div>
        <div style={{ background: "#fff", border: "1px solid rgba(17,22,27,.1)", borderRadius: "2px", padding: "20px" }}>
          {selected && (
            <>
              <h2 style={{ fontFamily: "'Cinzel',Georgia,serif", fontWeight: 500, fontSize: "18px", color: "#1D2A44", margin: "0 0 12px" }}>{selected.subject}</h2>
              {selected.messages.map((m) => (
                <div key={m.id} style={{ marginBottom: "14px" }}>
                  <div style={{ fontSize: "12px", color: "rgba(17,22,27,.5)" }}>{m.authorName}</div>
                  <div style={{ fontSize: "14px", lineHeight: 1.5 }}>{m.body}</div>
                </div>
              ))}
              <form onSubmit={(e) => { e.preventDefault(); void send(selected.id, selected.studentId, reply); }} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <textarea value={reply} onChange={(e) => setReply(e.target.value)} aria-label="Reply" rows={3} placeholder="Reply" style={{ padding: "10px 12px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", fontSize: "14px" }} />
                <button type="submit" disabled={sending} style={{ alignSelf: "flex-start", background: "#1D2A44", color: "#fff", border: "0", borderRadius: "2px", padding: "10px 16px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "11px", letterSpacing: ".16em", textTransform: "uppercase", cursor: "pointer" }}>Reply</button>
              </form>
            </>
          )}
          <form onSubmit={(e) => { e.preventDefault(); void send(null, studentId, draft); }} style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "20px", borderTop: "1px solid rgba(17,22,27,.06)", paddingTop: "16px" }}>
            <label style={{ fontSize: "12px", color: "rgba(17,22,27,.6)" }}>New message
              <select value={studentId} onChange={(e) => setStudentId(e.target.value)} aria-label="Student" style={{ display: "block", width: "100%", marginTop: "6px", padding: "10px 12px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px" }}>
                {students.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
              </select>
            </label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" style={{ padding: "10px 12px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px" }} />
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message" aria-label="New message" rows={3} style={{ padding: "10px 12px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px" }} />
            <button type="submit" disabled={sending} style={{ alignSelf: "flex-start", background: "#1D2A44", color: "#fff", border: "0", borderRadius: "2px", padding: "10px 16px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "11px", letterSpacing: ".16em", textTransform: "uppercase", cursor: "pointer" }}>Send</button>
          </form>
        </div>
      </div>
    </div>
  );
}
