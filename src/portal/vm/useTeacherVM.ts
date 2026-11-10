import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { studentFormError } from "../../../shared/student-form";
import type { AssignedVideoDTO, BillingDTO, InvitationDTO, InvoiceDTO, LessonDTO, NoteDTO, PracticeAssignmentDTO, ReferralPanelDTO, StudentSummary, TeacherPaymentReportDTO, TeacherStudentRow, VideoDTO } from "../../../shared/portal-types";
import { formatMoney, SERIES_WEEKS_DEFAULT, SERIES_WEEKS_MAX, SESSION_PRICE_CENTS } from "../../../shared/pricing";
import { api, errorText } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { supabase } from "../auth/supabase";
import { clock, copy, fmt, fmtDay, initialsOf, TZ, todayLabel, useToast, useViewport, wallTimeToIso } from "./common";
import { useSecurity } from "./useSecurity";
import type { VM } from "./types";

const TITLES: Record<string, string> = { overview: "Overview", calendar: "Calendar", invoices: "Invoices", students: "Students", profile: "Student profile", notes: "Teaching Notes", videos: "Video Library", assignments: "Assignments", invitations: "Account Invitations", settings: "Settings" };
const NAV = [["overview", "Overview", "ph ph-squares-four"], ["calendar", "Calendar", "ph ph-calendar-blank"], ["invoices", "Invoices", "ph ph-receipt"], ["students", "Students", "ph ph-users"], ["notes", "Teaching Notes", "ph ph-note-pencil"], ["videos", "Video Library", "ph ph-video"], ["assignments", "Assignments", "ph ph-list-checks"], ["invitations", "Account Invitations", "ph ph-envelope-simple"], ["settings", "Settings", "ph ph-gear"]];
const CATS = ["All", "Technique", "Repertoire", "Practice Exercises", "Music Theory", "Additional Resources"];
const REMIND_OFF = "Reminders aren't sent from the portal yet. The request was logged only.";
const statusLabel: Record<string, string> = { sent: "Sent", paid: "Paid", draft: "Draft", void: "Void", overdue: "Overdue", partially_paid: "Sent", payment_processing: "Sent" };
const invColor: Record<string, string> = { accepted: "#4A6149", pending: "#C27D38", code_issued: "#C27D38", expired: "#9C5F22", reset_sent: "#1D2A44", disabled: "rgba(17,22,27,.45)", revoked: "rgba(17,22,27,.45)" };
const invLabel: Record<string, string> = { accepted: "Accepted", pending: "Pending", code_issued: "Code issued", expired: "Expired", reset_sent: "Reset sent", disabled: "Disabled", revoked: "Revoked" };

const emptyNote = () => ({ id: null as string | null, studentId: "", lessonDate: new Date().toISOString().slice(0, 10), title: "", summary: "", technique: "", practice: "", goals: "", prep: "", status: "draft" as "draft" | "published", publishedAt: null as string | null });
const startOfWeek = (offset: number) => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + offset * 7);
  return d;
};
const invoiceOverdue = (i: InvoiceDTO) => i.amountDue > 0 && !["paid", "void", "draft"].includes(i.status) && !!i.dueDate && new Date(i.dueDate).getTime() < Date.now();
const invoiceDisplay = (i: InvoiceDTO) => (invoiceOverdue(i) ? "Overdue" : statusLabel[i.status] ?? i.status);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad2 = (n: number) => String(n).padStart(2, "0");
// <input type="time"> can't show 24:00, so a block that ends at midnight shows as 23:59 and saves back as 24:00.
const toHM = (m: number) => (m >= 1440 ? "23:59" : `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`);
const fromHM = (v: string) => { const [h, m] = v.split(":").map(Number); const t = (h || 0) * 60 + (m || 0); return t === 1439 ? 1440 : t; };
const hoursText = (n: number) => String(Math.round(n * 100) / 100);
type HourRow = { weekday: number; start: string; end: string };
type StudioForm = { holdHours: string; rescheduleHours: string; cancelHours: string; zelle: string; zelleQr: string | null; timezone: string; hours: HourRow[] };
const QR_MAX_BYTES = 220 * 1024;
const QR_TYPES = ["image/png", "image/jpeg", "image/webp"];
const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const EACH_LESSON = `Each lesson uses a credit or creates its own ${formatMoney(SESSION_PRICE_CENTS)} invoice.`;

