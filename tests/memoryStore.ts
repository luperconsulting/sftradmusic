// In-memory stand-in for the Supabase portal tables. It mirrors the database rules the API relies on,
// including the lessons_no_overlap exclusion constraint and the once-only credit and referral rows.
// Fixtures use the Arzo Luper test student and luperdev@gmail.com addresses only.
import { randomUUID } from "node:crypto";
import { ApiError } from "../server/http";
import type { InvoiceRecord, LessonHoursRow, LessonRecord, PaymentRecord, PaymentReportRecord, PortalStore, ReferralCreditRecord, ReferralRecord, StudentRecord, StudioSettings } from "../server/store/types";

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
  settings: Record<string, StudioSettings>;
  hours: Record<string, LessonHoursRow[]>;
  series: { id: string; studentId: string }[];
  ledger: { studentId: string; delta: number; reason: string; invoiceId: string | null; lessonId: string | null }[];
  referralCodes: { studentId: string; code: string }[];
  referrals: ReferralRecord[];
  referralCredits: ReferralCreditRecord[];
  stripeEvents: string[];
  paymentReports: PaymentReportRecord[];
}

export function emptyTables(): CoreTables {
  return {
    students: [], guardians: [], studentGuardians: [], payers: [], lessons: [], bookings: [], invoices: [], payments: [],
    settings: {}, hours: {}, series: [], ledger: [], referralCodes: [], referrals: [], referralCredits: [], stripeEvents: [], paymentReports: [],
  };
}

export const defaultSettings = (teacherAccountId: string): StudioSettings => ({
  teacherAccountId, holdWindowMinutes: 1440, rescheduleNoticeHours: 24, cancelNoticeHours: 24, zelleRecipient: "", zelleQrDataUrl: null, timezone: "America/Los_Angeles",
});

const live = (l: LessonRecord) => l.status === "scheduled" || l.status === "pending_payment";

