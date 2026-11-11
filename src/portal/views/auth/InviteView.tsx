import type { VM } from "../../vm/types";

const label = { fontSize: "11px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "rgba(17,22,27,.6)" } as const;
const field = { width: "100%", boxSizing: "border-box", padding: "13px 14px", border: "1px solid rgba(17,22,27,.15)", borderRadius: "2px", background: "#fff", fontSize: "15px", color: "#11161B" } as const;
const button = { background: "#9C5F22", color: "#fff", border: "0", borderRadius: "2px", padding: "15px", fontFamily: "'Cinzel',Georgia,serif", fontSize: "12px", letterSpacing: ".2em", textTransform: "uppercase", fontWeight: "600", cursor: "pointer" } as const;

export default function InviteView({ v }: { v: VM }) {
  return (
    <div>
      {v.su.code && (
        <>
          <span style={{ fontSize: "11px", letterSpacing: ".25em", textTransform: "uppercase", fontWeight: "600", color: "#9C5F22" }}>You're invited</span>
          <h2 style={{ fontFamily: "'Cinzel',Georgia,serif", fontWeight: "500", fontSize: "24px", letterSpacing: ".08em", textTransform: "uppercase", color: "#1D2A44", margin: "8px 0 6px" }}>Enter your code</h2>
          <p style={{ fontSize: "14px", color: "rgba(17,22,27,.6)", margin: "0 0 28px", lineHeight: "1.6" }}>Use the email address the code was sent to, and the code from that message.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={label}>Email address</span>
              <input className="dc-f6" type="email" autoComplete="email" value={v.email ?? ""} onChange={v.setEmail} style={field} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={label}>Invitation code</span>
              <input className="dc-f6" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={v.su.otp ?? ""} onChange={v.su.setOtp} placeholder="Code" style={{ ...field, fontFamily: "'Cinzel',Georgia,serif", letterSpacing: ".2em", fontSize: "22px", textAlign: "center" }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={label}>Referral code <span style={{ fontWeight: "400", textTransform: "none", letterSpacing: "0", color: "rgba(17,22,27,.45)" }}>(optional)</span></span>
              <input className="dc-f6" value={v.rc?.value ?? ""} onChange={v.rc?.set} placeholder="SFTM-XXXXXXXX" autoComplete="off" style={field} />
              <span style={{ fontSize: "12px", color: "rgba(17,22,27,.5)" }}>A friend's code takes $15 off your first invoice.</span>
            </label>
            <button className="dc-h7" onClick={v.su.submitOtp} style={button}>Continue</button>
          </div>
          <p style={{ fontSize: "12px", color: "rgba(17,22,27,.5)", margin: "24px 0 0", textAlign: "center", lineHeight: "1.6" }}>The code expires in one hour and works only once.</p>
        </>
      )}
      {v.su.details && (
        <>
          <span style={{ fontSize: "11px", letterSpacing: ".25em", textTransform: "uppercase", fontWeight: "600", color: "#9C5F22" }}>Account confirmed</span>
          <h2 style={{ fontFamily: "'Cinzel',Georgia,serif", fontWeight: "500", fontSize: "24px", letterSpacing: ".08em", textTransform: "uppercase", color: "#1D2A44", margin: "8px 0 6px" }}>Create a password</h2>
          <p style={{ fontSize: "14px", color: "rgba(17,22,27,.6)", margin: "0 0 28px", lineHeight: "1.6" }}>Next you'll set up two-factor authentication. That step is required before the portal opens.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={label}>Create password</span>
              <input className="dc-f6" type="password" value={v.password ?? ""} onChange={v.setPassword} autoComplete="new-password" placeholder="At least 12 characters" style={field} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={label}>Confirm password</span>
              <input className="dc-f6" type="password" value={v.confirm ?? ""} onChange={v.setConfirm} autoComplete="new-password" placeholder="Repeat your password" style={field} />
            </label>
            <button className="dc-h7" onClick={v.pickInviteSuccess} style={button}>Continue to two-factor</button>
          </div>
        </>
      )}
    </div>
  );
}
