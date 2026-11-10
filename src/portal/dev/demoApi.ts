// DEVELOPMENT ONLY, and loaded only when DEMO_MODE is true (never in a production build).
// Everything here is invented sample data so the screens can be reviewed without live services.
import type { DashboardResponse, InvoiceDTO, LessonDTO, MeResponse, ReferralPanelDTO, StudioPolicyDTO, TeacherStudentRow } from "../../../shared/portal-types";

const iso = (days: number, h = 16) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 30, 0, 0); return d.toISOString(); };
const day = (days: number) => iso(days).slice(0, 10);
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
const student = (id: string, first: string, last: string, isMinor = true) => ({ id, firstName: first, fullName: `${first} ${last}`, styleLine: "Scottish fiddle · Tuesdays", format: "In person" as const, isMinor, guardianName: isMinor ? "Sample Parent" : null, guardianEmail: "parent@example.com", studentSince: "2025-09-01" });
const lesson = (id: string, days: number, sid = A, status = "confirmed"): LessonDTO => ({ id, studentId: sid, startTime: iso(days), endTime: new Date(new Date(iso(days)).getTime() + 36e5).toISOString(), status, locationLabel: "Music City SF", locationSub: "Room 4, 1353 Bush St", isZoom: false, holdExpiresAt: status === "pending_payment" ? iso(1, 12) : null, invoiceId: status === "pending_payment" ? "i4" : null, lateCancel: false });
const note = (id: string, days: number, title: string, status: "draft" | "published" = "published") => ({ id, studentId: A, lessonDate: day(days), title, summary: "Sample lesson summary for design review.", technique: "Sample technique feedback.", practice: "Sample practice plan: ten minutes daily.", goals: "Sample goal for the next lesson.", prep: "Sample preparation.", status, publishedAt: iso(days) });
const video = (id: string, title: string, category: string, watched: boolean) => ({ id, title, category, description: "Sample video description.", durationLabel: "4:12", source: "upload" as const, assignmentId: id, assignedAt: iso(-3), watchedAt: watched ? iso(-1) : null });
const invoice = (id: string, number: string, status: any, kind: "package" | "session" = "package", method: "zelle" | "cash" = "zelle", due = 3): InvoiceDTO => {
  const total = kind === "session" ? 100 : method === "cash" ? 375 : 380;
  return { id, number, title: kind === "session" ? "60-min lesson" : "4-lesson package", status, issueDate: day(due - 7), dueDate: day(due), total, amountDue: status === "paid" ? 0 : total, amountPaid: status === "paid" ? total : 0, currency: "USD", contactId: "sample", contactName: "Sample Parent", studentId: A, payUrl: null, kind, paymentMethod: method, lines: [{ label: kind === "session" ? "Lesson · 60 min" : "4 × 60-min lessons", amount: total }] };
};
const policy: StudioPolicyDTO = { zelleRecipient: "zelle@example.com", holdWindowMinutes: 1440, rescheduleNoticeHours: 24, cancelNoticeHours: 24 };
const referrals = (): ReferralPanelDTO => ({ code: "SAMPLE25", totalReferred: 2, pending: [{ name: "Friend One", since: day(-5) }], completed: [{ name: "Friend Two", completedAt: day(-20) }], creditsEarnedCents: 2500, creditsUsedCents: 0, creditsAvailableCents: 2500, referredBy: null });
const instructions = (inv: InvoiceDTO) => inv.paymentMethod === "cash" ? [`Bring $${inv.amountDue} in cash to your next lesson.`, "Zane marks it paid when he receives it."] : [`Send $${inv.amountDue} by Zelle to ${policy.zelleRecipient}.`, `Put invoice #${inv.number} in the memo.`, "Zane marks it paid when it arrives."];
let studio = { settings: { holdWindowMinutes: 1440, rescheduleNoticeHours: 24, cancelNoticeHours: 24, zelleRecipient: policy.zelleRecipient, timezone: "America/Los_Angeles" }, hours: [{ weekday: 2, startMinute: 900, endMinute: 1140 }, { weekday: 4, startMinute: 900, endMinute: 1140 }, { weekday: 6, startMinute: 600, endMinute: 780 }] };

