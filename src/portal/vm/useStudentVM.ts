import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { formatPackageMoney, LESSON_PACKAGES } from "../../../shared/lesson-packages";
import { OUTSTANDING_BALANCE_MESSAGE, type DashboardResponse, type InvoiceDTO, type LessonDTO, type SlotsResponse } from "../../../shared/portal-types";
import { api, ApiRequestError, errorText } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { clock, copy, fmt, fmtDay, fullDate, greeting, money, TZ, todayLabel, useToast, useViewport } from "./common";
import { useSecurity } from "./useSecurity";
import type { VM } from "./types";

const CATS = ["All", "Technique", "Repertoire", "Practice Exercises", "Music Theory", "Additional Resources"];
const packageCard = (id: string) => {
  const item = LESSON_PACKAGES.find((pkg) => pkg.id === id) ?? LESSON_PACKAGES[1];
  return {
    ...item,
    price: formatPackageMoney(item.amountCents),
    list: formatPackageMoney(item.listCents),
    save: formatPackageMoney(item.saveCents),
    per: `${formatPackageMoney(Math.round(item.amountCents / item.lessons))} / lesson`,
  };
};
const NOT_ACTIVE = "This option isn't available yet. Ask Zane if you'd like it.";
const pad = (n: number) => String(n).padStart(2, "0");
const statusWord: Record<string, string> = { sent: "Unpaid", overdue: "Overdue", partially_paid: "Partially paid", payment_processing: "Processing", paid: "Paid", void: "Void" };

function nextView(lesson: LessonDTO | undefined) {
  if (!lesson) return { date: "No lesson booked", time: "—", loc: "—", locSub: "", status: "Not booked", icon: "ph ph-calendar-blank" };
  return {
    date: fullDate(lesson.startTime),
    time: `${clock(lesson.startTime)} – ${clock(lesson.endTime)}`,
    loc: lesson.locationLabel,
    locSub: lesson.locationSub,
    status: lesson.status === "confirmed" ? "Confirmed" : lesson.status.charAt(0).toUpperCase() + lesson.status.slice(1),
    icon: lesson.isZoom ? "ph ph-video-camera" : "ph ph-map-pin",
  };
}

