// In-memory stand-in for the Supabase core-data tables (students, guardians, billing contacts, lessons,
// bookings, invoices, payments). Fixtures use the Arzo Luper test student and luperdev@gmail.com addresses only.
import { randomUUID } from "node:crypto";
import type { InvoiceRecord, LessonRecord, PaymentRecord, PortalStore, StudentRecord } from "../server/store/types";

export const TEACHER_ACCOUNT = "teach";
export const ARZO_EMAIL = "luperdev@gmail.com";
export const GUARDIAN_EMAIL = "luperdev+guardian@gmail.com";

export interface CoreTables {
  students: StudentRecord[];
  guardians: { id: string; fullName: string; email: string; accountId: string | null }[];
  studentGuardians: { studentId: string; guardianId: string }[];
  payers: { id: string; fullName: string; email: string | null; guardianId: string | null }[];
  lessons: LessonRecord[];
  bookings: { id: string; lessonId: string; studentId: string; source: string; status: string }[];
  invoices: InvoiceRecord[];
  payments: PaymentRecord[];
}

export function emptyTables(): CoreTables {
  return { students: [], guardians: [], studentGuardians: [], payers: [], lessons: [], bookings: [], invoices: [], payments: [] };
}

export function memoryCoreStore(tables: CoreTables = emptyTables()): Pick<PortalStore,
  "checkStudentSchema" | "listStudents" | "getStudent" | "getStudents" | "createStudent" | "studioTeacherAccountId" |
  "listLessons" | "getLesson" | "createLesson" | "closeLesson" |
  "listInvoices" | "getInvoice" | "createInvoice" | "updateInvoiceStatus" | "listPayments" | "recordPayment"> & { tables: CoreTables } {
  let invoiceNumber = 1000;
  const payerName = (id: string | null) => tables.payers.find((p) => p.id === id)?.fullName ?? "";
  return {
    tables,
    async checkStudentSchema() {},
    async listStudents() { return [...tables.students].sort((a, b) => a.fullName.localeCompare(b.fullName)); },
    async getStudent(id) { return tables.students.find((s) => s.id === id) ?? null; },
    async getStudents(ids) { return tables.students.filter((s) => ids.includes(s.id)); },
    async studioTeacherAccountId() { return TEACHER_ACCOUNT; },
    async createStudent(input) {
      let guardian: "created" | "reused" | null = null;
      let payerId: string;
      let guardianId: string | null = null;
      if (input.isMinor && input.guardianEmail) {
        const found = tables.guardians.find((g) => g.email === input.guardianEmail);
        if (found) { guardianId = found.id; guardian = "reused"; }
        else {
          guardianId = randomUUID();
          tables.guardians.push({ id: guardianId, fullName: input.guardianName ?? input.guardianEmail, email: input.guardianEmail, accountId: null });
          guardian = "created";
        }
        const payer = tables.payers.find((p) => p.guardianId === guardianId);
        payerId = payer?.id ?? randomUUID();
        if (!payer) tables.payers.push({ id: payerId, fullName: input.guardianName ?? input.guardianEmail, email: input.guardianEmail, guardianId });
      } else {
        payerId = randomUUID();
        tables.payers.push({ id: payerId, fullName: input.fullName, email: input.email, guardianId: null });
      }
      const student: StudentRecord = {
        id: randomUUID(), firstName: input.fullName.split(/\s+/)[0], fullName: input.fullName, styleLine: "", format: input.format,
        isMinor: input.isMinor, guardianName: input.guardianName, guardianEmail: input.guardianEmail, studentSince: null, email: input.email,
        teacherAccountId: input.teacherAccountId, payerId, ghlContactId: null, billingContactId: null,
      };
      tables.students.push(student);
      if (guardianId) tables.studentGuardians.push({ studentId: student.id, guardianId });
      return { student, guardian };
    },
    async listLessons(q) {
      return tables.lessons
        .filter((l) => (!q.studentIds || q.studentIds.includes(l.studentId)) && (!q.teacherAccountId || l.teacherAccountId === q.teacherAccountId)
          && (!q.from || l.startsAt >= q.from) && (!q.to || l.startsAt < q.to))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    },
    async getLesson(id) { return tables.lessons.find((l) => l.id === id) ?? null; },
    async createLesson(input) {
      const lesson: LessonRecord = {
        id: randomUUID(), studentId: input.studentId, teacherAccountId: input.teacherAccountId, startsAt: input.startsAt, endsAt: input.endsAt,
        locationKind: input.locationKind, location: input.location, zoomUrl: input.zoomUrl, status: "scheduled", cancelledAt: null,
        cancellationReason: null, rescheduledFromId: input.rescheduledFromId ?? null, createdAt: new Date().toISOString(),
      };
      tables.lessons.push(lesson);
      tables.bookings.push({ id: randomUUID(), lessonId: lesson.id, studentId: input.studentId, source: input.source, status: "confirmed" });
      return lesson;
    },
    async closeLesson(id, input) {
      const lesson = tables.lessons.find((l) => l.id === id)!;
      lesson.status = input.status;
      if (input.status === "cancelled") {
        lesson.cancelledAt = new Date().toISOString();
        lesson.cancellationReason = input.reason;
        for (const b of tables.bookings) if (b.lessonId === id) b.status = "cancelled";
      }
      return { ...lesson };
    },
    async listInvoices(q) {
      return tables.invoices
        .filter((i) => (!q.studentIds || q.studentIds.includes(i.studentId)) && (q.includeDrafts || i.status !== "draft"))
        .map((i) => ({ ...i, payerName: payerName(i.payerId) }));
    },
    async getInvoice(id) {
      const i = tables.invoices.find((x) => x.id === id);
      return i ? { ...i, payerName: payerName(i.payerId) } : null;
    },
    async createInvoice(input) {
      const inv: InvoiceRecord = {
        id: randomUUID(), number: ++invoiceNumber, studentId: input.studentId, payerId: input.payerId, payerName: payerName(input.payerId),
        title: input.title, currency: "USD", totalCents: input.lines.reduce((s, l) => s + l.amountCents, 0), amountPaidCents: 0,
        status: input.status, issueDate: input.issueDate, dueDate: input.dueDate, createdAt: new Date().toISOString(), lines: input.lines,
      };
      tables.invoices.push(inv);
      return { ...inv };
    },
    async updateInvoiceStatus(id, patch) {
      const inv = tables.invoices.find((i) => i.id === id)!;
      inv.status = patch.status;
      if (patch.amountPaidCents !== undefined) inv.amountPaidCents = patch.amountPaidCents;
      return { ...inv, payerName: payerName(inv.payerId) };
    },
    async listPayments(ids) { return tables.payments.filter((p) => ids.includes(p.invoiceId)); },
    async recordPayment(input) {
      const p: PaymentRecord = { id: randomUUID(), invoiceId: input.invoiceId, payerId: input.payerId, amountCents: input.amountCents, method: input.method, status: "succeeded", paidAt: new Date().toISOString(), note: input.note };
      tables.payments.push(p);
      return p;
    },
  };
}

/** A lesson row for fixtures. */
export function lessonRow(studentId: string, startsAt: string, over: Partial<LessonRecord> = {}): LessonRecord {
  return {
    id: randomUUID(), studentId, teacherAccountId: TEACHER_ACCOUNT, startsAt, endsAt: new Date(new Date(startsAt).getTime() + 3600000).toISOString(),
    locationKind: "in_person", location: "Music City SF, Room 4, 1353 Bush St", zoomUrl: null, status: "scheduled", cancelledAt: null,
    cancellationReason: null, rescheduledFromId: null, createdAt: new Date().toISOString(), ...over,
  };
}

/** An invoice row for fixtures. Amounts are in cents. */
export function invoiceRow(studentId: string, payerId: string | null, totalCents: number, over: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: randomUUID(), number: 2001, studentId, payerId, payerName: "", title: "Lesson", currency: "USD", totalCents, amountPaidCents: 0,
    status: "sent", issueDate: "2026-11-01", dueDate: "2026-11-08", createdAt: new Date().toISOString(),
    lines: [{ label: "60-min lesson", amountCents: totalCents, lessonId: null }], ...over,
  };
}