const scenario = () => new URLSearchParams(window.location.search).get("demo") ?? "";
const isTeacherPath = () => window.location.pathname.startsWith("/teacher") || !!new URLSearchParams(window.location.search).get("preview");

function dashboard(): DashboardResponse {
  const s = [student(A, "Sample", "Student"), student(B, "Example", "Student")];
  const unpaid = scenario() === "unpaid";
  if (scenario() === "new") return { students: [s[0]], student: s[0], upcoming: [lesson("l1", 6)], history: [], notes: [], videos: [], assignments: [], packageLessons: 0, policy, referrals: { ...referrals(), totalReferred: 0, pending: [], completed: [], creditsEarnedCents: 0, creditsAvailableCents: 0 }, billing: { outstanding: 0, openInvoices: [], history: [], bookingBlocked: false, paymentsOpen: true, payments: [] }, lessonsAvailable: true, canBook: true, canPay: true, readOnly: false };
  const open = unpaid ? [invoice("i4", "2004", "sent", "session", "zelle", -1)] : [invoice("i3", "2003", "sent", "package", "zelle", 5)];
  const paid = [invoice("i1", "2001", "paid", "package", "cash", -30)];
  return {
    students: s, student: s[0],
    upcoming: [lesson("l1", 6), lesson("l2", 13), ...(unpaid ? [lesson("l3", 20, A, "pending_payment")] : [lesson("l3", 20)])],
    history: [lesson("h1", -3), lesson("h2", -10), lesson("h3", -17)],
    notes: [note("n1", -3, "Sample note: B part, snap bowing"), note("n2", -10, "Sample note: intonation on the 3rd finger")],
    videos: [video("v1", "Sample Video: Bowing", "Technique", false), video("v2", "Sample Video: Tune Walkthrough", "Repertoire", true), video("v3", "Sample Video: Drone Routine", "Practice Exercises", true)],
    assignments: [],
    packageLessons: 2,
    policy,
    referrals: referrals(),
    billing: scenario() === "nobilling" ? null : { outstanding: open.reduce((a, i) => a + i.amountDue, 0), openInvoices: open, history: [...open, ...paid], bookingBlocked: unpaid, paymentsOpen: true, payments: [{ id: "p1", invoiceId: "i1", invoiceNumber: "2001", amount: 375, method: "cash", status: "succeeded" as const, paidAt: iso(-29), reference: "" }] },
    lessonsAvailable: true, canBook: true, canPay: true, readOnly: isTeacherPath(),
  };
}

const addedStudents: any[] = [];

const rows = (): TeacherStudentRow[] => [...addedStudents, student(A, "Sample", "Student"), student(B, "Example", "Student"), student("00000000-0000-4000-8000-00000000000c", "Adult", "Learner", false)].map((s, i) => ({ ...s, nextLesson: iso(i + 2), noteCount: 3 + i, videoCount: 2 + i, assignmentCount: i, packageLessons: i === 0 ? 2 : 0, accountId: A, portalStatus: "active", transferPending: false }));

