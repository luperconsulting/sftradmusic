import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { InvitationPreview } from "../../../shared/portal-types";
import { api, ApiRequestError, errorText } from "../api/client";
import { homeFor, useAuth } from "../auth/AuthContext";
import { supabase } from "../auth/supabase";
import { fmt, useToast } from "./common";
import type { VM } from "./types";

const NOT_CONFIGURED = "Portal sign-in isn't connected yet. Please contact Zane.";

export function useAuthVM(screen: "signin" | "signup" | "invite" | "twofa" | "denied" | "reset"): VM {
  const { me, refresh, signOut, configured, status } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { toast, flash } = useToast();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [dialog, setDialog] = useState<string | null>(null);
  const [form, setForm] = useState<any>({});
  // Invitation flows
  const [step, setStep] = useState<"code" | "invalid" | "details" | "done" | "expired" | "valid" | "success">(screen === "invite" ? "valid" : "code");
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const token = params.get("token") ?? "";

  useEffect(() => {
    if (screen !== "invite") return;
    if (!token) return setStep("expired");
    api<InvitationPreview>("/invitations/verify", { method: "POST", body: { credential: token } })
      .then(setPreview)
      .catch(() => setStep("expired"));
  }, [screen, token]);

  const signIn = useCallback(async () => {
    if (busy) return;
    if (!supabase) return setError(NOT_CONFIGURED);
    setError("");
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setPassword("");
    if (err) {
      setBusy(false);
      // One generic message: never reveal whether an email has an account.
      return setError("That email and password don't match our records. Please check and try again.");
    }
    await refresh();
    setBusy(false);
  }, [busy, email, password, refresh]);

  const verifyCode = useCallback(async (value: string) => {
    if (!supabase || busy) return;
    setBusy(true);
    setError("");
    const factors = await supabase.auth.mfa.listFactors();
    const factor = factors.data?.totp[0];
    if (!factor) {
      setBusy(false);
      return setError("Two-factor isn't set up on this account yet.");
    }
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: value });
    if (err) {
      setBusy(false);
      setDigits(["", "", "", "", "", ""]);
      refs.current[0]?.focus();
      return setError("That code isn't valid or has expired. Codes refresh every 30 seconds.");
    }
    await refresh();
    setBusy(false);
  }, [busy, refresh]);

  const redeem = useCallback(async (credential: string) => {
    if (password.length < 12) return setError("Your password needs at least 12 characters.");
    if (password !== confirm) return setError("Those passwords don't match.");
    setBusy(true);
    setError("");
    try {
      await api("/invitations/redeem", { method: "POST", body: { credential, password } });
      setPassword("");
      setConfirm("");
      setStep(screen === "invite" ? "success" : "done");
      setTimeout(() => navigate("/signin"), 1400);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [password, confirm, screen, navigate]);

  const codeDigits = useMemo(() => digits.map((v, i) => ({
    v,
    border: error ? "rgba(156,95,34,.6)" : "rgba(17,22,27,.15)",
    ref: (el: HTMLInputElement | null) => { refs.current[i] = el; },
    change: (e: any) => {
      const typed = e.target.value.replace(/\D/g, "");
      const next = [...digits];
      if (typed.length > 1) typed.slice(0, 6 - i).split("").forEach((c: string, k: number) => { next[i + k] = c; }); // a pasted code
      else next[i] = typed;
      setDigits(next);
      if (typed && i < 5) refs.current[Math.min(5, i + typed.length)]?.focus();
    },
    key: (e: any) => {
      if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus();
      if (e.key === "Enter" && digits.join("").length === 6) void verifyCode(digits.join(""));
    },
  })), [digits, error, verifyCode]);

  const su = {
    code: step === "code" || step === "invalid",
    error: step === "invalid",
    details: step === "details",
    twofa: false,
    done: step === "done",
    steps: [0, 1, 2].map((i) => ({ bg: i <= ({ code: 0, invalid: 0, details: 1, done: 2 } as any)[step] ? "#9C5F22" : "rgba(17,22,27,.1)" })),
    codeVal: code,
    setCode: (e: any) => setCode(e.target.value.toUpperCase()),
    checkCode: async () => {
      if (busy) return;
      setBusy(true);
      try {
        setPreview(await api<InvitationPreview>("/invitations/verify", { method: "POST", body: { credential: code } }));
        setStep("details");
        setError("");
      } catch (e) {
        setStep("invalid");
        if (e instanceof ApiRequestError && e.status >= 500) setError(e.message);
      } finally {
        setBusy(false);
      }
    },
    first: preview?.firstName ?? "",
    student: preview?.studentLine ?? "",
    accountFor: preview?.accountFor ?? "",
    email: preview?.email ?? "",
    lessons: preview?.lessons ?? "",
    format: preview?.format ?? "",
    expires: preview ? fmt(preview.expiresAt, { month: "long", day: "numeric", year: "numeric" }) : "",
    create: () => redeem(code),
    verify: () => undefined,
    later: () => undefined,
  };
  const sub = { error: !!error, loading: busy, notLoading: !busy, default: !error, valid: step === "valid", expired: step === "expired", success: step === "success" };

  return {
    is: { signin: screen === "signin", signup: screen === "signup", invite: screen === "invite", twofa: screen === "twofa", denied: screen === "denied", settings: false },
    sub, su, email, setEmail: (e: any) => setEmail(e.target.value), password, setPassword: (e: any) => setPassword(e.target.value), confirm, setConfirm: (e: any) => setConfirm(e.target.value),
    submitOnEnter: (e: any) => { if (e.key === "Enter") void signIn(); },
    signIn, signInError: error, configured, status, formError: error,
    verify: () => (dialog === "recovery" ? flash("Recovery codes aren't available yet. Contact support to restore access.") : verifyCode(digits.join(""))),
    codeDigits, twofaLabel: me?.user.role === "teacher" ? "Teacher account" : "Your account",
    authTitle: screen === "twofa" ? (me?.user.role === "teacher" ? "Teaching Studio" : "Student Portal") : screen === "invite" || screen === "signup" ? "Welcome" : "Student Portal",
    tfa: { key: "", qr: null, input: "", error: false }, 
    rc: { value: form.rc ?? "", set: (e: any) => setForm((f: any) => ({ ...f, rc: e.target.value.toUpperCase() })), applied: false, error: false, referrer: "", apply: () => flash("Referral codes aren't switched on yet.") },
    pickInviteSuccess: () => redeem(token),
    go: {
      home: () => { window.location.href = "/"; },
      signup: () => navigate("/signup"),
      signin: () => void signOut().then(() => navigate("/signin")),
      student: () => navigate(homeFor(me)),
    },
    deniedBackLabel: "Back to my dashboard",
    openRecovery: () => setDialog("recovery"),
    dlg: { open: dialog === "recovery", width: "520px", title: "Use a recovery code", kicker: "Security", recovery: dialog === "recovery" },
    closeDialog: () => setDialog(null), stop: (e: any) => e.stopPropagation(), form, f: { code: (e: any) => setForm((s: any) => ({ ...s, code: e.target.value })) },
    hasToast: !!toast, toast,
  };
}