export function memoryCoreStore(tables: CoreTables = emptyTables()) {
  let invoiceNumber = 1000;
  const payer = (id: string | null) => tables.payers.find((p) => p.id === id);
  const withPayer = (i: InvoiceRecord): InvoiceRecord => ({ ...i, payerName: payer(i.payerId)?.fullName ?? "", payerEmail: payer(i.payerId)?.email ?? null, lines: [...i.lines] });
  const store = {
    tables,
    async checkStudentSchema() {},
    async listStudents() { return [...tables.students].sort((a, b) => a.fullName.localeCompare(b.fullName)); },
    async getStudent(id: string) { return tables.students.find((s) => s.id === id) ?? null; },
    async getStudents(ids: string[]) { return tables.students.filter((s) => ids.includes(s.id)); },
    async studioTeacherAccountId() { return TEACHER_ACCOUNT; },
    async createStudent(input: Parameters<PortalStore["createStudent"]>[0]) {
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
        const existing = tables.payers.find((p) => p.guardianId === guardianId);
        payerId = existing?.id ?? randomUUID();
        if (!existing) tables.payers.push({ id: payerId, fullName: input.guardianName ?? input.guardianEmail, email: input.guardianEmail, guardianId });
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
    async listLessons(q: Parameters<PortalStore["listLessons"]>[0]) {
      return tables.lessons
        .filter((l) => (!q.studentIds || q.studentIds.includes(l.studentId)) && (!q.teacherAccountId || l.teacherAccountId === q.teacherAccountId)
          && (!q.from || l.startsAt >= q.from) && (!q.to || l.startsAt < q.to) && (!q.createdFrom || l.createdAt >= q.createdFrom)
          && (!q.statuses || q.statuses.includes(l.status)))
        .map((l) => ({ ...l }))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    },
    async getLesson(id: string) { const l = tables.lessons.find((x) => x.id === id); return l ? { ...l } : null; },
    async createLesson(input: Parameters<PortalStore["createLesson"]>[0]) {
      // teacher_account_id is not null in the database.
      if (!input.teacherAccountId) throw new ApiError(400, "no_teacher", "A lesson needs a teacher.");
      if (Date.parse(input.endsAt) - Date.parse(input.startsAt) !== 3600000) throw new Error("lessons_sixty_minutes");
      const s = Date.parse(input.startsAt), e = Date.parse(input.endsAt);
      // lessons_no_overlap: live lessons for one teacher may not overlap.
      if (tables.lessons.some((l) => live(l) && l.teacherAccountId === input.teacherAccountId && Date.parse(l.startsAt) < e && s < Date.parse(l.endsAt))) {
        throw new ApiError(409, "slot_unavailable", "That time was just taken. Please choose another.");
      }
      const lesson: LessonRecord = {
        id: randomUUID(), studentId: input.studentId, teacherAccountId: input.teacherAccountId, startsAt: input.startsAt, endsAt: input.endsAt,
        locationKind: input.locationKind, location: input.location, zoomUrl: input.zoomUrl, status: input.status ?? "scheduled", cancelledAt: null,
        cancellationReason: null, rescheduledFromId: input.rescheduledFromId ?? null, createdAt: new Date().toISOString(),
        holdExpiresAt: input.holdExpiresAt ?? null, invoiceId: input.invoiceId ?? null, seriesId: input.seriesId ?? null, lateCancel: false,
      };
      tables.lessons.push(lesson);
      tables.bookings.push({ id: randomUUID(), lessonId: lesson.id, studentId: input.studentId, source: input.source, status: "confirmed" });
      return { ...lesson };
    },
    async closeLesson(id: string, input: Parameters<PortalStore["closeLesson"]>[1]) {
      const lesson = tables.lessons.find((l) => l.id === id)!;
      lesson.status = input.status;
      lesson.holdExpiresAt = null;
      if (input.status === "cancelled") {
        lesson.cancelledAt = new Date().toISOString();
        lesson.cancellationReason = input.reason;
        lesson.lateCancel = input.lateCancel === true;
      }
      if (input.status !== "rescheduled") for (const b of tables.bookings) if (b.lessonId === id) b.status = "cancelled";
      return { ...lesson };
    },
    async updateLesson(id: string, patch: Parameters<PortalStore["updateLesson"]>[1]) {
      const lesson = tables.lessons.find((l) => l.id === id)!;
      if (patch.status) lesson.status = patch.status;
      if (patch.holdExpiresAt !== undefined) lesson.holdExpiresAt = patch.holdExpiresAt;
      if (patch.invoiceId !== undefined) lesson.invoiceId = patch.invoiceId;
      return { ...lesson };
    },
    async listLessonsByInvoice(invoiceId: string) { return tables.lessons.filter((l) => l.invoiceId === invoiceId).map((l) => ({ ...l })); },
    async listExpiredHolds(now: string) { return tables.lessons.filter((l) => l.status === "pending_payment" && l.holdExpiresAt! <= now).map((l) => ({ ...l })); },
    async createSeries(input: { studentId: string }) { const id = randomUUID(); tables.series.push({ id, studentId: input.studentId }); return id; },
    async getSettings(teacherAccountId: string) { return { ...(tables.settings[teacherAccountId] ?? defaultSettings(teacherAccountId)) }; },
    async saveSettings(teacherAccountId: string, patch: Partial<StudioSettings>) {
      tables.settings[teacherAccountId] = { ...(tables.settings[teacherAccountId] ?? defaultSettings(teacherAccountId)), ...patch, teacherAccountId };
      return { ...tables.settings[teacherAccountId] };
    },
    async listLessonHours(teacherAccountId: string) { return [...(tables.hours[teacherAccountId] ?? [])]; },
    async replaceLessonHours(teacherAccountId: string, rows: LessonHoursRow[]) { tables.hours[teacherAccountId] = [...rows]; return [...rows]; },
    async creditBalances(ids: string[]) {
      const out: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
      for (const r of tables.ledger) if (ids.includes(r.studentId)) out[r.studentId] += r.delta;
      return out;
    },
    async addCredit(input: Parameters<PortalStore["addCredit"]>[0]) {
      const dupe = tables.ledger.some((r) => r.reason === input.reason && (
        (input.reason === "package_paid" && r.invoiceId === input.invoiceId) || ((input.reason === "lesson_booked" || input.reason === "lesson_refund") && r.lessonId === input.lessonId)));
      if (dupe) return false;
      tables.ledger.push({ studentId: input.studentId, delta: input.delta, reason: input.reason, invoiceId: input.invoiceId ?? null, lessonId: input.lessonId ?? null });
      return true;
    },
    async listInvoices(q: Parameters<PortalStore["listInvoices"]>[0]) {
      return tables.invoices.filter((i) => (!q.studentIds || q.studentIds.includes(i.studentId)) && (q.includeDrafts || i.status !== "draft")).map(withPayer);
    },
    async getInvoice(id: string) { const i = tables.invoices.find((x) => x.id === id); return i ? withPayer(i) : null; },
    async createInvoice(input: Parameters<PortalStore["createInvoice"]>[0]) {
      const inv: InvoiceRecord = {
        id: randomUUID(), number: ++invoiceNumber, studentId: input.studentId, payerId: input.payerId, payerName: "", payerEmail: null,
        title: input.title, currency: "USD", totalCents: Math.max(0, input.lines.reduce((s, l) => s + l.amountCents, 0)), amountPaidCents: 0,
        status: input.status, issueDate: input.issueDate, dueDate: input.dueDate, createdAt: new Date().toISOString(), lines: [...input.lines],
        kind: input.kind ?? "manual", paymentMethodChoice: input.paymentMethodChoice ?? null, packageLessons: input.packageLessons ?? 0,
      };
      tables.invoices.push(inv);
      return withPayer(inv);
    },
    async updateInvoiceStatus(id: string, patch: Parameters<PortalStore["updateInvoiceStatus"]>[1]) {
      const inv = tables.invoices.find((i) => i.id === id)!;
      inv.status = patch.status;
      if (patch.amountPaidCents !== undefined) inv.amountPaidCents = patch.amountPaidCents;
      return withPayer(inv);
    },
    async listPayments(ids: string[]) { return tables.payments.filter((p) => ids.includes(p.invoiceId)); },
    async recordPayment(input: Parameters<PortalStore["recordPayment"]>[0]) {
      const p: PaymentRecord = { id: randomUUID(), invoiceId: input.invoiceId, payerId: input.payerId, amountCents: input.amountCents, method: input.method, status: "succeeded", paidAt: input.paidAt ?? new Date().toISOString(), note: input.note, reference: input.reference ?? "" };
      tables.payments.push(p);
      return p;
    },
    async getReferralCode(studentId: string) { return tables.referralCodes.find((c) => c.studentId === studentId)?.code ?? null; },
    async saveReferralCode(studentId: string, code: string) { if (!tables.referralCodes.some((c) => c.studentId === studentId)) tables.referralCodes.push({ studentId, code }); },
    async findStudentByReferralCode(code: string) { return tables.referralCodes.find((c) => c.code === code.toUpperCase())?.studentId ?? null; },
    async createReferral(input: Parameters<PortalStore["createReferral"]>[0]) {
      if (tables.referrals.some((r) => r.referredStudentId === input.referredStudentId)) return null;
      const r: ReferralRecord = { id: randomUUID(), ...input, status: "pending", discountInvoiceId: null, completedAt: null, createdAt: new Date().toISOString() };
      tables.referrals.push(r);
      return { ...r };
    },
    async getReferralForReferred(studentId: string) { const r = tables.referrals.find((x) => x.referredStudentId === studentId); return r ? { ...r } : null; },
    async listReferrals(q: { referrerStudentIds?: string[] }) { return tables.referrals.filter((r) => !q.referrerStudentIds || q.referrerStudentIds.includes(r.referrerStudentId)).map((r) => ({ ...r })); },
    async updateReferral(id: string, patch: Parameters<PortalStore["updateReferral"]>[1]) {
      const r = tables.referrals.find((x) => x.id === id)!;
      if (patch.status) r.status = patch.status;
      if (patch.discountInvoiceId !== undefined) r.discountInvoiceId = patch.discountInvoiceId;
      if (patch.completedAt !== undefined) r.completedAt = patch.completedAt;
    },
    async createReferralCredit(input: { referralId: string; studentId: string; amountCents: number }) {
      if (tables.referralCredits.some((c) => c.referralId === input.referralId)) return false;
      tables.referralCredits.push({ id: randomUUID(), ...input, usedInvoiceId: null, usedAt: null, createdAt: new Date().toISOString() });
      return true;
    },
    async listReferralCredits(ids: string[]) { return tables.referralCredits.filter((c) => ids.includes(c.studentId)).map((c) => ({ ...c })); },
    async setReferralCreditUsed(id: string, invoiceId: string | null) {
      const c = tables.referralCredits.find((x) => x.id === id)!;
      c.usedInvoiceId = invoiceId;
      c.usedAt = invoiceId ? new Date().toISOString() : null;
    },
    async createPaymentReport(input: Parameters<PortalStore["createPaymentReport"]>[0]) {
      // payment_reports_one_pending: one open report per invoice.
      if (tables.paymentReports.some((r) => r.invoiceId === input.invoiceId && r.status === "pending")) return null;
      const r: PaymentReportRecord = { id: randomUUID(), ...input, status: "pending", reviewedByAccountId: null, reviewedAt: null, paymentId: null, createdAt: new Date().toISOString() };
      tables.paymentReports.push(r);
      return { ...r };
    },
    async getPaymentReport(id: string) { const r = tables.paymentReports.find((x) => x.id === id); return r ? { ...r } : null; },
    async listPaymentReports(q: Parameters<PortalStore["listPaymentReports"]>[0]) {
      return tables.paymentReports.filter((r) => (!q.studentIds || q.studentIds.includes(r.studentId)) && (!q.invoiceIds || q.invoiceIds.includes(r.invoiceId)) && (!q.status || r.status === q.status)).map((r) => ({ ...r }));
    },
    async reviewPaymentReport(id: string, input: Parameters<PortalStore["reviewPaymentReport"]>[1]) {
      const r = tables.paymentReports.find((x) => x.id === id);
      if (!r || r.status !== "pending") return false;
      Object.assign(r, { status: input.status, reviewedByAccountId: input.reviewedByAccountId, reviewedAt: new Date().toISOString(), paymentId: input.paymentId });
      return true;
    },
    async setPaymentReportPayment(id: string, paymentId: string) { tables.paymentReports.find((x) => x.id === id)!.paymentId = paymentId; },
    async setInvoiceStripeSession() {},
    async claimStripeEvent(id: string) { if (tables.stripeEvents.includes(id)) return false; tables.stripeEvents.push(id); return true; },
  };
  return store satisfies Partial<PortalStore> & { tables: CoreTables };
}

/** A lesson row for fixtures. */
export function lessonRow(studentId: string, startsAt: string, over: Partial<LessonRecord> = {}): LessonRecord {
  return {
    id: randomUUID(), studentId, teacherAccountId: TEACHER_ACCOUNT, startsAt, endsAt: new Date(new Date(startsAt).getTime() + 3600000).toISOString(),
    locationKind: "in_person", location: "Music City SF, Room 4, 1353 Bush St", zoomUrl: null, status: "scheduled", cancelledAt: null,
    cancellationReason: null, rescheduledFromId: null, createdAt: new Date().toISOString(), holdExpiresAt: null, invoiceId: null, seriesId: null, lateCancel: false, ...over,
  };
}

/** An invoice row for fixtures. Amounts are in cents. */
export function invoiceRow(studentId: string, payerId: string | null, totalCents: number, over: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: randomUUID(), number: 2001, studentId, payerId, payerName: "", payerEmail: null, title: "Lesson", currency: "USD", totalCents, amountPaidCents: 0,
    status: "sent", issueDate: "2026-11-01", dueDate: "2026-11-08", createdAt: new Date().toISOString(),
    lines: [{ label: "60-min lesson", amountCents: totalCents, lessonId: null }], kind: "manual", paymentMethodChoice: "zelle", packageLessons: 0, ...over,
  };
}