export async function demoApi(path: string, opts: { method?: string; body?: unknown }) {
  await new Promise((r) => setTimeout(r, 150));
  const p = path.split("?")[0];
  if (p === "/teacher/students" && opts.method === "POST") {
    const b = opts.body as any;
    const s = { ...student(crypto.randomUUID(), b.fullName.split(" ")[0], b.fullName.split(" ").slice(1).join(" "), b.ageCategory === "child"), format: b.format === "Zoom" ? "Zoom" as const : "In person" as const, email: b.email, guardianName: b.guardianName ?? null, guardianEmail: b.guardianEmail ?? null };
    addedStudents.push(s);
    return { student: { id: s.id, fullName: s.fullName }, guardian: b.ageCategory === "child" ? "created" : null, referral: b.referralCode ? "applied" : null };
  }
  if (p === "/teacher/invitations" && opts.method === "POST") {
    const b = opts.body as any;
    return { id: crypto.randomUUID(), name: b.name || b.email, email: b.email, studentName: "Not enrolled yet", status: "pending", method: "email", credential: "sample-token-value", emailed: true, inviteUrl: "http://localhost:3000/invite?token=sample" };
  }
  if (p === "/invitations/verify-code" && opts.method === "POST") {
    return { accessToken: "demo-access", refreshToken: "demo-refresh", email: (opts.body as any)?.email ?? "luperdev@gmail.com" };
  }
  if (/\/teacher\/invitations\/[^/]+\/resend$/.test(p) && opts.method === "POST") {
    return { id: crypto.randomUUID(), name: "Sample", email: "luperdev@gmail.com", studentName: "Not enrolled yet", status: "pending", method: "email", emailed: true, inviteUrl: "http://localhost:3000/invite?token=resent" };
  }
  if (p === "/me") {
    const teacher = isTeacherPath();
    const me: MeResponse = {
      user: { id: "demo", email: teacher ? "teacher@example.com" : "parent@example.com", role: teacher ? "teacher" : "guardian", displayName: teacher ? "Sample Teacher" : "Sample Parent", mfaEnabled: true, aal: "aal2" },
      account: { label: teacher ? "Sample Teacher" : "The Sample Family", ownerFirst: "Sample", ownerFull: teacher ? "Sample Teacher" : "Sample Parent", email: "parent@example.com", initials: "SP", isFamily: true },
      features: { cardPayments: false },
    };
    return me;
  }
  if (p === "/portal/dashboard") return dashboard();
  if (p === "/lessons/slots") return { timezone: "America/Los_Angeles", slotMinutes: 60, stepMinutes: 30, days: { [day(5)]: [iso(5, 15), iso(5, 17)], [day(7)]: [iso(7, 15)], [day(9)]: [iso(9, 10), iso(9, 11)] } };
  if (p === "/teacher/students") return { students: rows() };
  if (p.startsWith("/teacher/students/")) { const d = dashboard(); return { student: d.student, notes: [...d.notes, note("n0", -1, "Sample draft note", "draft")], videos: d.videos, assignments: [], lessons: [...d.upcoming, ...d.history], billing: d.billing, packageLessons: d.packageLessons, referrals: d.referrals }; }
  if (p === "/teacher/overview") return { studentCount: 3, adultCount: 1, recentNotes: [{ ...note("n0", -1, "Sample draft note", "draft"), studentName: "Sample Student" }], recentVideos: [{ title: "Sample Video: Bowing", to: "Sample", assignedAt: iso(-3) }], invitations: [] };
  if (p === "/teacher/calendar") return { events: [2, 3, 5].map((d, i) => ({ id: `e${i}`, startTime: new Date(new Date(Number(new URLSearchParams(path.split("?")[1]).get("from"))).getTime() + (d * 24 + 16) * 36e5).toISOString(), endTime: "", title: "Lesson", address: i === 1 ? "Zoom" : "Music City SF", status: i === 2 ? "pending_payment" : "confirmed", holdExpiresAt: i === 2 ? iso(1, 12) : null, studentId: A, studentName: "Sample Student" })) };
  if (p === "/teacher/invoices" && opts.method === "POST") return { invoice: invoice("i9", "2009", "sent", "session") };
  if (p === "/teacher/invoices") return { invoices: [invoice("i3", "2003", "sent", "package", "zelle", 5), invoice("i4", "2004", "sent", "session", "zelle", -1), invoice("i1", "2001", "paid", "package", "cash", -30), invoice("i5", "2005", "draft", "session", "cash", 3)], total: 4 };
  if (/^\/teacher\/invoices\/[^/]+\/(mark-paid|void|send|remind)$/.test(p) && opts.method === "POST") return { ok: true, suppressed: p.endsWith("/remind") };
  if (p === "/packages/purchase" && opts.method === "POST") { const m = (opts.body as any)?.method === "cash" ? "cash" : "zelle"; const inv = invoice("i8", "2008", "sent", "package", m, 7); return { invoice: inv, existing: false, instructions: instructions(inv), creditsAdded: 0 }; }
  const inst = p.match(/^\/invoices\/([^/]+)\/instructions$/);
  if (inst) { const inv = invoice(inst[1], inst[1] === "i3" ? "2003" : "2004", "sent", inst[1] === "i3" ? "package" : "session"); return { invoice: inv, instructions: instructions(inv), zelleRecipient: policy.zelleRecipient, cardPayments: false }; }
  if (p === "/referrals") return referrals();
  if (p === "/referrals/apply" && opts.method === "POST") return { ok: true, discountCents: 1500 };
  if (p === "/lessons" && opts.method === "POST") {
    const b = opts.body as any;
    const weeks = b?.repeatWeekly ? b.weeks ?? 8 : 1;
    const lessons = Array.from({ length: weeks }, (_, i) => ({ ...lesson(`new${i}`, 6 + i * 7, b?.studentId ?? A, i < 2 ? "confirmed" : "pending_payment"), startTime: new Date(new Date(b.startTime).getTime() + i * 7 * 864e5).toISOString() }));
    return { lessons, invoiceIds: lessons.filter((l) => l.status === "pending_payment").map((_, i) => `inv${i}`), seriesId: weeks > 1 ? "series" : null };
  }
  if (/^\/lessons\/[^/]+\/reschedule$/.test(p) && opts.method === "POST") return { lesson: { ...lesson("moved", 8), startTime: (opts.body as any).startTime } };
  if (/^\/lessons\/[^/]+\/cancel$/.test(p) && opts.method === "POST") return { lesson: lesson("l1", 6, A, "cancelled"), late: false, refund: "credit" };
  if (p === "/teacher/lessons" && opts.method === "POST") { const l = lesson("t1", 6); return { lesson: l, lessons: [l], invoiceIds: [] }; }
  if (/^\/teacher\/lessons\/[^/]+\/(reschedule|cancel)$/.test(p) && opts.method === "POST") return { lesson: lesson("t1", 6), late: false, refund: "credit" };
  if (p === "/teacher/studio" && opts.method === "PUT") { const b = opts.body as any; const { hours, ...rest } = b ?? {}; studio = { settings: { ...studio.settings, ...rest }, hours: hours ?? studio.hours }; return studio; }
  if (p === "/teacher/studio") return studio;
  if (p === "/teacher/referrals") return { referrals: [{ id: "r1", referrer: "Sample Student", referred: "Friend One", code: "SAMPLE25", status: "pending", createdAt: iso(-5), completedAt: null }, { id: "r2", referrer: "Sample Student", referred: "Friend Two", code: "SAMPLE25", status: "completed", createdAt: iso(-30), completedAt: iso(-20) }], credits: [{ student: "Sample Student", amount: 25, used: false, createdAt: iso(-20) }] };
  if (p === "/teacher/videos") return { videos: [video("v1", "Sample Video: Bowing", "Technique", false), video("v2", "Sample Video: Tune Walkthrough", "Repertoire", true)].map((v) => ({ ...v, assignedCount: 2 })) };
  if (p === "/teacher/assignments") return { assignments: [{ id: "a1", title: "Sample assignment", instructions: "Sample instructions.", dueDate: day(4), videoId: null, videoTitle: "Sample Video: Bowing", lessonDate: day(-3), students: [{ id: A, name: "Sample Student", completedAt: null }] }] };
  if (p === "/teacher/invitations") return { invitations: [{ id: "x1", name: "Sample Parent", email: "parent@example.com", studentName: "Sample Student", status: "accepted", method: "email", sentAt: iso(-3), expiresAt: null, accountId: null }, { id: "x2", name: "Another Parent", email: "another@example.com", studentName: "Example Student", status: "code_issued", method: "code", sentAt: iso(-1), expiresAt: iso(6), accountId: null }] };
  if (p === "/teacher/settings") return { integrations: { supabase: false, storage: false, googleCalendar: false, email: false }, cardPayments: false, safeMode: true };
  if (p.endsWith("/playback")) throw new Error("Sample mode: no video file is connected.");
  if (opts.method === "POST" || opts.method === "PUT") throw new Error("Sample mode: nothing is saved or sent.");
  throw new Error("Sample mode: not available.");
}
