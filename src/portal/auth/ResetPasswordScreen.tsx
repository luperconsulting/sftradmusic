import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AuthLayout from "../views/auth/AuthLayout";
import { hasVerifiedRecovery, supabase } from "./supabase";
import { useAuth } from "./AuthContext";

const label = { display: "flex", flexDirection: "column", gap: 6, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", fontWeight: 600, color: "rgba(17,22,27,.6)" } as const;
const input = { padding: "12px 14px", border: "1px solid rgba(17,22,27,.15)", borderRadius: 2, fontSize: 15, background: "#fff" } as const;

// Landing page for Supabase's recovery link, which signs the visitor in for this one purpose.
export default function ResetPasswordScreen() {
  const { signOut } = useAuth();
  const [linkState, setLinkState] = useState<"checking" | "valid" | "invalid">("checking");
  // Being signed in isn't enough: an unattended session must not be able to change the password from here.
  useEffect(() => {
    let live = true;
    if (!supabase) {
      setLinkState("invalid");
      return;
    }
    void supabase.auth.getSession().then(async () => {
      if (!live) return;
      const ok = hasVerifiedRecovery();
      setLinkState(ok ? "valid" : "invalid");
      // An email link alone must not get past 2FA, so the code is checked before the password changes.
      if (ok) {
        const level = await supabase!.auth.mfa.getAuthenticatorAssuranceLevel();
        if (live) setNeedsCode(level.data?.nextLevel === "aal2" && level.data?.currentLevel !== "aal2");
      }
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
    if (!supabase) return setError("Password reset isn't connected yet.");
    setBusy(true);
    if (needsCode) {
      const factors = await supabase.auth.mfa.listFactors();
      const factor = factors.data?.totp[0];
      const check = factor ? await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code }) : null;
      if (!check || check.error) {
        setBusy(false);
        return setError("That code isn't valid or has expired. Codes refresh every 30 seconds.");
      }
      setNeedsCode(false);
    }
    const { error: err } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (err?.code === "weak_password") return setError(err.message);
    if (err) return setError("This reset link has expired. Request a new one from the sign-in page.");
    // Ends every session, including this recovery one, so the new password has to be used.
    await supabase.auth.signOut({ scope: "global" });
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
