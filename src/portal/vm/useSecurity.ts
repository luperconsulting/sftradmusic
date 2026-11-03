import { useCallback, useState } from "react";
import { errorText } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { markMfaVerified } from "../auth/teacherGate";
import { DEMO_MODE, supabase } from "../auth/supabase";
import { copy } from "./common";

// Real Supabase MFA and password flows behind the design's security screens. No code is checked in the browser.
export function useSecurity(flash: (m: string) => void, onOpen?: () => void) {
  const { me, refresh } = useAuth();
  const [enroll, setEnroll] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCur, setPwCur] = useState("");
  const [pwNext, setPwNext] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwLast, setPwLast] = useState("when you created your account");
  const on = !!me?.user.mfaEnabled;

  const begin = useCallback(async () => {
    setInput("");
    setError(false);
    onOpen?.();
    if (on || !supabase) return;
    // Clear any abandoned, unverified factor first, because Supabase rejects a duplicate enrollment.
    const list = await supabase.auth.mfa.listFactors();
    for (const f of list.data?.all ?? []) if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    const { data, error: err } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "SF Trad Music" });
    if (err || !data) {
      flash("Two-factor setup couldn't start. Please try again.");
      return;
    }
    setEnroll({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }, [on, onOpen, flash]);

  const verify = useCallback(async (): Promise<boolean> => {
    if (!supabase || !enroll) {
      flash(DEMO_MODE ? "Sample mode: two-factor is unavailable." : "Two-factor isn't available right now.");
      return false;
    }
    if (input.length !== 6 || busy) {
      setError(input.length !== 6);
      return false;
    }
    setBusy(true);
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId: enroll.factorId, code: input });
    setBusy(false);
    if (err) {
      setError(true);
      return false;
    }
    setEnroll(null);
    markMfaVerified();
    await refresh();
    flash("Two-factor authentication is on.");
    return true;
  }, [enroll, input, busy, flash, refresh]);

  const disable = useCallback(async () => {
    flash("Two-factor authentication is required on all portal accounts.");
  }, [flash]);

  const score = pwNext.length >= 12 ? (/[0-9]/.test(pwNext) && /[A-Z]/.test(pwNext) ? 4 : 3) : pwNext.length >= 8 ? 2 : pwNext.length ? 1 : 0;
  const cols = ["", "#9C5F22", "#C27D38", "#4A6149", "#4A6149"];
  const resetPw = () => {
    setPwOpen(false);
    setPwCur("");
    setPwNext("");
    setPwConfirm("");
    setPwError("");
  };

  return {
    tfa: {
      on,
      off: !on,
      status: on ? "2FA on" : "2FA off",
      statusColor: on ? "#4A6149" : "#9C5F22",
      since: "your account settings",
      key: enroll?.secret ?? "Generating…",
      qr: enroll?.qr ?? null,
      input,
      error,
      set: (e: any) => {
        setInput(e.target.value.replace(/[^0-9]/g, "").slice(0, 6));
        setError(false);
      },
      copyKey: () => {
        if (enroll) copy(enroll.secret);
        flash("Setup key copied.");
      },
      open: begin,
      verify,
      disable,
    },
    pw: {
      last: pwLast,
      closed: !pwOpen,
      openFlag: pwOpen,
      open: () => setPwOpen(true),
      cancel: resetPw,
      cur: pwCur,
      next: pwNext,
      confirm: pwConfirm,
      setCur: (e: any) => { setPwCur(e.target.value); setPwError(""); },
      setNext: (e: any) => { setPwNext(e.target.value); setPwError(""); },
      setConfirm: (e: any) => { setPwConfirm(e.target.value); setPwError(""); },
      error: !!pwError,
      errorMsg: pwError,
      meter: [1, 2, 3, 4].map((i) => ({ bg: i <= score ? cols[score] : "rgba(17,22,27,.1)" })),
      strength: ["", "Too short", "Weak", "Good", "Strong"][score],
      save: async () => {
        if (!pwCur) return setPwError("Enter your current password.");
        if (pwNext.length < 12) return setPwError("Your new password needs at least 12 characters.");
        if (pwNext !== pwConfirm) return setPwError("Those passwords don't match.");
        if (!supabase || !me) return setPwError("Password changes aren't available right now.");
        try {
          // Supabase checks the current password itself, and the session keeps its 2FA level.
          const { error: err } = await supabase.auth.updateUser({ password: pwNext, current_password: pwCur });
          if (err) return setPwError(err.code === "weak_password" ? err.message : "That password couldn't be changed. Check your current password and try again.");
          resetPw();
          setPwLast("just now");
          await refresh();
          flash("Password updated.");
        } catch (e) {
          setPwError(errorText(e));
        }
      },
    },
    // Supabase's TOTP has no recovery codes, so these screens stay honest until a backend exists.
    codes: [] as { v: string }[],
    copyCodes: () => flash("Recovery codes aren't available yet. Add a second authenticator device instead."),
    regenCodes: () => flash("Recovery codes aren't available yet."),
  };
}
