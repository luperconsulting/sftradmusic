import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AuthProvider, homeFor, useAuth } from "./auth/AuthContext";
import { INVITE_PATH } from "./auth/routes";
import { DEMO_MODE, supabase } from "./auth/supabase";
import { useAuthVM } from "./vm/useAuthVM";
import { useStudentVM } from "./vm/useStudentVM";
import { useTeacherVM } from "./vm/useTeacherVM";
import { useSecurity } from "./vm/useSecurity";
import { useToast } from "./vm/common";
import AuthLayout from "./views/auth/AuthLayout";
import SignInView from "./views/auth/SignInView";
import InviteView from "./views/auth/InviteView";
import TwoFactorView from "./views/auth/TwoFactorView";
import DeniedView from "./views/auth/DeniedView";
import ResetPasswordScreen from "./auth/ResetPasswordScreen";
import StudentDashboardView from "./views/student/StudentDashboardView";
import TeacherShellView from "./views/teacher/TeacherShellView";
import DialogHost from "./views/dialogs/DialogHost";
import Toast from "./views/shared/Toast";
import type { VM } from "./vm/types";

function Splash({ message = "Loading…" }: { message?: string }) {
  return (
    <div role="status" aria-live="polite" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, color: "rgba(17,22,27,.6)", fontSize: 12, letterSpacing: ".18em", textTransform: "uppercase", fontWeight: 600 }}>
      <span style={{ width: 22, height: 22, borderRadius: "50%", border: "2px solid rgba(194,125,56,.3)", borderTopColor: "#9C5F22", animation: "spin .8s linear infinite" }} aria-hidden="true" />
      {message}
    </div>
  );
}

function DemoBanner() {
  if (!DEMO_MODE) return null;
  return (
    <div role="note" style={{ position: "fixed", left: 12, bottom: 12, zIndex: 9999, background: "#7A1F1F", color: "#fff", padding: "6px 12px", fontSize: 11, fontWeight: 700, letterSpacing: ".08em", borderRadius: 2 }}>
      DEVELOPMENT SAMPLE DATA: NOT REAL
    </div>
  );
}

function FormError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div role="alert" style={{ marginBottom: 14, fontSize: 13, color: "#9C5F22", lineHeight: 1.5 }}>
      {message}
    </div>
  );
}

function AuthScreen({ screen, children }: { screen: "signin" | "signup" | "invite" | "twofa" | "denied"; children: (v: VM) => ReactNode }) {
  const v = useAuthVM(screen);
  return (
    <>
      <AuthLayout v={v}>{children(v)}</AuthLayout>
      <DialogHost v={v} />
      {v.hasToast && <Toast v={v} />}
    </>
  );
}

// Signed-in visitors skip the sign-in screen and go to their own area.
function SignInRoute() {
  const { status, me } = useAuth();
  const location = useLocation();
  const next = (location.state as any)?.from as string | undefined;
  if (status === "ready") return <Navigate to={next ?? homeFor(me)} replace />;
  if (status === "needsMfa") return <Navigate to="/verify" replace />;
  return (
    <AuthScreen screen="signin">
      {(v) => {
        const extra = status === "suspended" ? "This account's access has been turned off. Please contact Zane." : status === "noAccount" ? "No portal account is linked to this sign-in. Please contact Zane." : status === "unavailable" ? "The portal can't be reached right now. Please try again shortly." : !supabase && !DEMO_MODE ? "Portal sign-in isn't connected yet. Please contact Zane." : "";
        return (
          <>
            <FormError message={extra} />
            <SignInView v={v} />
          </>
        );
      }}
    </AuthScreen>
  );
}

function VerifyRoute() {
  const { status, me, signOut } = useAuth();
  const { flash, toast } = useToast();
  const navigate = useNavigate();
  const sec = useSecurity(flash);
  useEffect(() => {
    // Anyone who hasn't enrolled yet must set up 2FA before anything else loads.
    if (status === "needsMfa" && !me?.user.mfaEnabled) void sec.tfa.open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, me?.user.mfaEnabled]);
  if (status === "loading") return <Splash />;
  if (status === "ready") return <Navigate to={homeFor(me)} replace />;
  if (status !== "needsMfa") return <Navigate to="/signin" replace />;
  if (!me?.user.mfaEnabled) {
    const v: VM = {
      ...sec,
      is: { twofa: true, settings: false },
      dlg: { open: true, width: "520px", title: "Set up two-factor authentication", kicker: "Required", enroll2fa: true },
      closeDialog: () => void signOut().then(() => navigate("/signin")),
      stop: (e: any) => e.stopPropagation(),
      hasToast: !!toast,
      toast,
      authTitle: me?.user.role === "teacher" ? "Teaching Studio" : "Student Portal",
      go: { home: () => { window.location.href = "/"; } },
    };
    return (
      <>
        <AuthLayout v={v}><div /></AuthLayout>
        <DialogHost v={v} />
        {v.hasToast && <Toast v={v} />}
      </>
    );
  }
  return <AuthScreen screen="twofa">{(v) => <TwoFactorView v={v} />}</AuthScreen>;
}

