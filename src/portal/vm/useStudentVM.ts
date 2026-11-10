import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { formatMoney, PACKAGE_LESSONS, PACKAGE_PRICE_CENTS, REFERRAL_DISCOUNT_CENTS, REFERRER_CREDIT_CENTS, SERIES_WEEKS_DEFAULT, SERIES_WEEKS_MAX, SESSION_PRICE_CENTS, type PackageMethod } from "../../../shared/pricing";
import { OUTSTANDING_BALANCE_MESSAGE, type DashboardResponse, type InvoiceDTO, type LessonDTO, type SlotsResponse } from "../../../shared/portal-types";
import { api, ApiRequestError, errorText } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { clock, copy, fmt, fmtDay, fullDate, greeting, money, TZ, todayLabel, useToast, useViewport } from "./common";
import { useSecurity } from "./useSecurity";
import type { VM } from "./types";

const CATS = ["All", "Technique", "Repertoire", "Practice Exercises", "Music Theory", "Additional Resources"];
const PREVIEW_OFF = "Actions are disabled in teacher preview.";
const SESSION_PRICE = formatMoney(SESSION_PRICE_CENTS);
const EACH_LESSON = `Each lesson uses a credit or creates its own ${SESSION_PRICE} invoice.`;
const METHOD_LABEL: Record<PackageMethod, string> = { zelle: "Zelle", cash: "Cash (paid up front)", card: "Card" };
const pad = (n: number) => String(n).padStart(2, "0");
const statusWord: Record<string, string> = { sent: "Awaiting payment", overdue: "Overdue", partially_paid: "Partially paid", payment_processing: "Processing", paid: "Paid", void: "Void", draft: "Draft" };
const lessonWord = (l: LessonDTO) => (l.status === "pending_payment" ? "Awaiting payment" : l.status === "confirmed" ? "Confirmed" : l.status.charAt(0).toUpperCase() + l.status.slice(1).replace(/_/g, " "));
const holdLine = (l: LessonDTO) => (l.status === "pending_payment" && l.holdExpiresAt ? `Held until ${fmt(l.holdExpiresAt, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "");

function nextView(lesson: LessonDTO | undefined) {
  if (!lesson) return { date: "No lesson booked", time: "—", loc: "—", locSub: "", status: "Not booked", icon: "ph ph-calendar-blank", held: false, hold: "", badgeColor: "rgba(17,22,27,.55)", badgeBg: "rgba(17,22,27,.04)", badgeBorder: "rgba(17,22,27,.12)", badgeIcon: "ph ph-calendar-blank" };
  const held = lesson.status === "pending_payment";
  return {
    date: fullDate(lesson.startTime),
    time: `${clock(lesson.startTime)} – ${clock(lesson.endTime)}`,
    loc: lesson.locationLabel,
    locSub: lesson.locationSub,
    status: lessonWord(lesson),
    icon: lesson.isZoom ? "ph ph-video-camera" : "ph ph-map-pin",
    held,
    hold: holdLine(lesson),
    badgeColor: held ? "#9C5F22" : "#4A6149",
    badgeBg: held ? "rgba(194,125,56,.08)" : "rgba(74,97,73,.1)",
    badgeBorder: held ? "rgba(194,125,56,.35)" : "rgba(74,97,73,.2)",
    badgeIcon: held ? "ph-fill ph-hourglass" : "ph-fill ph-check-circle",
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
  const [refCodeInput, setRefCodeInput] = useState("");
  const [pkgStep, setPkgStep] = useState(1);
  const [pkgMethod, setPkgMethod] = useState<PackageMethod>("zelle");
  const [pkgResult, setPkgResult] = useState<{ invoice: InvoiceDTO; instructions: string[]; existing: boolean } | null>(null);
  const [pkgBusy, setPkgBusy] = useState(false);
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [bkWeeks, setBkWeeks] = useState(SERIES_WEEKS_DEFAULT);
  const [bkResult, setBkResult] = useState<{ count: number; held: number; hold: string; instructions: string[] } | null>(null);
  const [slotTick, setSlotTick] = useState(0);
  const [payInfo, setPayInfo] = useState<{ invoiceId: string; instructions: string[]; error?: string } | null>(null);

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
  }, [dialogKind, student?.id, monthBase, slotTick]);

  const billing = data?.billing ?? null;
  const unpaid = !!billing?.bookingBlocked;
  const paid = !!billing && !billing.bookingBlocked;
  const kidNextLesson = data?.upcoming[0];
  const policy = data?.policy ?? null;
  const rescheduleHours = policy?.rescheduleNoticeHours ?? 24;
  const cancelHours = policy?.cancelNoticeHours ?? 24;
  const zelleTo = policy?.zelleRecipient || "Zane";
  const credits = data?.packageLessons ?? 0;
  const cardOn = !!me?.features?.cardPayments;
  const hoursUntil = (l: LessonDTO) => (new Date(l.startTime).getTime() - Date.now()) / 36e5;

  const openBook = () => {
    if (readOnly) return flash(PREVIEW_OFF);
    setRsLesson(null);
    setBkResult(null);
    setBkMonth(0);
    setDialog({ kind: "book", data: {} });
    setMenuOpen(false);
  };
  const openRescheduleFlow = () => {
    if (readOnly) return flash(PREVIEW_OFF);
    setRsLesson(null);
    setBkMonth(0);
    setDialog({ kind: "reschedule", data: {} });
    setMenuOpen(false);
  };
  const openReschedule = (lesson?: LessonDTO) => {
    if (readOnly) return flash(PREVIEW_OFF);
    if (!lesson || new Date(lesson.startTime).getTime() <= Date.now()) return flash("That lesson has already happened. Book a new one instead.");
    if (hoursUntil(lesson) < rescheduleHours) return flash(`Lessons can't be moved within ${rescheduleHours} hours of the start. Please contact Zane.`);
    setRsLesson(lesson);
    setBkResult(null);
    setRepeatWeekly(false);
    setBkLoc(lesson.isZoom ? "Zoom" : "Music City SF");
    setBkMonth(0);
    setDialog({ kind: "book", data: {} });
  };
  const cancelLesson = async (lesson: LessonDTO) => {
    if (readOnly) return flash(PREVIEW_OFF);
    const when = `${fullDate(lesson.startTime)} at ${clock(lesson.startTime)}`;
    const late = hoursUntil(lesson) < cancelHours;
    const msg = late
      ? `This is less than ${cancelHours} hours before the lesson on ${when}. A late cancel still uses the credit or keeps the charge. Cancel anyway?`
      : `Cancel the lesson on ${when}?`;
    if (!window.confirm(msg)) return;
    try {
      const res = await api<{ late: boolean; refund: "credit" | "invoice_voided" | "none" }>(`/lessons/${lesson.id}/cancel`, { method: "POST", body: {} });
      close();
      flash(res.late ? "Lesson cancelled. It was inside the notice window, so it still counts." : res.refund === "credit" ? "Lesson cancelled. The credit is back on your account." : res.refund === "invoice_voided" ? "Lesson cancelled. Its invoice was voided." : "Lesson cancelled.");
      await load();
    } catch (e) {
      flash(errorText(e));
    }
  };
  const confirmBooking = async () => {
    if (!bkSlot || !student) return flash("Choose a time first.");
    if (booking) return;
    setBooking(true);
    try {
      if (rsLesson) {
        await api(`/lessons/${rsLesson.id}/reschedule`, { method: "POST", body: { startTime: bkSlot, location: bkLoc } });
        flash(`Lesson moved to ${fullDate(bkSlot)} at ${clock(bkSlot)}.`);
        close();
        setRsLesson(null);
        await load();
        return;
      }
      const body = { studentId: student.id, startTime: bkSlot, location: bkLoc, ...(repeatWeekly ? { repeatWeekly: true, weeks: bkWeeks } : {}) };
      const res = await api<{ lessons: LessonDTO[]; invoiceIds: string[]; seriesId: string | null }>("/lessons", { method: "POST", body });
      const lessons = res.lessons ?? [];
      const held = lessons.filter((l) => l.status === "pending_payment");
      if (held.length) {
        let instructions: string[] = [];
        const firstInvoice = held[0].invoiceId ?? res.invoiceIds?.[0];
        if (firstInvoice) {
          instructions = await api<{ instructions: string[] }>(`/invoices/${firstInvoice}/instructions`).then((r) => r.instructions ?? []).catch(() => []);
        }
        setBkResult({ count: lessons.length, held: held.length, hold: holdLine(held[0]), instructions });
      } else {
        flash(lessons.length > 1 ? `${lessons.length} weekly lessons booked from ${fullDate(bkSlot)} at ${clock(bkSlot)}.` : `Lesson booked: ${fullDate(bkSlot)} at ${clock(bkSlot)}.`);
        close();
      }
      await load();
    } catch (e) {
      flash(errorText(e));
      const code = e instanceof ApiRequestError ? e.code : "";
      if (code === "outstanding_balance" || code === "unpaid_hold") {
        close();
        await load();
      } else if (code === "slot_unavailable" || code === "reschedule_closed") {
        setBkSlot(null);
        setSlotTick((t) => t + 1);
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

  // Zelle and cash are paid offline: the pay dialog shows the instructions. Card only when card payments are on.
  const openPay = (inv?: InvoiceDTO) => {
    if (readOnly) return flash(PREVIEW_OFF);
    const target = inv ?? (selectedOpen ? selected : firstOpen);
    if (!target) return flash("There's nothing to pay right now.");
    setInvoiceId(target.id);
    open("pay");
    setPayInfo(null);
    api<{ instructions: string[] }>(`/invoices/${target.id}/instructions`)
      .then((r) => setPayInfo({ invoiceId: target.id, instructions: r.instructions ?? [] }))
      .catch((err) => setPayInfo({ invoiceId: target.id, instructions: [], error: errorText(err) }));
  };
  const payByCard = async (target: InvoiceDTO | undefined) => {
    if (readOnly) return flash(PREVIEW_OFF);
    if (!cardOn || !target || paying) return;
    setPaying(true);
    try {
      const { url } = await api<{ url: string }>(`/invoices/${target.id}/checkout`, { method: "POST" });
      if (url && /^https:\/\//i.test(url)) window.location.assign(url);
      else flash("Card checkout isn't available right now.");
    } catch (err) {
      flash(errorText(err));
    } finally {
      setPaying(false);
    }
  };

  const hoursUntilNext = kidNextLesson ? hoursUntil(kidNextLesson) : 0;
  const rsAllowed = !!kidNextLesson && hoursUntilNext > rescheduleHours && !readOnly && !!data?.canBook;
  const next = nextView(kidNextLesson);
  const upcomingOpen = (data?.upcoming ?? []).filter((lesson) => new Date(lesson.startTime).getTime() > Date.now() && (lesson.status === "confirmed" || lesson.status === "pending_payment"));
  const rs = {
    mode: !!rsLesson,
    notMode: !rsLesson,
    allowed: rsAllowed,
    locked: !!kidNextLesson && hoursUntilNext <= rescheduleHours,
    allowedNote: rsAllowed,
    note: `Free to reschedule until ${rescheduleHours} hours before the lesson. Cancel at least ${cancelHours} hours ahead or the lesson still counts.`,
    current: rsLesson ? `${fullDate(rsLesson.startTime)} at ${clock(rsLesson.startTime)}` : "",
    open: () => openReschedule(kidNextLesson),
    canCancelNext: !!kidNextLesson && !readOnly && !!data?.canBook,
    cancelNext: () => kidNextLesson && cancelLesson(kidNextLesson),
    choices: upcomingOpen.map((lesson) => ({
      id: lesson.id,
      date: fullDate(lesson.startTime),
      time: `${clock(lesson.startTime)} – ${clock(lesson.endTime)}`,
      loc: lesson.locationLabel,
      locked: hoursUntil(lesson) < rescheduleHours,
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
  const invoiceNumber = (id?: string | null) => (id ? allInvoices.find((i) => i.id === id)?.number : undefined);
  const history = (data?.history ?? []).map((l) => {
    const note = invoiceLookup(l);
    const invNo = invoiceNumber(l.invoiceId);
    const cancelled = /cancel|noshow/i.test(l.status);
    const st = cancelled ? "Cancelled" : "Attended";
    return {
      date: fmt(l.startTime, { month: "short", day: "numeric", year: "numeric" }),
      dur: cancelled ? "—" : `${Math.round((new Date(l.endTime).getTime() - new Date(l.startTime).getTime()) / 60000)} min`,
      status: st,
      sColor: st === "Attended" ? "#4A6149" : "rgba(17,22,27,.5)",
      note: note ? "View note" : "—",
      invoice: invNo ? `#${invNo}` : l.lateCancel ? "Late cancel" : "—",
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
    weeks: bkWeeks,
    weekOpts: Array.from({ length: SERIES_WEEKS_MAX - 1 }, (_, i) => i + 2),
    setWeeks: (e: any) => setBkWeeks(Number(e.target.value) || SERIES_WEEKS_DEFAULT),
    priceLine: `60-minute lesson · ${SESSION_PRICE}`,
    creditLine: `${credits} lesson credit${credits === 1 ? "" : "s"} left. ${EACH_LESSON}`,
    recurringHint: `Books this time every week. ${EACH_LESSON}`,
    confirmLabel: booking ? "Saving…" : rsLesson ? "Confirm new time" : repeatWeekly ? `Book ${bkWeeks} lessons` : "Confirm lesson",
    summary: slotError || (bkSlot && student ? `${student.firstName} · ${dayLabel} · ${clock(bkSlot)} · ${bkLoc}${repeatWeekly && !rsLesson ? ` · weekly × ${bkWeeks}` : ""}` : "Choose a date and time"),
    confirm: confirmBooking,
    result: bkResult,
    resultTitle: bkResult ? `${bkResult.count} lesson${bkResult.count === 1 ? "" : "s"} booked` : "",
    resultLine: bkResult ? `${bkResult.held === bkResult.count ? (bkResult.count === 1 ? "It is" : "They are") : `${bkResult.held} of them ${bkResult.held === 1 ? "is" : "are"}`} held until payment${bkResult.hold ? ` (${bkResult.hold.replace(/^Held until /, "until ")})` : ""}. Unpaid holds are released after that.` : "",
    resultNote: EACH_LESSON,
    resultSteps: bkResult?.instructions.length ? bkResult.instructions : [`Send ${SESSION_PRICE} per lesson by Zelle to ${zelleTo}, or pay cash at the studio.`],
  };

  const invView = selected
    ? {
        issued: fmtDay(selected.issueDate, { month: "short", day: "numeric", year: "numeric" }),
        due: fmtDay(selected.dueDate, { month: "short", day: "numeric", year: "numeric" }),
        status: statusWord[selected.status] ?? selected.status,
        color: selected.status === "paid" ? "#4A6149" : "#9C5F22",
        total: money(selected.total),
        amountDue: money(selected.amountDue),
        number: selected.number,
        method: selected.paymentMethod ? METHOD_LABEL[selected.paymentMethod] : "",
        open: !!selectedOpen,
        lines: selected.lines.map((l) => ({ label: l.label, amount: money(l.amount) })),
      }
    : { issued: "—", due: "—", status: "No invoices yet", color: "rgba(17,22,27,.5)", total: "$0.00", amountDue: "$0.00", number: "", method: "", open: false, lines: [] };

  const overdueDays = firstOpen?.dueDate ? Math.floor((Date.now() - new Date(firstOpen.dueDate).getTime()) / 864e5) : 0;
  const owed = !!billing && !loading && (billing.outstanding > 0 || billing.openInvoices.length > 0 || billing.bookingBlocked);
  const bal = {
    unavailable: !billing && !loading,
    owed,
    clear: !!billing && !loading && !owed,
    amount: money(billing?.outstanding ?? 0),
    number: firstOpen?.number ?? "",
    items: firstOpen?.lines.map((l) => l.label).join(", ") || firstOpen?.title || "",
    due: fmtDay(firstOpen?.dueDate, { month: "long", day: "numeric", year: "numeric" }),
    statusLabel: firstOpen ? statusWord[firstOpen.status] ?? firstOpen.status : "",
    statusLine: overdueDays > 0 ? `Overdue · ${overdueDays} day${overdueDays === 1 ? "" : "s"}` : "Awaiting payment",
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
  const dlgTitles: any = { enroll2fa: "Security", reschedule: "Move a lesson", book: rsLesson ? "Reschedule your lesson" : bkResult ? "Lesson booked" : "Book a lesson with Zane", pay: `Pay invoice #${selected?.number ?? ""}`, invoice: selected ? `Invoice #${selected.number}` : "Invoices", schedule: `${firstName}'s upcoming lessons`, video: dv.title, note: `${dn.date ?? ""} — ${firstName}`, family: acctMe?.isFamily ? "Family & profile" : "Profile", recovery: "Recovery codes", packages: pkgStep === 3 ? "Invoice requested" : pkgStep === 2 ? "Review" : `Buy a ${PACKAGE_LESSONS}-lesson package` };
  const dlgKickers: any = { enroll2fa: "Security", reschedule: "Scheduling", book: "Scheduling", pay: "Payment", invoice: "Billing", schedule: "Schedule", video: dv.cat, note: "Teacher note", family: acct.label, recovery: "Security", packages: "Lesson package" };
  const dlg: any = { open: !!d, width: dk === "book" && !bkResult ? "860px" : dk === "note" ? "640px" : dk === "packages" ? "560px" : "520px", title: dlgTitles[dk] ?? "", kicker: dlgKickers[dk] ?? "" };
  ["book", "reschedule", "pay", "invoice", "schedule", "video", "note", "family", "upload", "addurl", "editVideo", "recovery", "packages", "enroll2fa", "migrate"].forEach((k) => { dlg[k] = dk === k; });

  const methods: PackageMethod[] = cardOn ? ["zelle", "cash", "card"] : ["zelle", "cash"];
  const method = methods.includes(pkgMethod) ? pkgMethod : "zelle";
  const methodPrice = (m: PackageMethod) => formatMoney(PACKAGE_PRICE_CENTS[m]);
  const sched = upcomingOpen.map((l) => {
    const held = l.status === "pending_payment";
    return {
      id: l.id,
      date: fmt(l.startTime, { weekday: "short", month: "short", day: "numeric" }),
      time: `${clock(l.startTime)} – ${clock(l.endTime)}`,
      loc: l.locationLabel,
      status: held ? "Awaiting payment" : "Booked",
      color: held ? "#9C5F22" : "#1D2A44",
      hold: holdLine(l),
      canAct: !readOnly && !!data?.canBook,
      move: () => openReschedule(l),
      moveLocked: hoursUntil(l) < rescheduleHours,
      cancel: () => cancelLesson(l),
      late: hoursUntil(l) < cancelHours,
    };
  });
  const refs = data?.referrals ?? null;
  const refCode = refs?.code ?? "";
  const cents = (n: number) => formatMoney(n);

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
    ob, rs, bk, dlg, dv, dn, inv: invView, sched, form, familyRows,
    schedNote: `Moves are free until ${rescheduleHours} hours before a lesson. Cancelling within ${cancelHours} hours still uses the credit or keeps the charge.`,
    hasLessonCal: false, noLessonCal: true, lessonCalUrl: "",
    invoiceHistory: allInvoices.map((i) => ({ id: i.id, number: i.number, date: fmtDay(i.issueDate), amount: money(i.total), status: statusWord[i.status] ?? i.status, on: i.id === selected?.id, pick: () => setInvoiceId(i.id) })),
    paymentUnavailable: !loading && !billing,
    // Each recorded payment, newest first, from Supabase.
    paymentHistory: (billing?.payments ?? []).map((p) => ({ id: p.id, number: p.invoiceNumber, date: fmtDay(p.paidAt.slice(0, 10)), amount: money(p.amount), status: "Paid" })),
    referralCode: refCode,
    f: Object.fromEntries(["title", "desc", "cat", "url", "code", "email"].map((k) => [k, (e: any) => setForm((s: any) => ({ ...s, [k]: e.target.value }))])),
    openBook, openReschedule: openRescheduleFlow, openPay: () => openPay(), openInvoice: () => { setInvoiceId(null); open("invoice"); }, openSchedule: () => open("schedule"), openFamily: () => open("family"),
    openRecovery: () => open("recovery"),
    closeDialog: close, stop: (e: any) => e.stopPropagation(), hasToast: !!toast, toast,
    pay: {
      loading: !payInfo,
      steps: payInfo?.instructions ?? [],
      error: payInfo?.error ?? "",
      fallback: `Send ${selected ? money(selected.amountDue) : "the amount due"} by Zelle to ${zelleTo}, or pay cash at your next lesson.`,
      card: cardOn,
      cardLabel: paying ? "Opening…" : `Pay ${selected ? money(selected.amountDue) : ""} by card`,
      payCard: () => payByCard(selectedOpen ? selected : firstOpen),
      note: "Your balance updates once Zane marks the payment received.",
    },
    payThis: () => openPay(selectedOpen ? selected : firstOpen),
    downloadInvoice: () => flash("Invoice PDFs aren't available yet. Ask Zane if you need a copy."),
    pkgLive: true, pkgSoon: false, pkgBtnLabel: "Buy a package",
    credits,
    pkgCreditLine: `${credits} lesson credit${credits === 1 ? "" : "s"} left`,
    openPackages: () => { if (readOnly) return flash(PREVIEW_OFF); setPkgStep(1); setPkgResult(null); open("packages"); },
    pkg: {
      step1: pkgStep === 1, step2: pkgStep === 2, step3: pkgStep === 3,
      sel: { method, label: METHOD_LABEL[method], price: methodPrice(method), lessons: PACKAGE_LESSONS },
      targetLabel: student?.fullName ?? acct.label,
      isCard: method === "card",
      payLabel: pkgBusy ? "Saving…" : method === "card" ? `Pay ${methodPrice(method)} by card` : "Request invoice",
      intro: `${PACKAGE_LESSONS} × 60-minute lessons. Credits are added once the payment is received.`,
      steps: pkgResult?.instructions ?? [],
      existing: !!pkgResult?.existing,
      invoiceNumber: pkgResult?.invoice.number ?? "",
      doneLine: method === "cash"
        ? `${PACKAGE_LESSONS} credits are added for ${student?.firstName ?? "your student"} once Zane receives the cash and marks it paid.`
        : `${PACKAGE_LESSONS} credits are added for ${student?.firstName ?? "your student"} once Zane receives the Zelle payment and marks it paid.`,
      next: () => setPkgStep(2), back: () => setPkgStep(1),
      pay: async () => {
        if (readOnly) return flash(PREVIEW_OFF);
        if (!student || pkgBusy) return;
        setPkgBusy(true);
        try {
          const res = await api<{ invoice: InvoiceDTO; existing: boolean; instructions: string[] }>("/packages/purchase", { method: "POST", body: { studentId: student.id, method } });
          if (method === "card") {
            const { url } = await api<{ url: string }>(`/invoices/${res.invoice.id}/checkout`, { method: "POST" });
            if (url && /^https:\/\//i.test(url)) return window.location.assign(url);
            throw new Error("Card checkout isn't available right now.");
          }
          setPkgResult({ invoice: res.invoice, instructions: res.instructions ?? [], existing: !!res.existing });
          setPkgStep(3);
          await load();
        } catch (err) {
          flash(errorText(err));
        } finally {
          setPkgBusy(false);
        }
      },
    },
    pkgCards: methods.map((m) => ({
      id: m, name: METHOD_LABEL[m], price: methodPrice(m), per: m === "cash" ? "Paid in person before the first lesson" : m === "zelle" ? `Sent to ${zelleTo}` : "Secure card checkout",
      on: m === method, pick: () => setPkgMethod(m),
      bg: m === method ? "rgba(29,42,68,.05)" : "#fff",
      border: m === method ? "#1D2A44" : "rgba(17,22,27,.12)",
    })),
    ref: {
      unavailable: !refs && !loading,
      ready: !!refs,
      code: refCode,
      total: refs?.totalReferred ?? 0,
      pending: (refs?.pending ?? []).map((r) => ({ name: r.name, meta: `Signed up ${fmtDay(r.since, { month: "short", day: "numeric", year: "numeric" })} · first lesson not paid yet` })),
      completed: (refs?.completed ?? []).map((r) => ({ name: r.name, meta: `Paid ${fmtDay(r.completedAt, { month: "short", day: "numeric", year: "numeric" })} · ${cents(REFERRER_CREDIT_CENTS)} credit` })),
      empty: !!refs && !refs.pending.length && !refs.completed.length,
      earned: cents(refs?.creditsEarnedCents ?? 0),
      used: cents(refs?.creditsUsedCents ?? 0),
      available: cents(refs?.creditsAvailableCents ?? 0),
      hasCredit: (refs?.creditsAvailableCents ?? 0) > 0,
      credit: cents(refs?.creditsAvailableCents ?? 0),
      offer: `Your friend gets ${cents(REFERRAL_DISCOUNT_CENTS)} off their first invoice. When they pay it, you get a ${cents(REFERRER_CREDIT_CENTS)} credit.`,
      referredLine: refs?.referredBy ? `You joined with code ${refs.referredBy.code}.${refs.referredBy.discountPending ? ` ${cents(REFERRAL_DISCOUNT_CENTS)} comes off your first invoice.` : ""}` : "",
      canApply: !!refs && !refs.referredBy && allInvoices.length === 0 && !readOnly && !!data?.canPay,
      applyCode: refCodeInput,
      setApplyCode: (e: any) => setRefCodeInput(e.target.value),
      notice: refNotice,
      copyCode: () => { if (!refCode) return; copy(refCode); flash("Referral code copied."); },
      apply: async () => {
        if (readOnly) return flash(PREVIEW_OFF);
        const code = refCodeInput.trim();
        if (!student || code.length < 4) return flash("Enter the code your friend gave you.");
        try {
          await api("/referrals/apply", { method: "POST", body: { studentId: student.id, code } });
          setRefCodeInput("");
          setRefNotice(`Code applied. ${cents(REFERRAL_DISCOUNT_CENTS)} comes off your first invoice.`);
          await load();
        } catch (err) {
          flash(errorText(err));
        }
      },
    },
    viewAs: readOnly,
    backToProfile: () => navigate(previewId ? `/teacher/students/${previewId}` : "/teacher"),
    backToTeacher: () => navigate("/teacher"),
    go: { signin: () => void signOut().then(() => navigate("/signin")) },
    refreshMe, params, copy, TZ, OUTSTANDING_BALANCE_MESSAGE,
  };
}
