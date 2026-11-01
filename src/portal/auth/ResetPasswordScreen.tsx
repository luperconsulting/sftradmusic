import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AuthLayout from "../views/auth/AuthLayout";
import { supabase } from "./supabase";
import { useAuth } from "./AuthContext";

const label = { display: "flex", flexDirection: "column", gap: 6, fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", fontWeight: 600, color: "rgba(17,22,27,.6)" } as const;
const input = { padding: "12px 14px", border: "1px solid rgba(17,22,27,.15)", borderRadius: 2, fontSize: 15, background: "#fff" } as const;

// Landing page for Supabase's recovery link, which signs the visitor in for this one purpose.
export default function ResetPasswordScreen() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (pw.length < 12) return setError("Your password needs at least 12 characters.");
    if (pw !== confirm) return setError("Those passwords don't match.");
    if (!supabase) return setError("Password reset isn't connected yet.");
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (err) return setError("This reset link has expired. Ask Zane to send a new one.");
    await refresh();
    navigate("/signin", { replace: true });
  };
  return (
    <AuthLayout v={{ authTitle: "Student Portal", go: { home: () => { window.location.href = "/"; } } }}>
      <h2 style={{ fontFamily: "'Cinzel',Georgia,serif", fontWeight: 500, fontSize: 26, margin: "0 0 18px", color: "#1D2A44" }}>Choose a new password</h2>
      {error && <div role="alert" style={{ marginBottom: 14, fontSize: 13, color: "#9C5F22" }}>{error}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label style={label}>New password<input style={input} type="password" autoComplete="new-password" placeholder="At least 12 characters" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <label style={label}>Confirm password<input style={input} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        <button disabled={busy} onClick={save} style={{ background: "#1D2A44", color: "#fff", border: "none", padding: "14px", fontSize: 12, letterSpacing: ".18em", textTransform: "uppercase", fontWeight: 600, cursor: "pointer" }}>{busy ? "Saving…" : "Save password"}</button>
      </div>
    </AuthLayout>
  );
}