function RequireRole({ role, children }: { role: "teacher" | "family"; children: ReactNode }) {
  const { status, me } = useAuth();
  const location = useLocation();
  const [params] = useSearchParams();
  if (status === "loading") return <Splash />;
  if (status === "needsMfa") return <Navigate to="/verify" replace />;
  if (status !== "ready" || !me) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  const isTeacher = me.user.role === "teacher";
  // A teacher may open the family view only as the read-only preview of a chosen student.
  const allowed = role === "teacher" ? isTeacher : !isTeacher || !!params.get("preview");
  if (!allowed) return <Navigate to="/denied" replace />;
  return <>{children}</>;
}

const SECTION_BY_PATH: Record<string, string> = { "/portal/notes": "portal-notes", "/portal/videos": "portal-videos", "/portal/assignments": "portal-videos", "/portal/invoices": "portal-balance", "/portal/payments": "portal-payments", "/portal/messages": "portal-messages" };

function StudentRoute() {
  const [params] = useSearchParams();
  const location = useLocation();
  const v = useStudentVM({ readOnlyStudentId: params.get("preview") });
  const loaded = !v.sub.loading;
  useEffect(() => {
    if (!loaded) return;
    if (location.pathname === "/portal/calendar") v.openSchedule();
    const id = SECTION_BY_PATH[location.pathname];
    if (id) document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, location.pathname]);
  return (
    <>
      <StudentDashboardView v={v} />
      {v.loadError && <div role="alert" style={{ position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)", background: "#fff", border: "1px solid rgba(156,95,34,.4)", color: "#9C5F22", padding: "10px 16px", fontSize: 13, zIndex: 50 }}>{v.loadError}</div>}
      <DialogHost v={v} />
      {v.hasToast && <Toast v={v} />}
    </>
  );
}

function TeacherRoute({ screen }: { screen: string }) {
  const v = useTeacherVM(screen);
  return (
    <>
      <TeacherShellView v={v} />
      {v.apiDown && <div role="alert" style={{ position: "fixed", bottom: 12, right: 12, background: "#fff", border: "1px solid rgba(156,95,34,.4)", color: "#9C5F22", padding: "10px 16px", fontSize: 13, zIndex: 50, maxWidth: 360 }}>{v.apiDown}</div>}
      <DialogHost v={v} />
      {v.hasToast && <Toast v={v} />}
    </>
  );
}

const teacherRoutes: [string, string][] = [["/teacher", "overview"], ["/teacher/calendar", "calendar"], ["/teacher/invoices", "invoices"], ["/teacher/students", "students"], ["/teacher/students/:studentId", "profile"], ["/teacher/messages", "messages"], ["/teacher/notes", "notes"], ["/teacher/videos", "videos"], ["/teacher/assignments", "assignments"], ["/teacher/invitations", "invitations"], ["/teacher/settings", "settings"]];

export default function PortalApp() {
  return (
    <AuthProvider>
      <DemoBanner />
      <Routes>
        <Route path="/signin" element={<SignInRoute />} />
        <Route path="/signup" element={<Navigate to={INVITE_PATH} replace />} />
        <Route path="/invite" element={<AuthScreen screen="invite">{(v) => (<><FormError message={v.formError} /><InviteView v={v} /></>)}</AuthScreen>} />
        <Route path="/verify" element={<VerifyRoute />} />
        <Route path="/reset-password" element={<ResetPasswordScreen />} />
        <Route path="/denied" element={<AuthScreen screen="denied">{(v) => <DeniedView v={v} />}</AuthScreen>} />
        {["/portal", "/portal/calendar", "/portal/invoices", "/portal/payments", "/portal/messages", "/portal/notes", "/portal/videos", "/portal/assignments"].map((p) => (
          <Route key={p} path={p} element={<RequireRole role="family"><StudentRoute /></RequireRole>} />
        ))}
        {teacherRoutes.map(([p, screen]) => (
          <Route key={p} path={p} element={<RequireRole role="teacher"><TeacherRoute screen={screen} /></RequireRole>} />
        ))}
        <Route path="*" element={<Navigate to="/signin" replace />} />
      </Routes>
    </AuthProvider>
  );
}