export function useTeacherVM(screen: string): VM {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { studentId: routeStudentId } = useParams();
  const vp = useViewport();
  const { toast, flash } = useToast();

  const [students, setStudents] = useState<TeacherStudentRow[]>([]);
  const [overview, setOverview] = useState<any>(null);
  const [events, setEvents] = useState<any[] | null>(null);
  const [calError, setCalError] = useState("");
  const [invoices, setInvoices] = useState<InvoiceDTO[] | null>(null);
  const [invoiceError, setInvoiceError] = useState("");
  const [reports, setReports] = useState<TeacherPaymentReportDTO[] | null>(null);
  const [reportsError, setReportsError] = useState("");
  const [reportsAll, setReportsAll] = useState(false);
  const [videos, setVideos] = useState<VideoDTO[]>([]);
  const [assigns, setAssigns] = useState<PracticeAssignmentDTO[]>([]);
  const [invites, setInvites] = useState<InvitationDTO[]>([]);
  const [issued, setIssued] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<any>(null);
  const [profile, setProfile] = useState<{ student: StudentSummary; notes: NoteDTO[]; videos: AssignedVideoDTO[]; assignments: PracticeAssignmentDTO[]; lessons: LessonDTO[] | null; billing: BillingDTO | null; packageLessons?: number; referrals?: ReferralPanelDTO | null } | null>(null);
  const [studio, setStudio] = useState<StudioForm | null>(null);
  const [studioError, setStudioError] = useState("");
  const [studioSaving, setStudioSaving] = useState(false);
  const [teacherRefs, setTeacherRefs] = useState<{ referrals: any[]; credits: any[] } | null>(null);
  const [refsError, setRefsError] = useState("");
  const [loading, setLoading] = useState(true);
  const [apiDown, setApiDown] = useState("");

  const [navOpen, setNavOpen] = useState(false);
  const [dialog, setDialog] = useState<{ kind: string; data: any } | null>(null);
  const [form, setForm] = useState<any>({});
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("All");
  const [calWeek, setCalWeek] = useState(0);
  const [calTick, setCalTick] = useState(0);
  const [invFilter, setInvFilter] = useState("All");
  const [invQ, setInvQ] = useState("");
  const [note, setNote] = useState(emptyNote());
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [aTitle, setATitle] = useState("");
  const [aForm, setAForm] = useState({ instructions: "", videoId: "", lessonDate: "", dueDate: "" });
  const [assignees, setAssignees] = useState<Record<string, boolean>>({});
  const [assignVideo, setAssignVideo] = useState<VideoDTO | null>(null);
  const [assignSel, setAssignSel] = useState<Record<string, boolean>>({});
  const [invMethod, setInvMethod] = useState<"email" | "code">("email");
  const [invRole, setInvRole] = useState("Parent / guardian");
  const [invEmail, setInvEmail] = useState("");
  const [invName, setInvName] = useState("");
  const [invStudentId, setInvStudentId] = useState("");
  const [migrateBill, setMigrateBill] = useState("student");
  const contentRef = useRef<HTMLDivElement>(null);
  const file = useRef<File | null>(null);
  const busy = useRef(false);

  const close = useCallback(() => setDialog(null), []);
  const open = useCallback((kind: string, d: any = {}) => {
    setDialog({ kind, data: d });
    setForm(d.form ?? {});
  }, []);
  const sec = useSecurity(flash, useCallback(() => open("enroll2fa"), [open]));

  const guard = (fn: () => Promise<unknown>) => async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await fn();
    } catch (e) {
      flash(errorText(e));
    } finally {
      busy.current = false;
    }
  };

  const loadCore = useCallback(async () => {
    const results = await Promise.allSettled([
      api("/teacher/students").then((r) => setStudents(r.students)),
      api("/teacher/overview").then(setOverview),
      api("/teacher/videos").then((r) => setVideos(r.videos)),
      api("/teacher/assignments").then((r) => setAssigns(r.assignments)),
      api("/teacher/invitations").then((r) => setInvites(r.invitations)),
      api("/teacher/settings").then(setSettings),
    ]);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    setApiDown(failed ? errorText(failed.reason) : "");
    setLoading(false);
  }, []);
  useEffect(() => { void loadCore(); }, [loadCore]);
  const studioToForm = (r: { settings: any; hours: { weekday: number; startMinute: number; endMinute: number }[] }): StudioForm => ({
    holdHours: hoursText((r.settings?.holdWindowMinutes ?? 1440) / 60),
    rescheduleHours: String(r.settings?.rescheduleNoticeHours ?? 24),
    cancelHours: String(r.settings?.cancelNoticeHours ?? 24),
    zelle: r.settings?.zelleRecipient ?? "",
    zelleQr: r.settings?.zelleQrDataUrl ?? null,
    timezone: r.settings?.timezone ?? TZ,
    hours: [...(r.hours ?? [])].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute).map((h) => ({ weekday: h.weekday, start: toHM(h.startMinute), end: toHM(h.endMinute) })),
  });
  useEffect(() => {
    if (screen !== "settings") return;
    let live = true;
    api("/teacher/studio").then((r) => { if (live) { setStudio(studioToForm(r)); setStudioError(""); } }).catch((e) => live && setStudioError(errorText(e)));
    api("/teacher/referrals").then((r) => { if (live) { setTeacherRefs(r); setRefsError(""); } }).catch((e) => live && setRefsError(errorText(e)));
    return () => { live = false; };
  }, [screen]);

  const weekStart = useMemo(() => startOfWeek(calWeek), [calWeek]);
  useEffect(() => {
    let live = true;
    const from = weekStart.getTime();
    setEvents(null);
    api(`/teacher/calendar?from=${from}&to=${from + 7 * 864e5}`)
      .then((r) => { if (live) { setEvents(r.events); setCalError(""); } })
      .catch((e) => { if (live) { setEvents([]); setCalError(errorText(e)); } });
    return () => { live = false; };
  }, [weekStart, calTick]);
  const loadInvoices = useCallback(() => {
    api("/teacher/invoices").then((r) => { setInvoices(r.invoices); setInvoiceError(""); }).catch((e) => { setInvoices([]); setInvoiceError(errorText(e)); });
  }, []);
  useEffect(() => { loadInvoices(); }, [loadInvoices]);
  const loadReports = useCallback(() => {
    api<{ reports: TeacherPaymentReportDTO[] }>(`/teacher/payment-reports?status=${reportsAll ? "all" : "pending"}`)
      .then((r) => { setReports(r.reports ?? []); setReportsError(""); })
      .catch((e) => { setReports([]); setReportsError(errorText(e)); });
  }, [reportsAll]);
  useEffect(() => { loadReports(); }, [loadReports]);

  const loadProfile = useCallback(async (id: string) => {
    try {
      setProfile(await api(`/teacher/students/${id}`));
    } catch (e) {
      setProfile(null);
      flash(errorText(e));
    }
  }, [flash]);
  useEffect(() => {
    if (routeStudentId) void loadProfile(routeStudentId);
  }, [routeStudentId, loadProfile]);
  useEffect(() => { contentRef.current?.scrollTo(0, 0); setNavOpen(false); }, [location.pathname]);
  // The notes editor starts on the student handed over by a profile or the first in the directory.
  const stateStudent = (location.state as any)?.studentId as string | undefined;
  useEffect(() => {
    if (screen === "notes" && !note.studentId && students.length) {
      setNote((n) => ({ ...n, studentId: stateStudent ?? students[0].id }));
    }
  }, [screen, students, note.studentId, stateStudent]);
  useEffect(() => {
    if (screen === "notes" && note.studentId && note.studentId !== profile?.student.id) void loadProfile(note.studentId);
  }, [screen, note.studentId, profile?.student.id, loadProfile]);

  const goTo = (path: string, state?: any) => () => navigate(path, { state });
  const go = {
    calendar: goTo("/teacher/calendar"), invoices: goTo("/teacher/invoices"), notes: () => navigate("/teacher/notes", { state: { studentId: profile?.student.id } }),
    videos: goTo("/teacher/videos"), assignments: goTo("/teacher/assignments"), invitations: goTo("/teacher/invitations"),
    signin: () => void signOut().then(() => navigate("/signin")),
  };
  const is: any = { teacher: true, twofa: false };
  Object.keys(TITLES).forEach((k) => { is[k] = screen === k; });

  const navItems = NAV.map(([id, label, icon]) => {
    const active = screen === id || (id === "students" && screen === "profile");
    return { label, icon, active, current: active ? "page" : undefined, pick: () => navigate(id === "overview" ? "/teacher" : `/teacher/${id}`), bg: active ? "rgba(255,255,255,.08)" : "transparent", color: active ? "#fff" : "rgba(255,255,255,.7)", iconColor: active ? "#E0A363" : "rgba(255,255,255,.55)" };
  });

  // ---- students
  const q = query.trim().toLowerCase();
  const nextShort = (iso: string | null) => (iso ? `${fmt(iso, { weekday: "short", month: "short", day: "numeric" }).replace(",", "")} · ${clock(iso)}` : "—");
  const filteredStudents = students.filter((s) => !q || s.fullName.toLowerCase().includes(q) || (s.guardianName ?? "").toLowerCase().includes(q)).map((s) => ({
    name: s.fullName, style: s.styleLine, parent: s.guardianName ?? "—", format: s.format, next: nextShort(s.nextLesson), notes: s.noteCount, videos: s.videoCount, assign: s.assignmentCount, packages: s.packageLessons ?? 0,
    initials: initialsOf(s.fullName), icon: s.format === "Zoom" ? "ph ph-video-camera" : "ph ph-map-pin", open: () => navigate(`/teacher/students/${s.id}`),
  }));

  // ---- profile
  const row = students.find((s) => s.id === profile?.student.id);
  const st = profile?.student;
  const adult = st ? !st.isMinor : false;
  const owner = st ? (adult ? st.fullName : st.guardianName ?? "—") : "";
  const profUnpaid = !!profile?.billing?.bookingBlocked;
  const lessonsSorted = [...(profile?.lessons ?? [])].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const now = Date.now();
  const lessonRow = (l: LessonDTO) => ({ date: fmt(l.startTime, { weekday: "short", month: "short", day: "numeric" }), time: clock(l.startTime), loc: l.locationLabel });
  const ymdInTz = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const hmInTz = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const openLessonDialog = (l: LessonDTO | null) => open("teacherLesson", {
    lesson: l,
    form: l
      ? { date: ymdInTz(l.startTime), time: hmInTz(l.startTime), location: l.isZoom ? "Zoom" : "Music City SF" }
      : { date: "", time: "16:00", location: st?.format === "Zoom" ? "Zoom" : "Music City SF", repeatWeekly: false, weeks: String(SERIES_WEEKS_DEFAULT) },
  });
  const profRefs = profile?.referrals ?? null;
  const refreshAfterLessonChange = async () => {
    setCalTick((t) => t + 1);
    if (profile) await loadProfile(profile.student.id);
    setStudents((await api("/teacher/students")).students);
  };
  const prof = {
    name: st?.fullName ?? "", first: st?.firstName ?? "", initials: st ? initialsOf(st.fullName) : "",
    sub: st ? `${st.styleLine}${adult ? " · Adult student" : " · Child"}${st.studentSince ? ` · Student since ${fmtDay(st.studentSince, { month: "long", year: "numeric" })}` : ""}` : "",
    ownerLabel: adult ? "Account owner" : "Parent / guardian", owner, email: st?.guardianEmail ?? "",
    icon: st?.format === "Zoom" ? "ph ph-video-camera" : "ph ph-map-pin", format: st?.format === "Zoom" ? "Zoom" : "In person · Music City SF",
    next: nextShort(row?.nextLesson ?? null),
    pay: !profile?.billing ? "Billing unavailable" : profUnpaid ? `Invoice #${profile.billing.openInvoices[0]?.number} unpaid` : "Paid up", payColor: profUnpaid ? "#9C5F22" : "#4A6149",
    packageLessons: profile?.packageLessons ?? row?.packageLessons ?? 0,
    refCode: profRefs?.code || "—",
    referred: profRefs ? `${profRefs.totalReferred} referred${profRefs.referredBy ? ` · joined with ${profRefs.referredBy.code}` : ""}` : "Unavailable",
    refCredit: profRefs ? `${formatMoney(profRefs.creditsAvailableCents)} credit available` : "", noteCount: profile?.notes.length ?? 0, unpaid: profUnpaid,
    remind: guard(async () => {
      const open_ = profile?.billing?.openInvoices[0];
      if (open_) await api(`/teacher/invoices/${encodeURIComponent(open_.id)}/remind`, { method: "POST" });
      flash(REMIND_OFF);
    }), viewAsLabel: adult ? "View as student" : "View as family",
    isChild: !adult, acctType: adult ? "Adult student" : "Child · parent-owned", tfa: "managed by account owner",
    migratePending: false, canMigrate: true, migrate: () => { setMigrateBill("student"); open("migrate", { form: { email: "" } }); },
    resetLink: guard(async () => {
      if (!row?.accountId) return flash("This student doesn't have a portal account yet.");
      await api(`/teacher/accounts/${row.accountId}/password-reset`, { method: "POST" });
      flash(`Secure password-reset link sent to ${owner}.`);
    }),
    upcoming: lessonsSorted.filter((l) => new Date(l.startTime).getTime() >= now && (l.status === "confirmed" || l.status === "pending_payment")).slice(0, 3).map((l) => ({
      ...lessonRow(l), status: l.status === "pending_payment" ? "Unpaid" : "Booked", color: l.status === "pending_payment" ? "#9C5F22" : "#1D2A44",
      move: () => openLessonDialog(l),
      cancel: guard(async () => {
        if (!window.confirm(`Cancel the lesson on ${lessonRow(l).date} at ${lessonRow(l).time}? Nobody is notified.`)) return;
        const res = await api<{ late?: boolean; refund?: string }>(`/teacher/lessons/${l.id}/cancel`, { method: "POST", body: {} });
        await refreshAfterLessonChange();
        flash(res?.refund === "credit" ? "Lesson cancelled. The credit went back. Nobody was notified." : res?.refund === "invoice_voided" ? "Lesson cancelled and its invoice voided. Nobody was notified." : "Lesson cancelled. Nobody was notified.");
      }),
    })),
    past: lessonsSorted.filter((l) => new Date(l.startTime).getTime() < now && l.status !== "rescheduled").reverse().slice(0, 5).map((l) => {
      const cancelled = l.status === "cancelled";
      return { ...lessonRow(l), invoice: "see invoices", status: cancelled ? "Cancelled" : "Attended", color: cancelled ? "rgba(17,22,27,.45)" : "#4A6149" };
    }),
    addLesson: () => openLessonDialog(null),
    newInvoice: () => open("teacherInvoice", { form: { label: "Lesson", amount: "", dueDate: ymdInTz(new Date().toISOString()), method: "zelle" } }),
  };
  const profileNotes = (profile?.notes ?? []).map((n) => ({ date: fmtDay(n.lessonDate, { month: "short", day: "numeric", year: "numeric" }), title: n.title || "Untitled note", status: n.status === "draft" ? "Draft" : "Published", sColor: n.status === "draft" ? "#9C5F22" : "#4A6149" }));

  // ---- notes editor
  const noteBody = () => ({ studentId: note.studentId, lessonDate: note.lessonDate, title: note.title || note.summary.slice(0, 80), summary: note.summary, technique: note.technique, practice: note.practice, goals: note.goals, prep: note.prep });
  const persistNote = async () => {
    if (!note.studentId) throw new Error("Choose a student first.");
    const saved: NoteDTO = note.id ? await api(`/teacher/notes/${note.id}`, { method: "PUT", body: noteBody() }) : await api("/teacher/notes", { method: "POST", body: noteBody() });
    setNote((n) => ({ ...n, id: saved.id }));
    return saved;
  };
  const noteStudent = students.find((s) => s.id === note.studentId);

  // ---- videos
  const libVideos = videos.filter((x) => cat === "All" || x.category === cat).map((x) => ({
    title: x.title, cat: x.category, desc: x.description, dur: x.durationLabel, src: x.source === "url" ? "YouTube" : "Upload",
    srcIcon: x.source === "url" ? "ph ph-youtube-logo" : "ph ph-cloud-arrow-up",
    count: `${x.assignedCount ?? 0} ${(x.assignedCount ?? 0) === 1 ? "student" : "students"}`,
    assign: guard(async () => {
      const r = await api(`/teacher/videos/${x.id}/assignees`);
      setAssignSel(Object.fromEntries(r.studentIds.map((id: string) => [id, true])));
      setAssignVideo(x);
    }),
    edit: () => open("editVideo", { id: x.id, form: { title: x.title, desc: x.description, cat: x.category } }),
  }));
  const refreshVideos = async () => setVideos((await api("/teacher/videos")).videos);

  // ---- assignments
  const selected = Object.keys(assignees).filter((k) => assignees[k]);
  const assignments = assigns.map((a) => ({
    title: a.title,
    meta: [a.videoTitle ? `Video: ${a.videoTitle}` : "No video", a.lessonDate ? `Lesson ${fmtDay(a.lessonDate)}` : null].filter(Boolean).join(" · "),
    due: a.dueDate ? `Due ${fmtDay(a.dueDate)}` : "No due date",
    dueColor: a.dueDate && new Date(a.dueDate).getTime() - now < 3 * 864e5 ? "#9C5F22" : "rgba(17,22,27,.5)",
    people: a.students.map((p) => ({ name: p.name, dot: p.completedAt ? "#4A6149" : "#C27D38" })),
  }));

  // ---- adding students
  const openAddStudent = () => open("addStudent", { mode: "add", form: { ageCategory: "child", format: "In person" } });
  const patchForm = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));
  const guardianNote = (g: "created" | "reused" | null) =>
    g === "reused" ? "Their parent was already on file, so siblings share one billing contact." : g === "created" ? "Their parent was saved as the billing contact." : "They pay their own invoices.";
  const saveStudent = async () => {
    if (form.saving) return;
    const payload = {
      fullName: form.fullName ?? "",
      ageCategory: form.ageCategory,
      email: form.email ?? "",
      guardianName: form.guardianName ?? "",
      guardianEmail: form.guardianEmail ?? "",
      format: form.format,
    };
    const referralCode = String(form.referralCode ?? "").trim();
    const problem = studentFormError(payload);
    if (problem) return patchForm({ error: problem });
    patchForm({ saving: true, error: "" });
    try {
      const { student, guardian, referral } = await api("/teacher/students", { method: "POST", body: {
        fullName: payload.fullName.trim(),
        ageCategory: payload.ageCategory,
        email: payload.email.trim(),
        guardianName: payload.guardianName.trim(),
        guardianEmail: payload.guardianEmail.trim(),
        format: payload.format,
        ...(referralCode ? { referralCode } : {}),
      } });
      setStudents((await api("/teacher/students")).students);
      const refNote = referral === "applied" ? " Referral code applied: $15 off their first invoice." : referral === "invalid" ? " The referral code wasn't valid, so no discount was added." : "";
      patchForm({ saving: false, created: { ...student, contactNote: guardianNote(guardian) + refNote } });
    } catch (e) {
      patchForm({ saving: false, error: errorText(e) });
    }
  };

  // ---- invitations
  // Choosing a student loads what's on their record, so the details aren't typed twice.
  const chooseInvStudent = useCallback((id: string, rows: TeacherStudentRow[]) => {
    setInvStudentId(id);
    const s = rows.find((r) => r.id === id);
    if (!s) return;
    setInvRole(s.isMinor ? "Parent / guardian" : "Adult student");
    setInvEmail((s.isMinor ? s.guardianEmail : s.email) ?? "");
    setInvName(s.isMinor ? s.guardianName ?? "" : "");
  }, []);
  const appliedInviteStudent = useRef("");
  useEffect(() => {
    if (screen !== "invitations" || !stateStudent || appliedInviteStudent.current === stateStudent) return;
    if (!students.some((s) => s.id === stateStudent)) return;
    appliedInviteStudent.current = stateStudent;
    chooseInvStudent(stateStudent, students);
  }, [screen, stateStudent, students, chooseInvStudent]);
  const refreshInvites = async () => setInvites((await api("/teacher/invitations")).invitations);
  // After any send attempt the list is re-read, succeeded or not: a failed resend may have left rows changed on the server.
  const afterInviteAttempt = <T,>(attempt: Promise<T>) => attempt.finally(() => refreshInvites().catch(() => undefined));
  const inviteRows = invites.map((i) => {
    const code = i.method === "code" ? issued[i.id] : undefined;
    const link = i.method === "email" ? issued[i.id] : undefined;
    const open_ = i.status === "pending" || i.status === "code_issued";
    const actions: [string, string, () => void][] = [];
    if (open_ && code) actions.push(["Copy code", "#1D2A44", () => { copy(code); flash(`Code ${code} copied.`); }]);
    if (open_ && link) actions.push(["Copy link", "#1D2A44", () => { copy(link); flash("Invitation link copied."); }]);
    if (open_) actions.push(["Resend", "#1D2A44", guard(async () => { await afterInviteAttempt(api(`/teacher/invitations/${i.id}/resend`, { method: "POST" })); flash(`A new code was emailed to ${i.email}. The previous code no longer works.`); })]);
    if (open_) actions.push(["Revoke", "#9C5F22", guard(async () => { await api(`/teacher/invitations/${i.id}/revoke`, { method: "POST" }); await refreshInvites(); flash("Invitation revoked."); })]);
    return {
      name: i.name, email: i.email, student: i.studentName, status: invLabel[i.status] ?? i.status, sColor: invColor[i.status] ?? "#1D2A44", code,
      sent: `${fmt(i.sentAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${i.expiresAt && open_ ? ` · expires ${fmt(i.expiresAt, { month: "short", day: "numeric" })}` : ""}`,
      actions: actions.map(([label, color, run]) => ({ label, color, run })),
    };
  });
  const isAdult = invRole === "Adult student";

  // ---- invoices
  const list = invoices ?? [];
  const openInv = list.filter((i) => i.amountDue > 0 && !["paid", "void", "draft"].includes(i.status));
  const sum = (l: InvoiceDTO[], f: (i: InvoiceDTO) => number) => l.reduce((a, i) => a + f(i), 0);
  const overdue = list.filter(invoiceOverdue);
  const invoiceRows = list.filter((i) => {
    const d = invoiceDisplay(i);
    const filterOk = invFilter === "All" || (invFilter === "Open" ? openInv.includes(i) : d === invFilter);
    return filterOk && (!invQ || `${i.contactName}${i.number}${i.title}`.toLowerCase().includes(invQ.toLowerCase()));
  }).map((i) => {
    const d = invoiceDisplay(i);
    const student = students.find((s) => s.id === i.studentId);
    const colors: any = { Paid: "#4A6149", Sent: "#C27D38", Overdue: "#9C5F22", Draft: "rgba(17,22,27,.45)", Void: "rgba(17,22,27,.35)" };
    const runInvoice = (action: "send" | "remind" | "void", label: string) => guard(async () => {
      if (action === "void" && !window.confirm(`Void invoice #${i.number}? This can't be undone.`)) return;
      const res = await api<{ suppressed?: boolean }>(`/teacher/invoices/${encodeURIComponent(i.id)}/${action}`, { method: "POST", body: {} });
      loadInvoices();
      if (profile && profile.student.id === i.studentId) void loadProfile(profile.student.id);
      flash(res?.suppressed ? REMIND_OFF : action === "send" ? `Invoice #${i.number} issued. The family can see it now.` : `${label} saved.`);
    });
    const button = (label: string, color: string, action: "send" | "remind" | "void") => ({ label, color, run: runInvoice(action, label) });
    const markPaid = { label: "Mark paid", color: "#4A6149", run: () => open("markPaid", { invoice: i, form: { method: i.paymentMethod === "cash" ? "cash" : "zelle", paidAt: ymdInTz(new Date().toISOString()), reference: "" } }) };
    const actions = d === "Draft" ? [button("Issue", "#1D2A44", "send"), button("Void", "#9C5F22", "void")] : d === "Paid" || d === "Void" ? [] : [button("Remind", "#1D2A44", "remind"), markPaid, button("Void", "#9C5F22", "void")];
    const methodWord = i.paymentMethod === "cash" ? "Cash" : i.paymentMethod === "zelle" ? "Zelle" : i.paymentMethod === "card" ? "Card" : "";
    const reported = i.paymentReport?.status === "pending" && d !== "Paid" && d !== "Void";
    return {
      num: `#${i.number}`, issued: fmtDay(i.issueDate), student: student?.fullName ?? i.contactName, billedTo: i.contactName, items: methodWord ? `${i.title} · ${methodWord}` : i.title, due: fmtDay(i.dueDate), amount: `$${i.total.toLocaleString()}`, status: reported ? "Reported" : d, color: reported ? "#4A6149" : colors[d] ?? "#1D2A44", actions,
      openStudent: () => (student ? navigate(`/teacher/students/${student.id}`) : flash(`${i.contactName} isn't linked to an enrolled student.`)),
    };
  });

  // ---- calendar
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const calDays = dows.map((dow, idx) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + idx);
    const key = d.toDateString();
    const isToday = key === new Date().toDateString();
    const evs = (events ?? []).filter((e) => new Date(e.startTime).toDateString() === key).sort((a, b) => a.startTime.localeCompare(b.startTime)).map((e) => {
      const zoom = /zoom/i.test(`${e.address} ${e.title}`);
      const held = e.status === "pending_payment";
      const holdUntil = held && e.holdExpiresAt ? ` · hold until ${fmt(e.holdExpiresAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "";
      return {
        time: clock(e.startTime), name: e.studentName, meta: `${zoom ? "Zoom" : e.address || "Music City SF"}${held ? ` · Unpaid${holdUntil}` : ""}`,
        accent: zoom ? "#9C5F22" : "#1D2A44", bg: zoom ? "rgba(156,95,34,.07)" : "rgba(29,42,68,.06)", color: "#11161B", border: held ? "#9C5F22" : "transparent", borderStyle: held ? "dashed" : "solid",
        open: () => (e.studentId ? navigate(`/teacher/students/${e.studentId}`) : flash(`${e.studentName} isn't linked to an enrolled student.`)),
      };
    });
    return { dow, day: d.getDate(), events: evs, empty: evs.length === 0, hbg: isToday ? "rgba(194,125,56,.1)" : "transparent", hcolor: isToday ? "#9C5F22" : "rgba(17,22,27,.5)" };
  });
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const mon = (d: Date) => d.toLocaleString("en-US", { month: "short" });

  // ---- overview
  const pendingInv = invites.filter((i) => i.status === "pending" || i.status === "code_issued" || i.status === "expired");
  const draftCount = (overview?.recentNotes ?? []).filter((n: any) => n.status === "draft").length;
  const weekCount = events?.length ?? 0;
  const zoomCount = (events ?? []).filter((e) => /zoom/i.test(`${e.address} ${e.title}`)).length;
  const unknown = "—";
  const stats = [
    { label: "Active students", value: overview ? String(overview.studentCount) : unknown,     sub: overview ? `${overview.adultCount} adults` : "Waiting for the studio list" },
    { label: "Lessons this week", value: calError ? unknown : String(weekCount), sub: calError ? "Calendar could not be read" : `${weekCount - zoomCount} in person · ${zoomCount} Zoom` },
    { label: "Notes to publish", value: overview ? String(draftCount) : unknown, sub: "Recent drafts" },
    { label: "Pending invitations", value: overview ? String(pendingInv.length) : unknown, sub: `${pendingInv.filter((i) => i.status === "expired").length} expired` },
  ];
  const pendingReports = (reports ?? []).filter((r) => r.status === "pending");
  if (pendingReports.length) stats.push({ label: "Reported payments", value: String(pendingReports.length), sub: "Waiting for you to confirm" });
  const upcoming = (events ?? []).filter((e) => new Date(e.startTime).getTime() >= now).sort((a, b) => a.startTime.localeCompare(b.startTime)).slice(0, 4).map((e) => {
    const zoom = /zoom/i.test(`${e.address} ${e.title}`);
    return { day: fmt(e.startTime, { weekday: "short", day: "numeric" }), time: clock(e.startTime), name: e.studentName, loc: zoom ? "Zoom" : "Music City SF", icon: zoom ? "ph ph-video-camera" : "ph ph-map-pin", status: e.status === "confirmed" ? "Confirmed" : e.status === "pending_payment" ? "Unpaid" : e.status === "completed" ? "Completed" : "Pending", sColor: e.status === "confirmed" ? "#4A6149" : e.status === "pending_payment" ? "#9C5F22" : "rgba(17,22,27,.5)" };
  });

  // ---- dialogs
  const dk = dialog?.kind ?? "", dd = dialog?.data ?? {};
  const dlgTitles: any = { migrate: "Convert to adult account", enroll2fa: "Security", addStudent: "Add a student", teacherLesson: dialog?.data.lesson ? "Move lesson" : "Add a lesson", teacherInvoice: "New invoice", markPaid: dd.invoice ? `Mark invoice #${dd.invoice.number} paid` : "Mark paid", confirmReport: dd.report ? `Confirm invoice #${dd.report.invoiceNumber} payment` : "Confirm payment", upload: "Upload a video", addurl: "Add a video by URL", editVideo: "Edit video", recovery: is.twofa ? "Use a recovery code" : "Recovery codes" };
  const dlgKickers: any = { addStudent: "Students", teacherLesson: st?.fullName ?? "Lessons", teacherInvoice: st?.fullName ?? "Billing", markPaid: "Billing", confirmReport: "Reported payment", migrate: "Account transfer", enroll2fa: "Security", upload: "Video library", addurl: "Video library", editVideo: "Video library", recovery: "Security" };
  const dlg: any = { open: !!dialog, width: "520px", title: dlgTitles[dk] ?? "", kicker: dlgKickers[dk] ?? "" };
  ["addStudent", "book", "pay", "invoice", "schedule", "video", "note", "family", "upload", "addurl", "editVideo", "recovery", "packages", "enroll2fa", "migrate", "teacherLesson", "teacherInvoice", "markPaid", "confirmReport"].forEach((k) => { dlg[k] = dk === k; });
  const hasUnpaid = openInv.length > 0;
  const connected = (b?: boolean) => (b ? "Ready" : "Unavailable");
  const integrations = settings?.integrations;

  return {
    is, go, navItems, navOpen, navIcon: navOpen ? "ph ph-x" : "ph ph-list", toggleNav: () => setNavOpen((o) => !o),
    mobile: vp.mobile, notMobile: !vp.mobile, wideNav: vp.wide, shellDir: vp.mobile ? "column" : "row",
    contentRef, pageTitle: screen === "profile" ? st?.fullName ?? "Student profile" : TITLES[screen],
    nav: { canBack: screen === "profile", backLabel: "Students", back: goTo("/teacher/students") },
    today: todayLabel(), syncLabel: "Studio records", tfaLabel: sec.tfa.on ? "2FA on" : "2FA off",
    sub: { loading, default: !loading, empty: !loading && videos.length === 0, notEmpty: loading || videos.length > 0, assign: !!assignVideo, draft: note.status === "draft", published: note.status === "published" },
    apiDown,
    stats, upcoming, hasUnpaid, noUnpaid: !hasUnpaid, remindAll: () => {
      if (!hasUnpaid) return;
      return guard(async () => {
        for (const inv of openInv) await api(`/teacher/invoices/${encodeURIComponent(inv.id)}/remind`, { method: "POST" });
        flash(`Logged reminders for ${openInv.length} invoice${openInv.length === 1 ? "" : "s"}. Nothing was sent or charged.`);
      })();
    }, remindLabel: hasUnpaid ? `Remind ${openInv.length} unpaid` : "No unpaid lessons", remindOpacity: hasUnpaid ? 1 : 0.45,
    recentNotes: (overview?.recentNotes ?? []).map((n: any) => ({ name: n.studentName, date: fmtDay(n.lessonDate), title: n.title, status: n.status === "draft" ? "Draft" : "Published", sColor: n.status === "draft" ? "#9C5F22" : "#4A6149" })),
    recentVideos: (overview?.recentVideos ?? []).map((x: any) => ({ title: x.title, to: x.to, assigned: fmt(x.assignedAt, { month: "short", day: "numeric" }) })),
    cal: { days: calDays, label: `${mon(weekStart)} ${weekStart.getDate()} – ${mon(weekEnd) !== mon(weekStart) ? `${mon(weekEnd)} ` : ""}${weekEnd.getDate()}, ${weekEnd.getFullYear()}`, prev: () => setCalWeek((w) => w - 1), next: () => setCalWeek((w) => w + 1), today: () => setCalWeek(0) },
    invStats: invoiceError ? [{ label: "Invoices", value: "—", sub: invoiceError, color: "rgba(17,22,27,.6)" }] : [
      { label: "Outstanding", value: `$${sum(openInv, (i) => i.amountDue)}`, sub: `${openInv.length} open invoices`, color: "#1D2A44" },
      { label: "Overdue", value: `$${sum(overdue, (i) => i.amountDue)}`, sub: `${overdue.length} past due`, color: "#9C5F22" },
      { label: "Collected", value: `$${sum(list, (i) => i.amountPaid)}`, sub: "Recorded payments", color: "#4A6149" },
      { label: "Drafts", value: String(list.filter((i) => i.status === "draft").length), sub: "Not visible to families", color: "rgba(17,22,27,.6)" },
    ],
    invFilters: ["All", "Open", "Overdue", "Paid", "Draft"].map((f) => ({ label: f, pick: () => setInvFilter(f), bg: invFilter === f ? "#1D2A44" : "transparent", color: invFilter === f ? "#fff" : "rgba(17,22,27,.7)", border: invFilter === f ? "#1D2A44" : "rgba(17,22,27,.15)" })),
    invQ, setInvQ: (e: any) => setInvQ(e.target.value), invoiceRows,
    openAddStudent,
    noStudentsTitle: query ? `No students match “${query}”` : "No students yet", noStudentsHint: query ? "Try a different spelling, or invite a new family." : "Add a student to get started.", hasQuery: !!query,
    sf: {
      form, set: (k: string) => (e: any) => patchForm({ [k]: e.target.value }), created: form.created, saving: !!form.saving, error: form.error,
      ages: [["child", "Minor"], ["adult", "Adult"]].map(([id, label]) => ({ id, label, on: form.ageCategory === id, pick: () => patchForm({ ageCategory: id }) })),
      formats: [["In person", "In person"], ["Zoom", "Zoom"]].map(([id, label]) => ({ id, label, on: form.format === id, pick: () => patchForm({ format: id }) })),
      isChild: form.ageCategory === "child", save: saveStudent,
      inviteCreated: () => { const id = form.created.id; close(); navigate("/teacher/invitations", { state: { studentId: id } }); },
    },
    query, setQuery: (e: any) => setQuery(e.target.value), clearQuery: () => setQuery(""), filteredStudents, hasStudents: filteredStudents.length > 0, noStudents: filteredStudents.length === 0, studentCount: `${filteredStudents.length} of ${students.length} students`,
    prof, profileNotes,
    rowanVideos: (profile?.videos ?? []).map((x) => ({ title: x.title, cat: x.category, assigned: fmt(x.assignedAt, { month: "short", day: "numeric" }), wLabel: x.watchedAt ? "Watched" : "Not watched", wColor: x.watchedAt ? "#4A6149" : "#9C5F22" })),
    rowanAssign: (profile?.assignments ?? []).map((a) => ({ title: a.title, due: a.dueDate ? `Due ${fmtDay(a.dueDate)}` : "No due date", instructions: a.instructions })),
    viewAsStudent: () => st && navigate(`/portal?preview=${st.id}`),
    // Notes editor
    noteForm: note,
    noteField: (k: string) => (e: any) => setNote((n) => ({ ...n, [k]: e.target.value, ...(k === "studentId" ? { id: null, status: "draft" as const, publishedAt: null } : {}) })),
    studentOptions: students.map((s) => ({ id: s.id, name: s.fullName })),
    noteDraftLine: `Not visible to ${noteStudent?.isMinor ? "the family" : "the student"}.${savedAt ? ` Saved ${savedAt}.` : ""}`,
    notePublishedLine: note.publishedAt ? `Published · ${fmt(note.publishedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Published",
    publishLabel: note.status === "published" ? "Published" : "Publish to Student",
    saveDraft: guard(async () => {
      if (screen === "notes") {
        await persistNote();
        setSavedAt(clock(new Date().toISOString()));
        flash("Draft saved. Private to you.");
      } else flash("Assignments are saved when you assign them.");
    }),
    pickPublished: guard(async () => {
      const saved = await persistNote();
      const published: NoteDTO = await api(`/teacher/notes/${saved.id}/publish`, { method: "POST" });
      setNote((n) => ({ ...n, status: "published", publishedAt: published.publishedAt }));
      flash("Note published.");
      if (note.studentId) void loadProfile(note.studentId);
    }),
    // Videos
    libVideos, libCount: `${libVideos.length} videos`, libCols: assignVideo && !vp.mobile ? "minmax(0,1fr) 320px" : "minmax(0,1fr)",
    catChips: CATS.map((c) => ({ label: c, pick: () => setCat(c), bg: c === cat ? "#1D2A44" : "transparent", color: c === cat ? "#fff" : "rgba(17,22,27,.7)", border: c === cat ? "#1D2A44" : "rgba(17,22,27,.15)" })),
    assignTitle: assignVideo?.title ?? "", closeAssign: () => setAssignVideo(null),
    assignRows: students.map((s) => ({ name: s.fullName, meta: s.styleLine, on: !!assignSel[s.id], toggle: () => setAssignSel((a) => ({ ...a, [s.id]: !a[s.id] })) })),
    saveAssign: guard(async () => {
      if (!assignVideo) return;
      await api(`/teacher/videos/${assignVideo.id}/assignees`, { method: "PUT", body: { studentIds: Object.keys(assignSel).filter((k) => assignSel[k]) } });
      setAssignVideo(null);
      await refreshVideos();
      flash("Assignments saved. Students will see the video on their dashboard.");
    }),
    openUpload: () => { file.current = null; open("upload", { form: { cat: "Technique" } }); },
    openAddUrl: () => open("addurl", { form: { cat: "Repertoire" } }),
    pickFile: (e: any) => { file.current = e.target.files?.[0] ?? null; setForm((s: any) => ({ ...s, fileName: file.current?.name, title: s.title || file.current?.name.replace(/\.[^.]+$/, "") })); },
    doUpload: guard(async () => {
      if (!file.current) return flash("Choose a video file first.");
      const r = await api("/teacher/videos/upload", { method: "POST", body: { title: (form.title || "").trim(), category: form.cat, description: form.desc ?? "", fileName: file.current.name } });
      flash("Uploading… keep this page open.");
      const up = await fetch(r.uploadUrl, { method: "PUT", body: file.current, headers: { "Content-Type": file.current.type, "x-upsert": "false" } });
      if (!up.ok) throw new Error("The upload didn't finish. Please try again.");
      close();
      await refreshVideos();
      flash(`“${form.title}” uploaded to the library.`);
    }),
    doAddUrl: guard(async () => {
      if (!(form.url || "").trim()) return flash("Paste a video URL first.");
      await api("/teacher/videos/url", { method: "POST", body: { title: (form.title || "").trim() || "Linked video", category: form.cat, description: form.desc ?? "", url: form.url.trim() } });
      close();
      await refreshVideos();
      flash("Video added to the library.");
    }),
    saveVideo: guard(async () => {
      await api(`/teacher/videos/${dd.id}`, { method: "PUT", body: { title: form.title, category: form.cat, description: form.desc ?? "" } });
      close();
      await refreshVideos();
      flash("Video updated.");
    }),
    removeAssignments: guard(async () => {
      await api(`/teacher/videos/${dd.id}/assignees`, { method: "PUT", body: { studentIds: [] } });
      close();
      await refreshVideos();
      flash("All assignments removed from this video.");
    }),
    // Assignments
    aTitle, setATitle: (e: any) => setATitle(e.target.value), aForm, aField: (k: string) => (e: any) => setAForm((f) => ({ ...f, [k]: e.target.value })),
    videoOptions: videos.map((x) => ({ id: x.id, title: x.title })),
    assigneeChips: students.map((s) => {
      const on = !!assignees[s.id];
      return { name: s.fullName, on, icon: on ? "ph-fill ph-check-circle" : "ph ph-plus", pick: () => setAssignees((a) => ({ ...a, [s.id]: !a[s.id] })), bg: on ? "#1D2A44" : "transparent", color: on ? "#fff" : "rgba(17,22,27,.75)", border: on ? "#1D2A44" : "rgba(17,22,27,.15)" };
    }),
    assignLabel: selected.length ? `Assign to ${selected.length} ${selected.length === 1 ? "student" : "students"}` : "Assign",
    assignments, assignCount: assignments.length,
    createAssignment: guard(async () => {
      if (!selected.length) return flash("Choose at least one student.");
      if (!aTitle.trim()) return flash("Give the assignment a title.");
      await api("/teacher/assignments", { method: "POST", body: { title: aTitle.trim(), instructions: aForm.instructions, dueDate: aForm.dueDate || null, videoId: aForm.videoId || null, lessonDate: aForm.lessonDate || null, studentIds: selected } });
      setAssigns((await api("/teacher/assignments")).assignments);
      setATitle("");
      setAForm({ instructions: "", videoId: "", lessonDate: "", dueDate: "" });
      setAssignees({});
      flash(`Assigned to ${selected.length} ${selected.length === 1 ? "student." : "students."}`);
    }),
    // Invitations
    invites: inviteRows,
    invMethods: [["email", "Email a link", "ph ph-envelope-simple"], ["code", "Enrollment code", "ph ph-key"]].map(([id, label, icon]) => ({ label, icon, on: invMethod === id, pick: () => setInvMethod(id as any), bg: invMethod === id ? "#1D2A44" : "transparent", color: invMethod === id ? "#fff" : "rgba(17,22,27,.7)" })),
    invSendLabel: invMethod === "code" ? "Generate code" : "Email invitation", invSendIcon: invMethod === "code" ? "ph ph-key" : "ph ph-paper-plane-tilt",
    roleOpts: [["Parent / guardian", "A child", "ph ph-baby"], ["Adult student", "An adult", "ph ph-user"]].map(([r, label, icon]) => ({ label, icon, on: invRole === r, pick: () => setInvRole(r), bg: invRole === r ? "#1D2A44" : "transparent", color: invRole === r ? "#fff" : "rgba(17,22,27,.7)" })),
    isChild: !isAdult, isAdult, roleHint: isAdult ? "The student owns the account: they sign in, see their notes and pay their own invoices." : "The parent owns the account: they sign in, see notes and pay invoices. Siblings can share one login.",
    invEmail, setInvEmail: (e: any) => setInvEmail(e.target.value), invName, setInvName: (e: any) => setInvName(e.target.value), invStudentId, setInvStudent: (e: any) => chooseInvStudent(e.target.value, students),
    sendInvite: guard(async () => {
      const email = invEmail.trim();
      if (!email.includes("@")) return flash("Enter a valid email address.");
      const name = invName.trim();
      // An invite started from a student's row is for that student; a minor's goes to the guardian.
      const forStudent = students.find((s) => s.id === invStudentId);
      const created: InvitationDTO = await afterInviteAttempt(api("/teacher/invitations", { method: "POST", body: {
        email, ...(name ? { name } : {}),
        ...(forStudent ? { studentIds: [forStudent.id], role: forStudent.isMinor ? "guardian" : "student" } : {}),
      } }));
      const page = `${window.location.origin}/invite`;
      copy(page);
      setInvEmail("");
      setInvName("");
      setInvStudentId("");
      flash(`A one-time code was emailed to ${email}. They enter it at ${page}, then choose a password and turn on two-factor authentication.`);
    }),
    // Migrate
    migrateBilling: [["student", "The student", "Invoices go to the new adult account.", "ph ph-user"], ["parent", "Keep the parent / guardian", "The student gets their own login; invoices stay addressed to the parent.", "ph ph-users"]].map(([id, title, subtitle, icon]) => ({ title, sub: subtitle, icon, on: migrateBill === id, pick: () => setMigrateBill(id), border: migrateBill === id ? "#1D2A44" : "rgba(17,22,27,.12)", bg: migrateBill === id ? "rgba(29,42,68,.05)" : "#fff" })),
    doMigrate: () => flash("Account transfers need the billing change reviewed first. Use Zane's checklist for now."),
    // Settings
    settingsStatus: connected(integrations?.supabase), storageStatus: connected(integrations?.storage), calendarStatus: connected(integrations?.googleCalendar), emailStatus: connected(integrations?.email),
    cardStatus: settings ? (settings.cardPayments ? "On (test mode)" : "Off") : "—", safeModeOn: !!settings?.safeMode, tfaStatusWord: sec.tfa.on ? "Enabled" : "Off",
    studio: {
      loading: !studio && !studioError, error: studioError, ready: !!studio, saving: studioSaving,
      form: studio ?? { holdHours: "", rescheduleHours: "", cancelHours: "", zelle: "", zelleQr: null, timezone: TZ, hours: [] },
      pickQr: (e: any) => {
        const f: File | undefined = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        if (!QR_TYPES.includes(f.type)) return setStudioError("Use a PNG, JPEG or WebP image for the QR code.");
        if (f.size > QR_MAX_BYTES) return setStudioError("That image is over 220 KB. Use a smaller QR code image.");
        const reader = new FileReader();
        reader.onload = () => {
          const url = typeof reader.result === "string" ? reader.result : "";
          if (!/^data:image\/(png|jpeg|webp);base64,/.test(url)) return setStudioError("That file couldn't be read as an image.");
          if (url.length > QR_MAX_BYTES) return setStudioError("That image is over 220 KB. Use a smaller QR code image.");
          setStudioError("");
          setStudio((s) => (s ? { ...s, zelleQr: url } : s));
        };
        reader.onerror = () => setStudioError("That file couldn't be read.");
        reader.readAsDataURL(f);
      },
      removeQr: () => setStudio((s) => (s ? { ...s, zelleQr: null } : s)),
      weekdays: WEEKDAYS.map((label, id) => ({ id, label })),
      set: (k: keyof StudioForm) => (e: any) => setStudio((f) => (f ? { ...f, [k]: e.target.value } : f)),
      setRow: (i: number, k: keyof HourRow) => (e: any) => setStudio((f) => (f ? { ...f, hours: f.hours.map((h, j) => (j === i ? { ...h, [k]: k === "weekday" ? Number(e.target.value) : e.target.value } : h)) } : f)),
      removeRow: (i: number) => () => setStudio((f) => (f ? { ...f, hours: f.hours.filter((_, j) => j !== i) } : f)),
      addRow: () => setStudio((f) => (f ? { ...f, hours: [...f.hours, { weekday: f.hours.length ? (f.hours[f.hours.length - 1].weekday + 1) % 7 : 2, start: "15:00", end: "19:00" }] } : f)),
      save: async () => {
        if (!studio || studioSaving) return;
        const hold = Math.round(Number(studio.holdHours) * 60);
        const resched = Number(studio.rescheduleHours), cancel = Number(studio.cancelHours);
        if (!(hold >= 15 && hold <= 10080)) return setStudioError("Hold window must be between 0.25 and 168 hours.");
        if (![resched, cancel].every((n) => Number.isInteger(n) && n >= 0 && n <= 336)) return setStudioError("Notice windows must be whole hours between 0 and 336.");
        const hours = studio.hours.map((h) => ({ weekday: h.weekday, startMinute: fromHM(h.start), endMinute: fromHM(h.end) }));
        if (hours.some((h) => h.endMinute - h.startMinute < 60)) return setStudioError("Each time range must fit at least one 60-minute lesson.");
        setStudioSaving(true);
        setStudioError("");
        try {
          const r = await api("/teacher/studio", { method: "PUT", body: { holdWindowMinutes: hold, rescheduleNoticeHours: resched, cancelNoticeHours: cancel, zelleRecipient: studio.zelle.trim(), zelleQrDataUrl: studio.zelleQr, hours } });
          setStudio(studioToForm(r));
          flash("Lesson hours and policies saved.");
        } catch (e) {
          setStudioError(errorText(e));
        } finally {
          setStudioSaving(false);
        }
      },
    },
    tRefs: {
      error: refsError, loading: !teacherRefs && !refsError, ready: !!teacherRefs,
      rows: (teacherRefs?.referrals ?? []).map((r: any) => ({ who: `${r.referrer || "—"} → ${r.referred || "—"}`, meta: `Code ${r.code} · ${fmt(r.createdAt, { month: "short", day: "numeric", year: "numeric" })}${r.completedAt ? ` · paid ${fmt(r.completedAt, { month: "short", day: "numeric" })}` : ""}`, status: r.status === "completed" ? "Completed" : r.status === "pending" ? "Pending" : String(r.status ?? ""), color: r.status === "completed" ? "#4A6149" : "#C27D38" })),
      credits: (teacherRefs?.credits ?? []).map((c: any) => ({ who: c.student || "—", amount: `$${Number(c.amount ?? 0).toLocaleString()}`, status: c.used ? "Used" : "Available", color: c.used ? "rgba(17,22,27,.45)" : "#4A6149", date: fmt(c.createdAt, { month: "short", day: "numeric" }) })),
      empty: !!teacherRefs && !teacherRefs.referrals.length && !teacherRefs.credits.length,
      summary: teacherRefs ? `${teacherRefs.referrals.length} referral${teacherRefs.referrals.length === 1 ? "" : "s"} · ${teacherRefs.referrals.filter((r: any) => r.status === "completed").length} completed` : "",
    },
    recoveryLine: "Not available yet", recoveryCta: "Details",
    // Teacher lesson and invoice dialogs (Supabase only, nothing is sent)
    tl: {
      form, set: (k: string) => (e: any) => patchForm({ [k]: e.target.value, error: "" }), error: form.error, saving: !!form.saving,
      saveLabel: dd.lesson ? "Move lesson" : form.repeatWeekly ? `Add ${form.weeks || SERIES_WEEKS_DEFAULT} weekly lessons` : "Add lesson",
      isNew: !dd.lesson,
      toggleRepeat: () => patchForm({ repeatWeekly: !form.repeatWeekly }),
      weekOpts: Array.from({ length: SERIES_WEEKS_MAX - 1 }, (_, i) => i + 2),
      note: EACH_LESSON,
      locations: ["Music City SF", "Zoom"].map((id) => ({ id, label: id === "Zoom" ? "Zoom" : "In person", on: form.location === id, pick: () => patchForm({ location: id }) })),
      save: async () => {
        if (form.saving || !st) return;
        if (!form.date || !form.time) return patchForm({ error: "Choose a date and start time." });
        patchForm({ saving: true, error: "" });
        try {
          const body = { startTime: wallTimeToIso(form.date, form.time), location: form.location };
          let msg = "Lesson moved. Nobody was notified.";
          if (dd.lesson) await api(`/teacher/lessons/${dd.lesson.id}/reschedule`, { method: "POST", body });
          else {
            const weeks = Number(form.weeks) || SERIES_WEEKS_DEFAULT;
            const res = await api<{ lessons?: LessonDTO[] }>("/teacher/lessons", { method: "POST", body: { ...body, studentId: st.id, ...(form.repeatWeekly ? { repeatWeekly: true, weeks } : {}) } });
            const made = res.lessons ?? [];
            const held = made.filter((l) => l.status === "pending_payment").length;
            msg = `${made.length > 1 ? `${made.length} lessons added` : "Lesson added"}${held ? `; ${held} held until paid` : ""}. Nobody was notified.`;
          }
          close();
          await refreshAfterLessonChange();
          loadInvoices();
          flash(msg);
        } catch (e) {
          patchForm({ saving: false, error: errorText(e) });
        }
      },
    },
    ti: {
      form, set: (k: string) => (e: any) => patchForm({ [k]: e.target.value, error: "" }), error: form.error, saving: !!form.saving,
      payerLine: st ? `Billed to ${adult ? st.fullName : st.guardianName ?? "the parent"}. Saved in the portal only; nothing is emailed or charged.` : "",
      methods: [["zelle", "Zelle"], ["cash", "Cash"]].map(([id, label]) => ({ id, label, on: (form.method ?? "zelle") === id, pick: () => patchForm({ method: id }) })),
      save: async () => {
        if (form.saving || !st) return;
        const amount = Number(form.amount);
        if (!(amount > 0)) return patchForm({ error: "Enter an amount." });
        patchForm({ saving: true, error: "" });
        try {
          await api("/teacher/invoices", { method: "POST", body: { studentId: st.id, lines: [{ label: (form.label || "Lesson").trim(), amount }], method: form.method === "cash" ? "cash" : "zelle", ...(form.dueDate ? { dueDate: form.dueDate } : {}) } });
          close();
          loadInvoices();
          await loadProfile(st.id);
          flash("Invoice created. It's visible to the family now; nothing was emailed.");
        } catch (e) {
          patchForm({ saving: false, error: errorText(e) });
        }
      },
    },
    mp: {
      form, set: (k: string) => (e: any) => patchForm({ [k]: e.target.value, error: "" }), error: form.error, saving: !!form.saving,
      line: dd.invoice ? `${dd.invoice.contactName} · $${Number(dd.invoice.amountDue ?? dd.invoice.total).toLocaleString()} due` : "",
      methods: [["zelle", "Zelle"], ["cash", "Cash"]].map(([id, label]) => ({ id, label, on: form.method === id, pick: () => patchForm({ method: id }) })),
      save: async () => {
        if (form.saving || !dd.invoice) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(form.paidAt ?? "")) return patchForm({ error: "Choose the date the payment arrived." });
        patchForm({ saving: true, error: "" });
        try {
          await api(`/teacher/invoices/${encodeURIComponent(dd.invoice.id)}/mark-paid`, { method: "POST", body: { method: form.method === "cash" ? "cash" : "zelle", paidAt: form.paidAt, reference: String(form.reference ?? "").trim() } });
          close();
          loadInvoices();
          if (profile && profile.student.id === dd.invoice.studentId) void loadProfile(profile.student.id);
          setStudents((await api("/teacher/students")).students);
          flash(`Invoice #${dd.invoice.number} marked paid.${dd.invoice.kind === "package" ? " 4 lesson credits added." : ""}`);
        } catch (e) {
          patchForm({ saving: false, error: errorText(e) });
        }
      },
    },
    // Reported payments (the payer said "I've sent it"; nothing is paid until confirmed here)
    rp: {
      loading: reports === null && !reportsError, error: reportsError, all: reportsAll,
      toggleAll: () => setReportsAll((a) => !a),
      count: pendingReports.length,
      empty: !!reports && reports.length === 0 && !reportsError,
      rows: (reports ?? []).map((r) => {
        const pending = r.status === "pending";
        return {
          id: r.id, student: r.studentName, invoice: `#${r.invoiceNumber}`, memo: r.memo,
          amounts: `${r.amount != null ? `${dollars(r.amount)} reported` : "Full amount reported"} · ${dollars(r.amountDue)} due`,
          mismatch: r.amount != null && Math.abs(r.amount - r.amountDue) > 0.004,
          note: r.note, method: r.method === "zelle" ? "Zelle" : r.method,
          when: `Reported ${fmt(r.reportedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${r.reportedBy ? ` by ${r.reportedBy}` : ""}`,
          status: pending ? "Pending" : r.status === "confirmed" ? "Confirmed" : "Not received",
          color: pending ? "#C27D38" : r.status === "confirmed" ? "#4A6149" : "#9C5F22",
          pending,
          confirm: () => open("confirmReport", { report: r, form: { amount: String(r.amount ?? r.amountDue), paidAt: ymdInTz(new Date().toISOString()), reference: "" } }),
          notReceived: guard(async () => {
            if (!window.confirm(`Mark the Zelle payment for invoice #${r.invoiceNumber} as not received? The invoice stays unpaid.`)) return;
            await api(`/teacher/payment-reports/${encodeURIComponent(r.id)}/not-received`, { method: "POST", body: {} });
            loadReports();
            loadInvoices();
            if (profile && profile.student.id === r.studentId) void loadProfile(profile.student.id);
            flash(`Marked not received. Invoice #${r.invoiceNumber} is still unpaid.`);
          }),
        };
      }),
    },
    cr: {
      form, set: (k: string) => (e: any) => patchForm({ [k]: e.target.value, error: "" }), error: form.error, saving: !!form.saving,
      line: dd.report ? `${dd.report.studentName} · memo ${dd.report.memo} · ${dollars(dd.report.amountDue)} due${dd.report.amount != null ? ` · ${dollars(dd.report.amount)} reported` : ""}` : "",
      note: dd.report?.note ?? "",
      save: async () => {
        if (form.saving || !dd.report) return;
        const amount = Number(String(form.amount ?? "").replace(/[$,]/g, ""));
        if (!(amount > 0)) return patchForm({ error: "Enter the amount you received." });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(form.paidAt ?? "")) return patchForm({ error: "Choose the date the payment arrived." });
        patchForm({ saving: true, error: "" });
        try {
          const ref = String(form.reference ?? "").trim();
          await api(`/teacher/payment-reports/${encodeURIComponent(dd.report.id)}/confirm`, { method: "POST", body: { amount, paidAt: form.paidAt, ...(ref ? { reference: ref } : {}) } });
          close();
          loadReports();
          loadInvoices();
          if (profile && profile.student.id === dd.report.studentId) void loadProfile(profile.student.id);
          setStudents((await api("/teacher/students")).students);
          flash(`Payment confirmed for invoice #${dd.report.invoiceNumber}.`);
        } catch (e) {
          patchForm({ saving: false, error: errorText(e) });
        }
      },
    },
    // Dialogs
    ...sec, dlg, dv: {}, dn: {}, form, closeDialog: close, stop: (e: any) => e.stopPropagation(), hasToast: !!toast, toast,
    f: Object.fromEntries(["title", "desc", "cat", "url", "code", "email"].map((k) => [k, (e: any) => setForm((s: any) => ({ ...s, [k]: e.target.value }))])),
    openRecovery: () => open("recovery"), authTitle: "Teaching Studio", TZ, supabaseReady: !!supabase,
  };
}
