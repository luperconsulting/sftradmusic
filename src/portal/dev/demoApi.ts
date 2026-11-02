// DEVELOPMENT ONLY, and loaded only when DEMO_MODE is true (never in a production build).
// Everything here is invented sample data so the screens can be reviewed without live services.
import type { DashboardResponse, MeResponse, TeacherStudentRow } from "../../../shared/portal-types";

const iso = (days: number, h = 16) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 30, 0, 0); return d.toISOString(); };
const day = (days: number) => iso(days).slice(0, 10);
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
const student = (id: string, first: string, last: string, isMinor = true) => ({ id, firstName: first, fullName: `${first} ${last}`, styleLine: "Scottish fiddle · Tuesdays", format: "In person" as const, isMinor, guardianName: isMinor ? "Sample Parent" : null, guardianEmail: "parent@example.com", studentSince: "2025-09-01" });
const lesson = (id: string, days: number, sid = A) => ({ id, studentId: sid, startTime: iso(days), endTime: iso(days).replace(/T(\d\d)/, (_, h) => `T${String(Number(h) + 1).padStart(2, "0")}`), status: "confirmed", locationLabel: "Music City SF", locationSub: "Room 4, 1353 Bush St", isZoom: false });
const note = (id: string, days: number, title: string, status: "draft" | "published" = "published") => ({ id, studentId: A, lessonDate: day(days), title, summary: "Sample lesson summary for design review.", technique: "Sample technique feedback.", practice: "Sample practice plan: ten minutes daily.", goals: "Sample goal for the next lesson.", prep: "Sample preparation.", status, publishedAt: iso(days) });
const video = (id: string, title: string, category: string, watched: boolean) => ({ id, title, category, description: "Sample video description.", durationLabel: "4:12", source: "upload" as const, assignmentId: id, assignedAt: iso(-3), watchedAt: watched ? iso(-1) : null });
const invoice = (id: string, number: string, status: any, total: number, due: number) => ({ id, number, title: "2 × 60-min lesson", status, issueDate: day(due - 7), dueDate: day(due), total, amountDue: status === "paid" ? 0 : total, amountPaid: status === "paid" ? total : 0, currency: "USD", contactId: "sample", contactName: "Sample Parent", lines: [{ label: "Lesson · Sample · 60 min", amount: total / 2 }, { label: "Lesson · Sample · 60 min", amount: total / 2 }] });

const scenario = () => new URLSearchParams(window.location.search).get("demo") ?? "";
const isTeacherPath = () => window.location.pathname.startsWith("/teacher") || !!new URLSearchParams(window.location.search).get("preview");

function dashboard(): DashboardResponse {
  const s = [student(A, "Sample", "Student"), student(B, "Example", "Student")];
  const unpaid = scenario() === "unpaid";
  if (scenario() === "new") return { students: [s[0]], student: s[0], upcoming: [lesson("l1", 6)], history: [], notes: [], videos: [], assignments: [], billing: { outstanding: 0, openInvoices: [], history: [], bookingBlocked: false }, lessonsAvailable: true, canBook: true, canPay: true, readOnly: false };
  const open = unpaid ? [invoice("i2", "2002", "sent", 200, -4)] : [];
  const paid = [invoice("i1", "2001", "paid", 200, -10)];
  return {
    students: s, student: s[0],
    upcoming: [lesson("l1", 6), lesson("l2", 13), lesson("l3", 20)],
    history: [lesson("h1", -3), lesson("h2", -10), lesson("h3", -17)],
    notes: [note("n1", -3, "Sample note: B part, snap bowing"), note("n2", -10, "Sample note: intonation on the 3rd finger")],
    videos: [video("v1", "Sample Video: Bowing", "Technique", false), video("v2", "Sample Video: Tune Walkthrough", "Repertoire", true), video("v3", "Sample Video: Drone Routine", "Practice Exercises", true)],
    assignments: [],
    billing: scenario() === "nobilling" ? null : { outstanding: unpaid ? 200 : 0, openInvoices: open, history: [...open, ...paid], bookingBlocked: unpaid },
    lessonsAvailable: true, canBook: true, canPay: true, readOnly: isTeacherPath(),
  };
}

const sampleContacts = [{ id: "c-rowan", name: "Rowan Sample", email: "rowan@example.com" }, { id: "c-parent", name: "Pat Sample", email: "pat@example.com" }];
const addedStudents: any[] = [];

const rows = (): TeacherStudentRow[] => [...addedStudents, student(A, "Sample", "Student"), student(B, "Example", "Student"), student("00000000-0000-4000-8000-00000000000c", "Adult", "Learner", false)].map((s, i) => ({ ...s, nextLesson: iso(i + 2), noteCount: 3 + i, videoCount: 2 + i, assignmentCount: i, accountId: A, portalStatus: "active", transferPending: false, ghlContactId: "sample", billingContactId: "sample" }));

