import { Fragment } from "react";
import type { VM } from "../../vm/types";

const label = { fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.6)" } as const;
const field = { width: "100%", boxSizing: "border-box", padding: "11px 14px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", background: "#fff", fontSize: "14px" } as const;

export default function InvitationsView({ v }: { v: VM }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: "20px", alignItems: "start" }}>
      <section style={{ background: "#fff", border: "1px solid rgba(17,22,27,.1)", borderRadius: "2px", padding: "28px", display: "flex", flexDirection: "column", gap: "18px" }}>
        <div>
          <h2 style={{ fontFamily: "'Cinzel',Georgia,serif", fontWeight: "500", fontSize: "14px", letterSpacing: ".14em", textTransform: "uppercase", color: "#1D2A44", margin: "0 0 6px" }}>Invite a student</h2>
          <p style={{ fontSize: "13px", color: "rgba(17,22,27,.6)", margin: "0", lineHeight: "1.6" }}>Enter an email and, if you have it, their name and the student it's for. They receive a one-time code, enter it on the invite page, then choose a password and turn on two-factor authentication. The code expires in one hour.</p>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span style={label}>Email</span>
          <input className="dc-f6" type="email" placeholder="student@example.com" value={v.invEmail ?? ""} onChange={v.setInvEmail} style={field} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span style={label}>Name <span style={{ fontWeight: "400", textTransform: "none", letterSpacing: "0", color: "rgba(17,22,27,.45)" }}>(optional)</span></span>
          <input className="dc-f6" placeholder="Full name" value={v.invName ?? ""} onChange={v.setInvName} style={field} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span style={label}>Student <span style={{ fontWeight: "400", textTransform: "none", letterSpacing: "0", color: "rgba(17,22,27,.45)" }}>(optional)</span></span>
          <select className="dc-f6" aria-label="Link to student" value={v.invStudentId ?? ""} onChange={v.setInvStudent} style={field}>
            <option value="">No student yet (an adult is enrolled when they sign up)</option>
            {(v.invStudentOptions ?? []).map((o: any) => (
              <option key={o.id} value={o.id}>{o.label}{o.linked ? " · has an account" : ""}</option>
            ))}
          </select>
          <span style={{ fontSize: "12px", color: "rgba(17,22,27,.55)", lineHeight: "1.5" }}>Pick an adult to link the account as that student, or a child to invite their parent and link the child. Left blank, an email that matches a student on file is linked automatically.</span>
        </label>
        <button className="dc-h3" onClick={v.sendInvite} disabled={v.invSending} aria-busy={v.invSending} style={{ alignSelf: "flex-start", background: "#1D2A44", color: "#fff", border: "0", borderRadius: "2px", padding: "12px 20px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "11px", letterSpacing: ".2em", textTransform: "uppercase", fontWeight: "600", cursor: v.invSending ? "default" : "pointer", opacity: v.invSending ? ".7" : "1", display: "flex", alignItems: "center", gap: "8px" }}>
          <i className="ph ph-paper-plane-tilt"></i> {v.invSending ? "Sending…" : "Invite"}
        </button>
        {v.invStatus && v.invStatus.kind !== "sending" && (
          <div role={v.invStatus.kind === "error" ? "alert" : "status"} style={{ fontSize: "13px", lineHeight: "1.5", padding: "10px 12px", borderRadius: "2px", background: v.invStatus.kind === "error" ? "rgba(156,95,34,.08)" : "rgba(74,97,73,.08)", color: v.invStatus.kind === "error" ? "#9C5F22" : "#4A6149" }}>
            {v.invStatus.text}
          </div>
        )}
      </section>
      <section style={{ gridColumn: "span 2", minWidth: "0", background: "#fff", border: "1px solid rgba(17,22,27,.1)", borderRadius: "2px", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", minWidth: "640px" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.5)", background: "rgba(17,22,27,.02)" }}>
              <th style={{ padding: "12px 20px", fontWeight: "600", borderBottom: "1px solid rgba(17,22,27,.1)" }}>Email</th>
              <th style={{ padding: "12px 16px", fontWeight: "600", borderBottom: "1px solid rgba(17,22,27,.1)" }}>Sent</th>
              <th style={{ padding: "12px 16px", fontWeight: "600", borderBottom: "1px solid rgba(17,22,27,.1)" }}>Status</th>
              <th style={{ padding: "12px 20px 12px 16px", fontWeight: "600", borderBottom: "1px solid rgba(17,22,27,.1)", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(v.invites ?? []).map((i: any, i0: number) => (
              <Fragment key={i0}>
                <tr className="dc-h11">
                  <td style={{ padding: "13px 20px", borderBottom: "1px solid rgba(17,22,27,.06)" }}>
                    <div style={{ fontWeight: "500" }}>{i.email}</div>
                    {i.name && i.name !== i.email && <div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>{i.name}</div>}
                  </td>
                  <td style={{ padding: "13px 16px", borderBottom: "1px solid rgba(17,22,27,.06)", color: "rgba(17,22,27,.6)", fontSize: "13px" }}>{i.sent}</td>
                  <td style={{ padding: "13px 16px", borderBottom: "1px solid rgba(17,22,27,.06)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", letterSpacing: ".12em", textTransform: "uppercase", fontWeight: "600", color: i.sColor }}>
                      <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: i.sColor }}></span>{i.status}
                    </span>
                  </td>
                  <td style={{ padding: "13px 20px 13px 16px", borderBottom: "1px solid rgba(17,22,27,.06)", textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {(i.actions ?? []).map((a: any, i1: number) => (
                        <Fragment key={i1}>
                          <button className="dc-h2" onClick={a.run} style={{ background: "none", border: "1px solid rgba(17,22,27,.12)", borderRadius: "2px", padding: "6px 10px", fontSize: "11px", letterSpacing: ".08em", fontWeight: "600", cursor: "pointer", color: a.color, whiteSpace: "nowrap" }}>{a.label}</button>
                        </Fragment>
                      ))}
                    </div>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
