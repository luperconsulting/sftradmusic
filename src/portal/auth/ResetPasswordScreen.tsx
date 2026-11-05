import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AuthLayout from "../views/auth/AuthLayout";
import { saveNewPassword, waitForRecoverySession } from "./recovery";
import { recoverySignals, supabase } from "./supabase";
import { useAuth } from "./AuthContext";

const label = { display: "flex", flexDirection: "column", gap: 6, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", fontWeight: 600, color: "rgba(17,22,27,.6)" } as const;
const input = { padding: "12px 14px", border: "1px solid rgba(17,22,27,.15)", borderRadius: 2, fontSize: 15, background: "#fff" } as const;

// Landing page for Supabase's recovery link, which signs the visitor in for this one purpose.
export default function ResetPasswordScreen() {
  const { signOut } = useAuth();
  const [linkState, setLinkState] = useState<"checking" | "valid" | "invalid">("checking");
  // Being signed in isn't enough: only a session from a reset link can change the password here.
  useEffect(() => {
    let live = true;
    if (!supabase) {
      setLinkState("invalid");
      return;
    }
    void waitForRecoverySession(async () => (await supabase!.auth.getSession()).data.session, recoverySignals).then(async (ok) => {
      if (!live) return;
      // An email link alone must not get past 2FA, so an enrolled account confirms its code before saving.
      if (ok) {
        const level = await supabase!.auth.mfa.getAuthenticatorAssuranceLevel();
        if (!live) return;
        setNeedsCode(level.data?.nextLevel === "aal2");
      }
      setLinkState(ok ? "valid" : "invalid");
    });
    return () => { live = false; };
  }, []);
  const navigate = useNavigate();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState("");
  const save = async () => {
    if (pw.length < 12) return setError("Your password needs at least 12 characters.");
    if (pw !== confirm) return setError("Those passwords don't match.");
    if (!supabase) return setError("Password reset needs the Supabase settings for this site.");
    setBusy(true);
    const result = await saveNewPassword(supabase, { password: pw, code, needsCode });
    setBusy(false);
    if (result.error) return setError(result.error);
    await signOut();
    navigate("/signin", { replace: true });
  };
  return (
    <AuthLayout v={{ authTitle: "Student Portal", go: { home: () => { window.location.href = "/"; } } }}>
      <h2 style={{ fontFamily: "'Cinzel',Georgia,serif", fontWeight: 500, fontSize: 26, margin: "0 0 18px", color: "#1D2A44" }}>Choose a new password</h2>
      {linkState === "checking" && <p role="status" style={{ fontSize: 13, color: "rgba(17,22,27,.6)" }}>Checking your reset link…</p>}
      {linkState === "invalid" && <p role="alert" style={{ fontSize: 14, color: "#9C5F22", lineHeight: 1.6 }}>This reset link is invalid or has expired. Request a new one from the sign-in page.</p>}
      {linkState === "valid" && <>
      {error && <div role="alert" style={{ marginBottom: 14, fontSize: 13, color: "#9C5F22" }}>{error}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label style={label}>New password<input style={input} type="password" autoComplete="new-password" placeholder="At least 12 characters" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <label style={label}>Confirm password<input style={input} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        {needsCode && <label style={label}>Six-digit code from your authenticator<input style={input} inputMode="numeric" maxLength={6} autoComplete="one-time-code" placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></label>}
        <button disabled={busy} onClick={save} style={{ background: "#1D2A44", color: "#fff", border: "none", padding: "14px", fontSize: 12, letterSpacing: ".18em", textTransform: "uppercase", fontWeight: 600, cursor: "pointer" }}>{busy ? "Saving…" : "Save password"}</button>
      </div>
      </>}
    </AuthLayout>
  );
}