export async function demoApi(path: string, opts: { method?: string; body?: unknown }) {
  await new Promise((r) => setTimeout(r, 150));
  const p = path.split("?")[0];
  if (p === "/teacher/ghl/contacts") return { contacts: sampleContacts.map((c) => ({ ...c, studentName: addedStudents.find((s) => s.ghlContactId === c.id)?.fullName ?? null })) };
  if (p === "/teacher/students" && opts.method === "POST") {
    const b = opts.body as any;
    const s = { ...student(crypto.randomUUID(), b.fullName.split(" ")[0], b.fullName.split(" ").slice(1).join(" "), b.ageCategory === "child"), format: b.format === "Zoom" ? "Zoom" as const : "In person" as const, email: b.email, guardianName: b.guardianName ?? null, guardianEmail: b.guardianEmail ?? null, ghlContactId: b.ghlContactId ?? crypto.randomUUID() };
    addedStudents.push(s);
    return { student: { id: s.id, fullName: s.fullName }, contacts: b.ghlContactId ? null : { student: "created", billing: b.ageCategory === "child" ? "created" : "same" } };
  }
  if (p === "/teacher/invitations" && opts.method === "POST") {
    const b = opts.body as any;
    return { id: crypto.randomUUID(), name: b.name, email: b.email, studentName: "", status: b.method === "code" ? "code_issued" : "pending", method: b.method, credential: "SFTM-SAMP-LE00", emailed: b.method === "email", inviteUrl: b.method === "email" ? "http://localhost:3000/invite?token=sample" : undefined };
  }
  if (p === "/me") {
    const teacher = isTeacherPath();
    const me: MeResponse = {
      user: { id: "demo", email: teacher ? "teacher@example.com" : "parent@example.com", role: teacher ? "teacher" : "guardian", displayName: teacher ? "Sample Teacher" : "Sample Parent", mfaEnabled: true, aal: "aal2" },
      account: { label: teacher ? "Sample Teacher" : "The Sample Family", ownerFirst: "Sample", ownerFull: teacher ? "Sample Teacher" : "Sample Parent", email: "parent@example.com", initials: "SP", isFamily: true },
      features: { packages: false, autopay: false, referrals: false, recurring: false, invoiceActions: false },
    };
    return me;
  }
  if (p === "/portal/dashboard") return dashboard();
  if (p === "/lessons/slots") return { timezone: "America/Los_Angeles", days: { [day(5)]: [iso(5, 15), iso(5, 17)], [day(7)]: [iso(7, 15)], [day(9)]: [iso(9, 10), iso(9, 11)] } };
  if (p === "/teacher/students") return { students: rows() };
  if (p.startsWith("/teacher/students/")) { const d = dashboard(); return { student: d.student, notes: [...d.notes, note("n0", -1, "Sample draft note", "draft")], videos: d.videos, assignments: [], lessons: [...d.upcoming, ...d.history], billing: d.billing }; }
  if (p === "/teacher/overview") return { studentCount: 3, adultCount: 1, recentNotes: [{ ...note("n0", -1, "Sample draft note", "draft"), studentName: "Sample Student" }], recentVideos: [{ title: "Sample Video: Bowing", to: "Sample", assignedAt: iso(-3) }], invitations: [] };
  if (p === "/teacher/calendar") return { events: [2, 3, 5].map((d, i) => ({ id: `e${i}`, startTime: new Date(new Date(Number(new URLSearchParams(path.split("?")[1]).get("from"))).getTime() + (d * 24 + 16) * 36e5).toISOString(), endTime: "", title: "Lesson", address: i === 1 ? "Zoom" : "Music City SF", status: "confirmed", studentId: A, studentName: "Sample Student" })) };
  if (p === "/teacher/invoices") return { invoices: [invoice("i2", "2002", "sent", 200, -4), invoice("i1", "2001", "paid", 200, -10), invoice("i3", "2003", "draft", 100, 3)], total: 3 };
  if (p === "/teacher/videos") return { videos: [video("v1", "Sample Video: Bowing", "Technique", false), video("v2", "Sample Video: Tune Walkthrough", "Repertoire", true)].map((v) => ({ ...v, assignedCount: 2 })) };
  if (p === "/teacher/assignments") return { assignments: [{ id: "a1", title: "Sample assignment", instructions: "Sample instructions.", dueDate: day(4), videoId: null, videoTitle: "Sample Video: Bowing", lessonDate: day(-3), students: [{ id: A, name: "Sample Student", completedAt: null }] }] };
  if (p === "/teacher/invitations") return { invitations: [{ id: "x1", name: "Sample Parent", email: "parent@example.com", studentName: "Sample Student", status: "accepted", method: "email", sentAt: iso(-3), expiresAt: null, accountId: null }, { id: "x2", name: "Another Parent", email: "another@example.com", studentName: "Example Student", status: "code_issued", method: "code", sentAt: iso(-1), expiresAt: iso(6), accountId: null }] };
  if (p === "/teacher/settings") return { integrations: { supabase: false, ghl: false, storage: false } };
  if (p.endsWith("/playback")) throw new Error("Sample mode: no video file is connected.");
  if (opts.method === "POST" || opts.method === "PUT") throw new Error("Sample mode: nothing is saved or sent.");
  throw new Error("Sample mode: not available.");
}
