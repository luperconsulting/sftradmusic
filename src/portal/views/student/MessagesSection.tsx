import { useEffect, useState } from "react";
import type { MessageThreadDTO } from "../../../../shared/portal-types";
import { api, errorText } from "../../api/client";
import type { VM } from "../../vm/types";

export default function MessagesSection({ v }: { v: VM }) {
  const studentId = v.messageStudentId as string;
  const readOnly = !!v.viewAs;
  const [threads, setThreads] = useState<MessageThreadDTO[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!studentId) return;
    let live = true;
    api<{ threads: MessageThreadDTO[] }>(`/messages?studentId=${studentId}`)
      .then((res) => {
        if (!live) return;
        setThreads(res.threads);
        setActive((current) => current ?? res.threads[0]?.id ?? null);
        setError("");
      })
      .catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [studentId]);

  const selected = threads.find((t) => t.id === active) ?? null;
  const send = async (threadId: string | null) => {
    if (readOnly) return setError("Actions are disabled in teacher preview.");
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      const res = await api<{ thread: MessageThreadDTO }>("/messages", {
        method: "POST",
        body: { studentId, threadId, subject: threadId ? null : subject, body },
      });
      setThreads((list) => [res.thread, ...list.filter((t) => t.id !== res.thread.id)]);
      setActive(res.thread.id);
      setBody("");
      setSubject("");
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <section id="portal-messages" style={{ gridColumn: "1/-1", background: "#fff", border: "1px solid rgba(17,22,27,.1)", borderRadius: "2px", boxShadow: "0 1px 2px rgba(17,22,27,.04)", padding: "28px" }}>
      <span style={{ fontSize: "11px", letterSpacing: ".25em", textTransform: "uppercase", fontWeight: "600", color: "#9C5F22" }}>Studio</span>
      <h2 style={{ fontFamily: "'Cinzel',Georgia,serif", fontWeight: "500", fontSize: "20px", letterSpacing: ".06em", textTransform: "uppercase", color: "#1D2A44", margin: "6px 0 8px" }}>Messages</h2>
      <p style={{ margin: "0 0 16px", fontSize: "13px", color: "rgba(17,22,27,.55)" }}>In the portal only. No email or text is sent.</p>
      {error && <div role="alert" style={{ fontSize: "13px", color: "#9C5F22", marginBottom: "12px" }}>{error}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: "16px" }}>
        <div>
          {threads.map((t) => (
            <button key={t.id} onClick={() => setActive(t.id)} style={{ display: "block", width: "100%", textAlign: "left", background: t.id === active ? "rgba(29,42,68,.06)" : "transparent", border: "0", borderBottom: "1px solid rgba(17,22,27,.06)", padding: "10px 8px", cursor: "pointer" }}>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#1D2A44" }}>{t.subject}</div>
            </button>
          ))}
          {threads.length === 0 && <div style={{ fontSize: "13px", color: "rgba(17,22,27,.55)" }}>No messages yet.</div>}
        </div>
        <div>
          {selected && selected.messages.map((m) => (
            <div key={m.id} style={{ marginBottom: "12px" }}>
              <div style={{ fontSize: "12px", color: "rgba(17,22,27,.5)" }}>{m.authorName}</div>
              <div style={{ fontSize: "14px", lineHeight: 1.5 }}>{m.body}</div>
            </div>
          ))}
          {!readOnly && (
            <form onSubmit={(e) => { e.preventDefault(); void send(selected ? selected.id : null); }} style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
              {!selected && <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" style={{ padding: "10px 12px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", fontSize: "14px" }} />}
              <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message" aria-label="Message" rows={3} style={{ padding: "10px 12px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", fontSize: "14px", resize: "vertical" }} />
              <button type="submit" disabled={sending} style={{ alignSelf: "flex-start", background: "#1D2A44", color: "#fff", border: "0", borderRadius: "2px", padding: "10px 16px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "11px", letterSpacing: ".16em", textTransform: "uppercase", cursor: "pointer" }}>{selected ? "Reply" : "Send"}</button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