export function useStudentVM(screen: { readOnlyStudentId?: string | null } = {}): VM {
  const { me, signOut, refresh: refreshMe } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const vp = useViewport();
  const { toast, flash } = useToast();
  const previewId = screen.readOnlyStudentId ?? null;

  const [childId, setChildId] = useState<string | null>(previewId);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<{ kind: string; data: any } | null>(null);
  const [form, setForm] = useState<any>({});
  const [openNote, setOpenNote] = useState(-1);
  const [refNotice, setRefNotice] = useState("");
  const [cat, setCat] = useState("All");
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [booking, setBooking] = useState(false);
  const [rsLesson, setRsLesson] = useState<LessonDTO | null>(null);
  const [bkLoc, setBkLoc] = useState("Music City SF");
  const [bkMonth, setBkMonth] = useState(0);
  const [bkDay, setBkDay] = useState<string | null>(null);
  const [bkSlot, setBkSlot] = useState<string | null>(null);
  const [slots, setSlots] = useState<SlotsResponse | null>(null);
  const [slotError, setSlotError] = useState("");
  const [refEmail, setRefEmail] = useState("");
  const [pkgStep, setPkgStep] = useState(1);
  const [pkgChoice, setPkgChoice] = useState<string>(LESSON_PACKAGES[1].id);
  const [repeatWeekly, setRepeatWeekly] = useState(false);

  const close = useCallback(() => setDialog(null), []);
  const open = useCallback((kind: string, d: any = {}) => {
    setDialog({ kind, data: d });
    setForm(d.form ?? {});
    setMenuOpen(false);
  }, []);
  const sec = useSecurity(flash, useCallback(() => open("enroll2fa"), [open]));

  const load = useCallback(async () => {
    try {
      const q = childId ? `?studentId=${childId}` : "";
      setData(await api<DashboardResponse>(`/portal/dashboard${q}`));
      setLoadError("");
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [childId]);
  useEffect(() => { void load(); }, [load]);
  // Back from the Stripe tab: re-read status from the server. Only the server can report a payment.
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [load]);

  const student = data?.student ?? null;
  const readOnly = !!data?.readOnly;

  // Available lesson times for the month in view
  const monthBase = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + bkMonth, 1));
  }, [bkMonth]);
  const dialogKind = dialog?.kind;
  useEffect(() => {
    if (dialogKind !== "book" || !student) return;
    let live = true;
    const y = monthBase.getUTCFullYear(), m = monthBase.getUTCMonth();
    const today = new Date().toISOString().slice(0, 10);
    const first = `${y}-${pad(m + 1)}-01`;
    const from = first < today ? today : first;
    const to = `${y}-${pad(m + 1)}-${pad(new Date(Date.UTC(y, m + 1, 0)).getUTCDate())}`;
    setSlots(null);
    setSlotError("");
    api<SlotsResponse>(`/lessons/slots?studentId=${student.id}&from=${from}&to=${to}`)
      .then((s) => {
        if (!live) return;
        setSlots(s);
        setBkDay(Object.keys(s.days).filter((d) => s.days[d].length).sort()[0] ?? null);
        setBkSlot(null);
      })
      .catch((e) => live && setSlotError(errorText(e)));
    return () => { live = false; };
  }, [dialogKind, student?.id, monthBase]);

  const billing = data?.billing ?? null;
  const unpaid = !!billing?.bookingBlocked;
  const paid = !!billing && !billing.bookingBlocked;
  const kidNextLesson = data?.upcoming[0];

  const openBook = () => {
    if (readOnly) return flash("Actions are disabled in teacher preview.");
    setRsLesson(null);
    setBkMonth(0);
    setDialog({ kind: "book", data: {} });
    setMenuOpen(false);
  };
  const openRescheduleFlow = () => {
    if (readOnly) return flash("Actions are disabled in teacher preview.");
    setRsLesson(null);
    setBkMonth(0);
    setDialog({ kind: "reschedule", data: {} });
    setMenuOpen(false);
  };
  const openReschedule = (lesson?: LessonDTO) => {
    if (readOnly) return flash("Actions are disabled in teacher preview.");
    if (!lesson || new Date(lesson.startTime).getTime() <= Date.now()) return flash("That lesson has already happened. Book a new one instead.");
    setRsLesson(lesson);
    setRepeatWeekly(false);
    setBkMonth(0);
    setDialog({ kind: "book", data: {} });
  };
  const confirmBooking = async () => {
    if (!bkSlot || !student) return flash("Choose a time first.");
    if (booking) return;
    setBooking(true);
    try {
      const body = { studentId: student.id, startTime: bkSlot, location: bkLoc, repeatWeekly: repeatWeekly && !rsLesson };
      if (rsLesson) await api(`/lessons/${rsLesson.id}/reschedule`, { method: "POST", body });
      else await api("/lessons", { method: "POST", body });
      const booked = rsLesson ? `Lesson moved to ${fullDate(bkSlot)} at ${clock(bkSlot)}.` : repeatWeekly ? `Weekly lessons booked from ${fullDate(bkSlot)} at ${clock(bkSlot)}. Notifications stay off in preview.` : `Lesson booked: ${fullDate(bkSlot)} at ${clock(bkSlot)}.`;
      flash(booked);
      close();
      setRsLesson(null);
      await load();
    } catch (e) {
      flash(errorText(e));
      if (e instanceof ApiRequestError && e.code === "outstanding_balance") {
        close();
        await load();
      }
    } finally {
      setBooking(false);
    }
  };

  // Invoice shown in the pay and invoice dialogs
  const allInvoices: InvoiceDTO[] = billing?.history ?? [];
  const firstOpen = billing?.openInvoices[0];
  const lastPaid = allInvoices.find((i) => i.status === "paid");
  const selected = allInvoices.find((i) => i.id === invoiceId) ?? firstOpen ?? allInvoices[0];
  const selectedOpen = !!selected && billing?.openInvoices.some((i) => i.id === selected.id);

  const payNow = async (e?: any) => {
    e?.preventDefault?.();
    if (readOnly) return flash("Actions are disabled in teacher preview.");
    const target = selectedOpen ? selected : firstOpen;
    if (!target || paying) return;
    setPaying(true); // blocks a second request while the first is in flight
    try {
      const sent = await api<{ suppressed?: boolean }>(`/invoices/${target.id}/send-payment-link`, { method: "POST" });
      close();
      flash(sent?.suppressed
        ? "Safe mode is on, so no email or text was sent. The payment link was only written to the server log."
        : "Your payment link is on its way to your email. Your balance updates here once the payment clears.");
    } catch (err) {
      flash(errorText(err));
    } finally {
      setPaying(false);
    }
  };

  const hoursUntilNext = kidNextLesson ? (new Date(kidNextLesson.startTime).getTime() - Date.now()) / 36e5 : 0;
  const rsAllowed = !!kidNextLesson && hoursUntilNext > 24 && !readOnly && !!data?.canBook;
  const next = nextView(kidNextLesson);
  const rs = {
    mode: !!rsLesson,
    notMode: !rsLesson,
    allowed: rsAllowed,
    locked: !!kidNextLesson && hoursUntilNext <= 24,
    allowedNote: rsAllowed,
    note: "Free to reschedule until 24 hours before the lesson.",
    current: rsLesson ? `${fullDate(rsLesson.startTime)} at ${clock(rsLesson.startTime)}` : "",
    open: () => openReschedule(kidNextLesson),
    choices: (data?.upcoming ?? []).filter((lesson) => new Date(lesson.startTime).getTime() > Date.now() && lesson.status !== "cancelled").map((lesson) => ({
      id: lesson.id,
      date: fullDate(lesson.startTime),
      time: `${clock(lesson.startTime)} – ${clock(lesson.endTime)}`,
      loc: lesson.locationLabel,
      pick: () => openReschedule(lesson),
    })),
  };

  const notes = [...(data?.notes ?? [])].sort((a, b) => b.lessonDate.localeCompare(a.lessonDate)).map((n, i) => ({
    ...n,
    date: fmtDay(n.lessonDate),
    preview: (n.summary || n.title || "").split("\n")[0].slice(0, 140),
    open: openNote === i,
    caret: openNote === i ? "ph ph-caret-up" : "ph ph-caret-down",
    toggle: () => setOpenNote(openNote === i ? -1 : i),
  }));
  const invoiceLookup = (lesson: LessonDTO) => {
    const day = fmt(lesson.startTime, { year: "numeric", month: "2-digit", day: "2-digit" });
    const note = data?.notes.find((n) => fmtDay(n.lessonDate, { year: "numeric", month: "2-digit", day: "2-digit" }) === day);
    return note;
  };
  const history = (data?.history ?? []).map((l) => {
    const note = invoiceLookup(l);
    const cancelled = /cancel|noshow/i.test(l.status);
    const st = cancelled ? "Cancelled" : "Attended";
    return {
      date: fmt(l.startTime, { month: "short", day: "numeric", year: "numeric" }),
      dur: cancelled ? "—" : `${Math.round((new Date(l.endTime).getTime() - new Date(l.startTime).getTime()) / 60000)} min`,
      status: st,
      sColor: st === "Attended" ? "#4A6149" : "rgba(17,22,27,.5)",
      note: note ? "View note" : "—",
      invoice: "—",
      open: () => (note ? open("note", { note: { ...note, date: fmtDay(note.lessonDate) } }) : flash("No note was published for this lesson.")),
    };
  });
  const videos = (data?.videos ?? []).filter((x) => cat === "All" || x.category === cat).map((x) => {
    const watched = !!x.watchedAt;
    return {
      title: x.title,
      cat: x.category,
      desc: x.description,
      dur: x.durationLabel,
      assigned: fmt(x.assignedAt, { month: "short", day: "numeric" }),
      wLabel: watched ? "Watched" : "Not watched",
      wColor: watched ? "#4A6149" : "#9C5F22",
      wIcon: watched ? "ph-fill ph-check-circle" : "ph ph-circle",
      watch: () => {
        open("video", { video: x });
        if (student && !readOnly) void api(`/videos/${x.id}/watched`, { method: "POST", body: { studentId: student.id } }).then(load).catch(() => undefined);
      },
    };
  });

  const days = Object.keys(slots?.days ?? {}).filter((d) => slots!.days[d].length).sort();
  const dayLabel = bkDay ? fmtDay(bkDay, { weekday: "short", month: "short", day: "numeric" }) : "No open dates";
  const bk = {
    locOpts: [["Music City SF", "ph ph-map-pin"], ["Zoom", "ph ph-video-camera"]].map(([l, icon]) => ({
      label: l, icon, on: bkLoc === l, pick: () => setBkLoc(l), bg: bkLoc === l ? "#1D2A44" : "transparent", color: bkLoc === l ? "#fff" : "rgba(17,22,27,.7)",
    })),
    dates: Array.from({ length: 16 }, (_, i) => {
      const d = days[i];
      if (!d) return { dow: "", day: "", blank: true, vis: "hidden", cursor: "default", border: "transparent", bg: "transparent", color: "transparent", pick: () => {} };
      const on = d === bkDay;
      return {
        dow: fmtDay(d, { weekday: "short" }), day: Number(d.slice(8)), blank: false, vis: "visible", cursor: "pointer", on,
        pick: () => { setBkDay(d); setBkSlot(null); },
        border: on ? "#1D2A44" : "rgba(17,22,27,.12)", bg: on ? "#1D2A44" : "#fff", color: on ? "#fff" : "#1D2A44",
      };
    }),
    times: (bkDay ? slots?.days[bkDay] ?? [] : []).map((iso) => {
      const on = bkSlot === iso;
      return { label: clock(iso), taken: false, on, pick: () => setBkSlot(iso), border: on ? "#1D2A44" : "rgba(17,22,27,.12)", bg: on ? "#1D2A44" : "#fff", color: on ? "#fff" : "#1D2A44", cursor: "pointer", deco: "none" };
    }),
    dateLabel: slotError ? "unavailable" : !slots ? "Loading…" : dayLabel,
    monthLabel: "Date · " + new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(monthBase),
    noPrev: bkMonth === 0,
    prevOpacity: bkMonth === 0 ? 0.4 : 1,
    prevMonth: () => setBkMonth((m) => Math.max(0, m - 1)),
    nextMonth: () => setBkMonth((m) => Math.min(6, m + 1)),
    recurring: repeatWeekly,
    toggleRecurring: () => setRepeatWeekly((on) => !on),
    confirmLabel: booking ? "Saving…" : rsLesson ? "Confirm new time" : "Confirm lesson",
    summary: slotError || (bkSlot && student ? `${student.firstName} · ${dayLabel} · ${clock(bkSlot)} · ${bkLoc}` : "Choose a date and time"),
    confirm: confirmBooking,
  };

  const invView = selected
    ? {
        issued: fmtDay(selected.issueDate, { month: "short", day: "numeric", year: "numeric" }),
        due: fmtDay(selected.dueDate, { month: "short", day: "numeric", year: "numeric" }),
        status: statusWord[selected.status] ?? selected.status,
        color: selected.status === "paid" ? "#4A6149" : "#9C5F22",
        total: money(selected.total),
        lines: selected.lines.map((l) => ({ label: l.label, amount: money(l.amount) })),
      }
    : { issued: "—", due: "—", status: "No invoices yet", color: "rgba(17,22,27,.5)", total: "$0.00", lines: [] };

  const overdueDays = firstOpen?.dueDate ? Math.floor((Date.now() - new Date(firstOpen.dueDate).getTime()) / 864e5) : 0;
  const bal = {
    unavailable: !billing && !loading,
    amount: money(billing?.outstanding ?? 0),
    number: firstOpen?.number ?? "",
    items: firstOpen?.lines.map((l) => l.label).join(", ") || firstOpen?.title || "",
    due: fmtDay(firstOpen?.dueDate, { month: "long", day: "numeric", year: "numeric" }),
    statusLabel: firstOpen ? statusWord[firstOpen.status] ?? firstOpen.status : "",
    statusLine: overdueDays > 0 ? `Overdue · ${overdueDays} day${overdueDays === 1 ? "" : "s"}` : "Due now",
    hasLast: !!lastPaid,
    lastAmount: lastPaid ? money(lastPaid.amountPaid || lastPaid.total) : "",
    lastDate: fmtDay(lastPaid?.issueDate),
    lastNumber: lastPaid?.number ?? "",
  };

  const acctMe = me?.account;
  const familyRows = [
    { initials: acctMe?.initials ?? "", name: acctMe?.ownerFull ?? "", meta: `${acctMe?.email ?? ""} · account owner`, role: me?.user.role === "guardian" ? "Parent" : "Student" },
    ...(data?.students ?? []).filter((s) => s.fullName !== acctMe?.ownerFull).map((s) => ({ initials: s.firstName[0] ?? "", name: s.fullName, meta: s.styleLine, role: "Student" })),
  ];
  const acct = {
    label: acctMe?.label ?? "",
    owner: acctMe?.ownerFirst ?? "",
    ownerFull: acctMe?.ownerFull ?? "",
    email: acctMe?.email ?? "",
    initials: acctMe?.initials ?? "",
    menuLabel: acctMe?.isFamily ? "Profile & family" : "Profile",
    familyNote: acctMe?.isFamily ? "To add a family member or change contact details," : "To change your contact details or add a family member,",
  };
  const empty = !loading && !!data && (!student || (!data.notes.length && !data.videos.length && !data.history.length));
  const sub = { loading, notLoading: !loading, empty, normal: !loading && !empty && !!data, default: !loading };
  const firstName = student?.firstName ?? "your student";

  const ob = (() => {
    const items = [
      { title: "Confirm your details", sub: student ? `${student.fullName} · ${student.styleLine}` : "Zane is finishing your setup.", done: !!student },
      { title: "Turn on two-factor authentication", sub: "A six-digit code from your phone each time you sign in.", done: sec.tfa.on, cta: "Turn on", go: sec.tfa.open },
    ].map((t: any) => ({ ...t, todo: !t.done, doneFlag: t.done, icon: t.done ? "ph-fill ph-check-circle" : "ph ph-circle", iconColor: t.done ? "#4A6149" : "rgba(17,22,27,.3)", color: t.done ? "rgba(17,22,27,.5)" : "#11161B" }));
    const n = items.filter((t) => t.done).length;
    return {
      items,
      progress: `${n} of ${items.length} complete`,
      headline: kidNextLesson ? `Welcome, ${acct.owner}. ${firstName}'s first lesson is ${next.date.split(", ")[1]}` : `Let's book ${firstName}'s first lesson`,
      sub: "Notes, practice videos and lesson history will appear here after each lesson.",
    };
  })();

  const d = dialog, dk = d?.kind ?? "", dd = d?.data ?? {};
  const dv = dd.video ? { id: dd.video.id, title: dd.video.title, cat: dd.video.category, desc: dd.video.description, dur: dd.video.durationLabel, assigned: fmt(dd.video.assignedAt, { month: "short", day: "numeric" }), watchedMarked: !readOnly } : {};
  const dn = dd.note ?? {};
  const dlgTitles: any = { enroll2fa: "Security", autopay: "Set up auto-pay", reschedule: "Move a lesson", book: rsLesson ? "Reschedule your lesson" : "Book a lesson with Zane", pay: `Pay invoice #${firstOpen?.number ?? ""}`, invoice: selected ? `Invoice #${selected.number}` : "Invoices", schedule: `${firstName}'s upcoming lessons`, video: dv.title, note: `${dn.date ?? ""} — ${firstName}`, family: acctMe?.isFamily ? "Family & profile" : "Profile", recovery: "Recovery codes", packages: pkgStep === 2 ? "Review and pay" : "Buy a lesson package" };
  const dlgKickers: any = { enroll2fa: "Security", autopay: "Recurring payments", reschedule: "Scheduling", book: "Scheduling", pay: "Secure payment", invoice: "Billing", schedule: "Schedule", video: dv.cat, note: "Teacher note", family: acct.label, recovery: "Security", packages: "Lesson packages" };
  const dlg: any = { open: !!d, width: dk === "book" ? "860px" : dk === "note" ? "640px" : dk === "packages" ? "560px" : "520px", title: dlgTitles[dk] ?? "", kicker: dlgKickers[dk] ?? "" };
  ["book", "reschedule", "pay", "invoice", "schedule", "video", "note", "family", "upload", "addurl", "editVideo", "recovery", "packages", "autopay", "enroll2fa", "migrate"].forEach((k) => { dlg[k] = dk === k; });

  const features = me?.features;
  const autopayOn = !!data?.autopayEnabled;
  const ap = {
    on: autopayOn, off: !autopayOn, status: autopayOn ? "Saved" : "Off", color: autopayOn ? "#4A6149" : "rgba(17,22,27,.45)", btn: autopayOn ? "Turn off" : "Turn on",
    line: autopayOn ? "Preference saved for preview. No card was charged." : "Save autopay for preview. No card is charged.",
    schedule: "your lessons", nextCharge: "your next lesson",
    intro: "Preview saves this choice only. Stripe test mode is logged, and no payment method is charged.",
  };
  const selectedPackage = packageCard(pkgChoice);
  const sched = (data?.upcoming ?? []).map((l, i) => ({
    date: fmt(l.startTime, { weekday: "short", month: "short", day: "numeric" }),
    time: `${clock(l.startTime)} – ${clock(l.endTime)}`,
    loc: l.locationLabel,
    status: i === 0 && unpaid ? "Unpaid" : "Booked",
    color: i === 0 && unpaid ? "#9C5F22" : "#1D2A44",
  }));

  return {
    is: { student: true, twofa: false, settings: false },
    sub, unpaid: unpaid && !loading, paid: paid && !loading, bal, loadError,
    today: todayLabel(), greeting: greeting(), historySince: history.length ? `Since ${history[history.length - 1].date}` : "No lessons yet",
    mobile: vp.mobile, notMobile: !vp.mobile,
    cols: vp.width >= 1000 ? { nextSpan: "span 2", balSpan: "auto" } : { nextSpan: "1/-1", balSpan: "1/-1" },
    menuOpen, toggleMenu: () => setMenuOpen((o) => !o),
    acct, kid: { name: firstName, full: student?.fullName ?? "", style: student?.styleLine ?? "", next, noteCount: notes.length, notes, history },
    kidTabs: (data?.students ?? []).map((s) => ({ label: s.firstName, pick: () => { setChildId(s.id); setOpenNote(0); }, bg: s.id === student?.id ? "#1D2A44" : "transparent", color: s.id === student?.id ? "#fff" : "rgba(17,22,27,.7)" })),
    multiKids: (data?.students.length ?? 0) > 1,
    kidVideos: videos,
    catChips: CATS.map((c) => ({ label: c, pick: () => setCat(c), bg: c === cat ? "#1D2A44" : "transparent", color: c === cat ? "#fff" : "rgba(17,22,27,.7)", border: c === cat ? "#1D2A44" : "rgba(17,22,27,.15)" })),
    showWatched: true,
    ...sec,
    tfa: { ...sec.tfa, banner: !sec.tfa.on && !readOnly && !loading },
    ob, rs, bk, ap, dlg, dv, dn, inv: invView, sched, form, familyRows,
    hasLessonCal: false, noLessonCal: true, lessonCalUrl: "",
    invoiceHistory: allInvoices.map((i) => ({ id: i.id, number: i.number, date: fmtDay(i.issueDate), amount: money(i.total), status: statusWord[i.status] ?? i.status, on: i.id === selected?.id, pick: () => setInvoiceId(i.id) })),
    paymentUnavailable: !loading && !billing,
    // Each recorded payment, newest first, from Supabase.
    paymentHistory: (billing?.payments ?? []).map((p) => ({ id: p.id, number: p.invoiceNumber, date: fmtDay(p.paidAt.slice(0, 10)), amount: money(p.amount), status: "Paid" })),
    referralCode: student ? `SFTM-${student.id.replace(/-/g, "").slice(0, 8).toUpperCase()}` : "",
    f: Object.fromEntries(["title", "desc", "cat", "url", "code", "email"].map((k) => [k, (e: any) => setForm((s: any) => ({ ...s, [k]: e.target.value }))])),
    openBook, openReschedule: openRescheduleFlow, openPay: () => open("pay"), openInvoice: () => { setInvoiceId(null); open("invoice"); }, openSchedule: () => open("schedule"), openFamily: () => open("family"),
    openAutopay: () => open("autopay"), openRecovery: () => open("recovery"),
    closeDialog: close, stop: (e: any) => e.stopPropagation(), hasToast: !!toast, toast,
    payUrl: selected?.payUrl && /^https:\/\//i.test(selected.payUrl) ? selected.payUrl : "",
    payNote: !billing ? "" : billing.paymentsOpen === false ? "The portal doesn't take payments yet. Please pay Zane directly; your balance updates once it's recorded." : (selected?.payUrl && /^https:\/\//i.test(selected.payUrl) ? "" : "This invoice doesn't include a payment link yet."),
    payNow, autopayUrl: "#",
    enableAutopay: (e: any) => {
      e?.preventDefault?.();
      if (readOnly) return flash("Actions are disabled in teacher preview.");
      if (!student) return;
      void api<{ checkoutUrl?: string | null }>("/autopay", { method: "POST", body: { studentId: student.id, enabled: !autopayOn } })
        .then((res) => {
          if (res.checkoutUrl) {
            window.location.assign(res.checkoutUrl);
            return;
          }
          flash(autopayOn ? "Autopay preference cleared. Nothing was charged." : "Autopay preference saved. Nothing was charged.");
          return load();
        })
        .catch((err) => flash(errorText(err)));
    },
    disableAutopay: () => {
      if (!student || readOnly) return close();
      void api("/autopay", { method: "POST", body: { studentId: student.id, enabled: false } }).then(() => load()).finally(close);
    },
    downloadInvoice: () => flash("Invoice PDFs are available from your emailed invoice for now."),
    pkgLive: !!features?.packages, pkgSoon: false, pkgBtnLabel: "Buy a package",
    pkgCreditLine: `${data?.packageLessons ?? 0} lesson credits.`,
    openPackages: () => { setPkgStep(1); open("packages"); },
    pkg: {
      step1: pkgStep === 1, step2: pkgStep === 2, step3: pkgStep === 3, sel: selectedPackage, targetLabel: student?.fullName ?? acct.label,
      next: () => setPkgStep(2), back: () => setPkgStep(1),
      pay: () => {
        if (readOnly) return flash("Actions are disabled in teacher preview.");
        if (!student) return;
        void api<{ lessonsRemaining: number }>("/packages/purchase", { method: "POST", body: { studentId: student.id, packageId: selectedPackage.id } })
          .then((res) => { setPkgStep(3); flash(`Logged only. ${res.lessonsRemaining} lesson credits are on the account. Nothing was charged.`); return load(); })
          .catch((err) => flash(errorText(err)));
      },
    },
    pkgCards: LESSON_PACKAGES.map((item) => packageCard(item.id)).map((p) => ({
      ...p,
      on: p.id === pkgChoice,
      pick: () => setPkgChoice(p.id),
      bg: p.id === pkgChoice ? "rgba(29,42,68,.05)" : p.popular ? "rgba(224,163,99,.16)" : "#fff",
      border: p.id === pkgChoice ? "#1D2A44" : p.popular ? "#E0A363" : "rgba(17,22,27,.12)",
    })),
    pkgTargets: [],
    ref: {
      inactive: false, notice: refNotice, code: student ? `SFTM-${student.id.replace(/-/g, "").slice(0, 8).toUpperCase()}` : "SFTM-PORTAL", rows: [], empty: true, earned: "$0", hasCredit: false, credit: "$0", email: refEmail,
      setEmail: (e: any) => setRefEmail(e.target.value),
      copyCode: () => { const code = student ? `SFTM-${student.id.replace(/-/g, "").slice(0, 8).toUpperCase()}` : ""; copy(code); flash("Referral code copied."); },
      copyLink: () => { copy(`${window.location.origin}/invite`); flash("Portal link copied."); },
      send: () => {
        if (readOnly) return flash("Actions are disabled in teacher preview.");
        if (!student || !refEmail.trim()) return flash("Enter an email address.");
        void api<{ allowlisted: boolean; emailed: boolean }>("/referrals/invite", { method: "POST", body: { email: refEmail.trim(), studentId: student.id } })
          .then((res) => {
            const notice = res.emailed
              ? `Referral email sent to ${refEmail}.`
              : res.allowlisted
                ? "The referral was logged, not emailed. SMTP isn't set on this preview yet."
                : "The referral was logged. Safe mode only emails the allowlist.";
            setRefNotice(notice);
            flash(notice);
          })
          .catch((err) => flash(errorText(err)));
      },
    },
    viewAs: readOnly,
    backToProfile: () => navigate(previewId ? `/teacher/students/${previewId}` : "/teacher"),
    backToTeacher: () => navigate("/teacher"),
    go: { signin: () => void signOut().then(() => navigate("/signin")) },
    refreshMe, params, copy, TZ, OUTSTANDING_BALANCE_MESSAGE,
  };
}
