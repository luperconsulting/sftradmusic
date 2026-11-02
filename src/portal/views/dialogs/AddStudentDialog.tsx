import type { VM } from "../../vm/types";

const label = { display: "flex", flexDirection: "column", gap: "6px" } as const;
const cap = { fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.6)" } as const;
const input = { width: "100%", boxSizing: "border-box", padding: "11px 14px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", fontSize: "14px" } as const;
const primary = { background: "#1D2A44", color: "#fff", border: "0", borderRadius: "2px", padding: "14px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "12px", letterSpacing: ".2em", textTransform: "uppercase", fontWeight: "600", cursor: "pointer" } as const;
const link = { background: "none", border: "0", padding: "0", color: "#9C5F22", fontSize: "12px", cursor: "pointer" } as const;

export default function AddStudentDialog({ v }: { v: VM }) {
  const s = v.sf;
  if (s.created) {
    return (
      <>
        <p style={{ fontSize: "14px", color: "rgba(17,22,27,.7)", margin: "0", lineHeight: "1.6" }}><strong>{s.created.fullName}</strong> is now in your students and ready to invite. {s.created.contactNote}</p>
        <button className="dc-h3" onClick={s.inviteCreated} style={primary}>Create invitation</button>
        <button onClick={v.closeDialog} style={{ ...link, alignSelf: "center" }}>Done</button>
      </>
    );
  }
  const picker = (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <span style={cap}>{s.pickingBilling ? "Billing contact" : "GoHighLevel contact"}</span>
      <div style={{ display: "flex", gap: "8px" }}>
        <input className="dc-f6" aria-label="Search GoHighLevel contacts" value={s.query} onChange={s.setQuery} onKeyDown={s.queryKey} placeholder="Search by name or email" style={input} />
        <button className="dc-h1" onClick={s.search} style={{ background: "transparent", border: "1px solid rgba(17,22,27,.15)", color: "#1D2A44", borderRadius: "2px", padding: "0 14px", fontSize: "12px", fontWeight: "600", cursor: "pointer" }}>Search</button>
      </div>
      {s.searching && <span role="status" style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>Searching…</span>}
      {s.searchError && <span role="alert" style={{ fontSize: "12px", color: "#9C5F22" }}>{s.searchError}</span>}
      {s.noResults && <span style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>No matching contacts in GoHighLevel.</span>}
      {s.results.length > 0 && (
        <div style={{ border: "1px solid rgba(17,22,27,.1)", borderRadius: "2px", maxHeight: "200px", overflowY: "auto" }}>
          {s.results.map((c: any) => (
            <button key={c.id} onClick={c.pick} disabled={c.disabled} style={{ display: "block", width: "100%", textAlign: "left", background: "#fff", border: "0", borderBottom: "1px solid rgba(17,22,27,.06)", padding: "10px 12px", cursor: c.disabled ? "default" : "pointer", opacity: c.disabled ? ".55" : "1" }}>
              <span style={{ display: "block", fontSize: "14px", color: "#11161B" }}>{c.name}</span>
              <span style={{ display: "block", fontSize: "12px", color: "rgba(17,22,27,.55)" }}>{c.meta}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <>
      {s.showContactPicker && picker}
      {s.contact && !s.pickingBilling && (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", background: "rgba(29,42,68,.04)", padding: "12px 14px", borderRadius: "2px" }}>
          <span style={{ fontSize: "13px", color: "#11161B" }}>Linked contact: <strong>{s.contact.name}</strong> <button onClick={s.changeContact} style={link}>Change</button></span>
          <span style={{ fontSize: "13px", color: "#11161B" }}>Invoices billed to: <strong>{s.billing.name}</strong> <button onClick={s.changeBilling} style={link}>Change</button></span>
        </div>
      )}
      {s.showFields && (
        <>
          <label style={label}><span style={cap}>Student's full name</span><input className="dc-f6" value={s.form.fullName ?? ""} onChange={s.set("fullName")} style={input} /></label>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <span style={cap}>Adult or minor</span>
            <div style={{ display: "inline-flex", border: "1px solid rgba(17,22,27,.12)", borderRadius: "2px", padding: "3px", gap: "3px", alignSelf: "flex-start" }}>
              {s.ages.map((a: any) => (<button key={a.id} className="dc-h0" onClick={a.pick} aria-pressed={a.on} style={{ border: "0", borderRadius: "2px", padding: "7px 14px", fontSize: "12px", fontWeight: "600", cursor: "pointer", background: a.on ? "#1D2A44" : "transparent", color: a.on ? "#fff" : "rgba(17,22,27,.7)" }}>{a.label}</button>))}
            </div>
          </div>
          <label style={label}><span style={cap}>{s.isChild ? "Student's email (optional)" : "Student's email"}</span><input className="dc-f6" type="email" autoComplete="email" value={s.form.email ?? ""} onChange={s.set("email")} style={input} /></label>
          {s.isChild && (
            <>
              <label style={label}><span style={cap}>Parent or guardian</span><input className="dc-f6" value={s.form.guardianName ?? ""} onChange={s.set("guardianName")} placeholder="Full name" style={input} /></label>
              <label style={label}><span style={cap}>Parent's email</span><input className="dc-f6" type="email" autoComplete="email" value={s.form.guardianEmail ?? ""} onChange={s.set("guardianEmail")} placeholder="parent@example.com" style={input} /></label>
            </>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <span style={cap}>Lesson format</span>
            <div style={{ display: "inline-flex", border: "1px solid rgba(17,22,27,.12)", borderRadius: "2px", padding: "3px", gap: "3px", alignSelf: "flex-start" }}>
              {s.formats.map((f: any) => (<button key={f.id} type="button" onClick={f.pick} aria-pressed={f.on} style={{ border: "0", borderRadius: "2px", padding: "7px 14px", fontSize: "12px", fontWeight: "600", cursor: "pointer", background: f.on ? "#1D2A44" : "transparent", color: f.on ? "#fff" : "rgba(17,22,27,.7)" }}>{f.label}</button>))}
            </div>
          </div>
          {s.error && <div role="alert" style={{ fontSize: "13px", color: "#9C5F22" }}>{s.error}</div>}
          <button className="dc-h3" disabled={s.saving} onClick={s.save} style={{ ...primary, opacity: s.saving ? ".7" : "1" }}>{s.saving ? "Saving…" : "Add student"}</button>
        </>
      )}
    </>
  );
}
