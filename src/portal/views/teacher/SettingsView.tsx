import { Fragment } from "react";
import type { VM } from "../../vm/types";

const card = { background: "#fff", border: "1px solid rgba(17,22,27,.1)", borderRadius: "2px", padding: "24px", display: "flex", flexDirection: "column", gap: "14px" } as const;
const h3 = { fontFamily: "'Cinzel',Georgia,serif", fontWeight: "500", fontSize: "14px", letterSpacing: ".14em", textTransform: "uppercase", color: "#1D2A44", margin: "0" } as const;
const cap = { fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.6)" } as const;
const input = { width: "100%", boxSizing: "border-box", padding: "10px 12px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", fontSize: "14px", background: "#fff" } as const;
const row = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", fontSize: "14px", borderTop: "1px solid rgba(17,22,27,.06)", paddingTop: "14px" } as const;
const pill = (color: string) => ({ fontSize: "11px", letterSpacing: ".12em", textTransform: "uppercase", fontWeight: "600", color, whiteSpace: "nowrap" }) as const;
const small = { background: "none", border: "1px solid rgba(17,22,27,.12)", borderRadius: "2px", padding: "7px 12px", fontSize: "11px", letterSpacing: ".1em", fontWeight: "600", cursor: "pointer", color: "#1D2A44" } as const;
const primary = { background: "#1D2A44", color: "#fff", border: "0", borderRadius: "2px", padding: "10px 16px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "10px", letterSpacing: ".2em", textTransform: "uppercase", fontWeight: "600", cursor: "pointer" } as const;

function Integration({ name, sub, status }: { name: string; sub: string; status: string }) {
  return (
    <div style={row}><div><div style={{ fontWeight: "500" }}>{name}</div><div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>{sub}</div></div><span style={pill(status === "Ready" || status.startsWith("On") ? "#4A6149" : "#9C5F22")}>{status}</span></div>
  );
}

export default function SettingsView({ v }: { v: VM }) {
  const st = v.studio;
  const r = v.tRefs;
  return (
    <><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: "20px", alignItems: "start", maxWidth: "860px" }}>
      <section style={{ ...card, gridColumn: "1/-1" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}><h3 style={h3}>Lesson hours & policies</h3><span style={{ fontSize: "12px", color: "rgba(17,22,27,.5)" }}>Times in {st.form.timezone}</span></div>
        {st.loading && <div style={{ fontSize: "13px", color: "rgba(17,22,27,.55)" }}>Loading…</div>}
        {st.ready && (<>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid rgba(17,22,27,.06)", paddingTop: "14px" }}>
            <span style={cap}>Weekly lesson hours</span>
            {st.form.hours.length === 0 && <div style={{ fontSize: "13px", color: "rgba(17,22,27,.55)" }}>No hours yet. Families can't book until you add some.</div>}
            {st.form.hours.map((h: any, i: number) => (<Fragment key={i}><div style={{ display: "grid", gridTemplateColumns: "minmax(120px,1.4fr) minmax(90px,1fr) auto minmax(90px,1fr) auto", gap: "8px", alignItems: "center" }}>
              <select className="dc-f6" value={h.weekday} onChange={st.setRow(i, "weekday")} aria-label="Day" style={input}>{st.weekdays.map((d: any) => (<option key={d.id} value={d.id}>{d.label}</option>))}</select>
              <input className="dc-f6" type="time" step={1800} value={h.start} onChange={st.setRow(i, "start")} aria-label="From" style={input} />
              <span style={{ fontSize: "12px", color: "rgba(17,22,27,.5)" }}>to</span>
              <input className="dc-f6" type="time" step={1800} value={h.end} onChange={st.setRow(i, "end")} aria-label="To" style={input} />
              <button className="dc-h1" type="button" onClick={st.removeRow(i)} aria-label="Remove time range" style={{ ...small, color: "#9C5F22" }}><i className="ph ph-x"></i></button>
            </div></Fragment>))}
            <button className="dc-h1" type="button" onClick={st.addRow} style={{ ...small, alignSelf: "flex-start", display: "flex", alignItems: "center", gap: "6px" }}><i className="ph ph-plus"></i> Add hours</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: "14px", borderTop: "1px solid rgba(17,22,27,.06)", paddingTop: "14px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={cap}>Hold unpaid lessons (hours)</span><input className="dc-f6" type="number" min={0.25} max={168} step={1} value={st.form.holdHours} onChange={st.set("holdHours")} style={input} /></label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={cap}>Reschedule notice (hours)</span><input className="dc-f6" type="number" min={0} max={336} step={1} value={st.form.rescheduleHours} onChange={st.set("rescheduleHours")} style={input} /></label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={cap}>Cancel notice (hours)</span><input className="dc-f6" type="number" min={0} max={336} step={1} value={st.form.cancelHours} onChange={st.set("cancelHours")} style={input} /></label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={cap}>Zelle recipient</span><input className="dc-f6" value={st.form.zelle} onChange={st.set("zelle")} placeholder="Email or phone" style={input} /></label>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={cap}>Zelle QR code (optional)</span>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              {st.form.zelleQr && <img src={st.form.zelleQr} alt="Zelle QR code preview" style={{ width: "72px", height: "72px", objectFit: "contain", border: "1px solid rgba(17,22,27,.1)", borderRadius: "2px", background: "#fff" }} />}
              <label className="dc-h1" style={{ ...small, display: "inline-flex", alignItems: "center", gap: "6px" }}><i className="ph ph-image"></i> {st.form.zelleQr ? "Replace image" : "Choose image"}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={st.pickQr} style={{ display: "none" }} /></label>
              {st.form.zelleQr && <button className="dc-h1" type="button" onClick={st.removeQr} style={{ ...small, color: "#9C5F22" }}>Remove</button>}
            </div>
            <div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)", lineHeight: 1.5 }}>Shown to students paying an invoice. Leave the recipient blank to hide Zelle and show 'Ask your teacher how to pay.' PNG, JPEG or WebP, up to 220 KB.</div>
          </div>
          <div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)", lineHeight: 1.5 }}>Lessons are 60 minutes. A lesson booked without a credit is held this long for payment, then released. Late cancels still use the credit or keep the charge.</div>
        </>)}
        {st.error && <div role="alert" style={{ fontSize: "13px", color: "#9C5F22" }}>{st.error}</div>}
        {st.ready && <div style={{ display: "flex", justifyContent: "flex-end" }}><button className="dc-h3" disabled={st.saving} onClick={st.save} style={{ ...primary, opacity: st.saving ? ".7" : "1" }}>{st.saving ? "Saving…" : "Save"}</button></div>}
      </section>
      <section style={{ ...card, gridColumn: "1/-1" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}><h3 style={h3}>Referrals</h3><span style={{ fontSize: "12px", color: "rgba(17,22,27,.5)" }}>{r.summary}</span></div>
        <div style={{ fontSize: "13px", color: "rgba(17,22,27,.6)" }}>$15 off the new student's first invoice. $25 credit to the referrer when that invoice is paid.</div>
        {r.loading && <div style={{ fontSize: "13px", color: "rgba(17,22,27,.55)" }}>Loading…</div>}
        {r.error && <div style={{ fontSize: "13px", color: "#9C5F22" }}>{r.error}</div>}
        {r.empty && <div style={{ border: "1px dashed rgba(17,22,27,.15)", borderRadius: "2px", padding: "20px", textAlign: "center", fontSize: "13px", color: "rgba(17,22,27,.5)" }}>No referrals yet.</div>}
        {r.ready && r.rows.length > 0 && (<div style={{ display: "flex", flexDirection: "column" }}>{r.rows.map((x: any, i: number) => (<Fragment key={i}><div style={row}><div style={{ minWidth: 0 }}><div style={{ fontWeight: "500" }}>{x.who}</div><div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>{x.meta}</div></div><span style={pill(x.color)}>{x.status}</span></div></Fragment>))}</div>)}
        {r.ready && r.credits.length > 0 && (<div style={{ display: "flex", flexDirection: "column" }}><span style={{ ...cap, marginTop: "6px" }}>Credits</span>{r.credits.map((c: any, i: number) => (<Fragment key={i}><div style={row}><div><div style={{ fontWeight: "500" }}>{c.who}</div><div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>{c.amount} · {c.date}</div></div><span style={pill(c.color)}>{c.status}</span></div></Fragment>))}</div>)}
      </section>
      <section style={card}><h3 style={h3}>Security</h3><div style={row}><div><div style={{ fontWeight: "500" }}>Two-factor authentication</div><div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>Authenticator app · required for teacher access</div></div><span style={pill("#4A6149")}>{v.tfaStatusWord}</span></div><div style={row}><div><div style={{ fontWeight: "500" }}>Recovery codes</div><div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>{v.recoveryLine}</div></div><button className="dc-h1" onClick={v.openRecovery} style={small}>{v.recoveryCta}</button></div><div style={row}><div><div style={{ fontWeight: "500" }}>Sessions</div><div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>Sign out ends this browser only. This ends every browser and device.</div></div><button className="dc-h1" onClick={v.signOutEverywhere} style={small}>Sign out everywhere</button></div></section>
      <section style={card}><h3 style={h3}>Integrations</h3>
        <Integration name="Supabase" sub="Students, lessons, invoices" status={v.settingsStatus} />
        <Integration name="Video storage" sub="Private Supabase storage" status={v.storageStatus} />
        <Integration name="Google Calendar" sub="Busy times hidden from booking" status={v.calendarStatus} />
        <Integration name="Email" sub="Portal emails" status={v.emailStatus} />
        <Integration name="Card payments" sub="Stripe Checkout, test mode" status={v.cardStatus} />
        {v.safeModeOn && <div style={{ fontSize: "12px", color: "rgba(17,22,27,.55)" }}>Safe mode is on: only allowlisted addresses get email.</div>}
      </section>
    </div></>
  );
}
