// Invoices, balances, payments and credits, all in Supabase. Zelle and cash are paid offline: an invoice waits
// ("awaiting payment") until the teacher marks it paid. Only then are package credits added or a held session
// confirmed. Card payments (Stripe test mode) mark invoices paid through the same path.
import { z } from "zod";
import type { BillingDTO, InvoiceDTO, PaymentDTO, PaymentReportDTO } from "../../shared/portal-types.js";
import { PACKAGE_LESSONS, PACKAGE_PRICE_CENTS, REFERRER_CREDIT_CENTS, SESSION_PRICE_CENTS, type PackageMethod } from "../../shared/pricing.js";
import { ApiError, notFound } from "../http.js";
import type { InvoiceKind, InvoiceRecord, InvoiceRecordStatus, PaymentMethod, PaymentMethodChoice, PaymentRecord, PortalStore, StudentRecord } from "../store/types.js";
import { teacherFor, type PortalContext } from "./context.js";
import { notify } from "./notify.js";

const CLOSED = new Set(["draft", "void", "paid"]);
const dollars = (cents: number) => Math.round(cents) / 100;

export const amountDueCents = (inv: Pick<InvoiceRecord, "totalCents" | "amountPaidCents">) => Math.max(inv.totalCents - inv.amountPaidCents, 0);

export function toInvoiceDTO(inv: InvoiceRecord, report: PaymentReportDTO | null = null): InvoiceDTO {
  return {
    id: inv.id,
    number: String(inv.number),
    title: inv.title || "Invoice",
    status: inv.status,
    liveMode: true,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    total: dollars(inv.totalCents),
    amountDue: dollars(amountDueCents(inv)),
    amountPaid: dollars(inv.amountPaidCents),
    currency: inv.currency,
    contactId: inv.payerId ?? "",
    contactName: inv.payerName,
    studentId: inv.studentId,
    lines: inv.lines.map((l) => ({ label: l.label, amount: dollars(l.amountCents) })),
    payUrl: null,
    kind: inv.kind,
    paymentMethod: inv.paymentMethodChoice,
    paymentReport: report,
  };
}

export function toPaymentDTO(p: PaymentRecord, invoices: InvoiceRecord[]): PaymentDTO {
  return {
    id: p.id,
    invoiceId: p.invoiceId,
    invoiceNumber: String(invoices.find((i) => i.id === p.invoiceId)?.number ?? ""),
    amount: dollars(p.amountCents),
    method: p.method,
    status: p.status,
    paidAt: p.paidAt,
    reference: p.reference,
  };
}

/** Anything not draft, void or paid with money still due is outstanding, and blocks booking. */
export const isOutstanding = (inv: InvoiceDTO) => inv.liveMode !== false && !CLOSED.has(inv.status) && inv.amountDue > 0;

/** Payment status from what has been paid so far. Draft and void are set by the teacher and never derived. */
export function derivePaymentStatus(totalCents: number, paidCents: number, current: InvoiceRecordStatus): InvoiceRecordStatus {
  if (current === "void" || current === "draft") return current;
  if (paidCents >= totalCents) return "paid";
  if (paidCents > 0) return "partially_paid";
  return "sent";
}

/** The billing panel for one student's invoices and payments, with any open payment report on each invoice. */
export function buildBilling(invoices: InvoiceRecord[], payments: PaymentRecord[], cardPayments = false, reports: PaymentReportDTO[] = []): BillingDTO {
  const reportFor = (id: string) => reports.find((r) => r.invoiceId === id && r.status === "pending") ?? null;
  const visible = invoices.filter((i) => i.status !== "draft").map((i) => toInvoiceDTO(i, reportFor(i.id)));
  const openInvoices = visible.filter(isOutstanding);
  return {
    outstanding: dollars(openInvoices.reduce((sum, i) => sum + Math.round(i.amountDue * 100), 0)),
    openInvoices,
    history: visible,
    bookingBlocked: openInvoices.length > 0,
    paymentsOpen: cardPayments,
    payments: payments.filter((p) => p.status === "succeeded").map((p) => toPaymentDTO(p, invoices)),
  };
}

export async function getStudentBilling(store: Pick<PortalStore, "listInvoices" | "listPayments" | "listPaymentReports">, studentId: string, cardPayments = false): Promise<BillingDTO> {
  const invoices = await store.listInvoices({ studentIds: [studentId], includeDrafts: false });
  const [payments, reports] = await Promise.all([
    store.listPayments(invoices.map((i) => i.id)),
    store.listPaymentReports({ invoiceIds: invoices.map((i) => i.id), status: "pending" }),
  ]);
  return buildBilling(invoices, payments, cardPayments, reports.map(reportDTO));
}

const reportDTO = (r: { id: string; invoiceId: string; method: string; amountCents: number | null; note: string; status: PaymentReportDTO["status"]; createdAt: string; reviewedAt: string | null }): PaymentReportDTO => ({
  id: r.id, invoiceId: r.invoiceId, method: r.method, amount: r.amountCents === null ? null : r.amountCents / 100, note: r.note, status: r.status, reportedAt: r.createdAt, reviewedAt: r.reviewedAt,
});

/** Invoices with their open payment report, for the teacher's list. */
export async function invoicesWithReports(store: Pick<PortalStore, "listPaymentReports">, invoices: InvoiceRecord[]) {
  const reports = await store.listPaymentReports({ invoiceIds: invoices.map((i) => i.id), status: "pending" });
  return invoices.map((i) => toInvoiceDTO(i, (() => { const r = reports.find((x) => x.invoiceId === i.id); return r ? reportDTO(r) : null; })()));
}

const todayIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Creates an invoice with the referral adjustments that apply to this student:
 *  - $15 off the referred student's first invoice
 *  - each unused $25 referrer credit comes off the next invoice, exactly once, never below $0
 * Then emails the payer the invoice with payment instructions.
 */
export async function issueInvoice(ctx: PortalContext, input: {
  student: StudentRecord;
  kind: InvoiceKind;
  title: string;
  lines: { label: string; amountCents: number; lessonId: string | null }[];
  method: PaymentMethodChoice | null;
  packageLessons?: number;
  draft?: boolean;
  dueDate?: string;
  issueDate?: string;
  actorAccountId: string | null;
}): Promise<InvoiceRecord> {
  const { store } = ctx;
  const lines = [...input.lines];
  let subtotal = lines.reduce((s, l) => s + l.amountCents, 0);
  const referral = input.draft ? null : await store.getReferralForReferred(input.student.id);
  const applyDiscount = !!referral && referral.status === "pending" && !referral.discountInvoiceId && subtotal > 0;
  if (applyDiscount) {
    const off = Math.min(referral!.discountCents, subtotal);
    lines.push({ label: "Referral discount", amountCents: -off, lessonId: null });
    subtotal -= off;
  }
  const credits = input.draft ? [] : (await store.listReferralCredits([input.student.id])).filter((c) => !c.usedInvoiceId);
  const usedCredits: string[] = [];
  for (const credit of credits) {
    if (subtotal <= 0) break;
    const off = Math.min(credit.amountCents, subtotal);
    lines.push({ label: "Referral credit", amountCents: -off, lessonId: null });
    subtotal -= off;
    usedCredits.push(credit.id);
  }
  const issueDate = input.issueDate ?? todayIso(ctx.now());
  const created = await store.createInvoice({
    studentId: input.student.id,
    payerId: input.student.payerId,
    title: input.title,
    issueDate,
    dueDate: input.dueDate ?? issueDate,
    status: input.draft ? "draft" : "sent",
    lines,
    createdByAccountId: input.actorAccountId,
    kind: input.kind,
    paymentMethodChoice: input.method,
    packageLessons: input.packageLessons ?? 0,
  });
  if (applyDiscount) await store.updateReferral(referral!.id, { discountInvoiceId: created.id });
  for (const id of usedCredits) await store.setReferralCreditUsed(id, created.id);
  if (input.draft) return created;
  // A $0 invoice (fully covered by credits) is settled at once.
  if (created.totalCents === 0) {
    const paid = await store.updateInvoiceStatus(created.id, { status: "paid" });
    await onInvoicePaid(ctx, paid);
    return paid;
  }
  const teacher = await teacherFor(store, input.student);
  if (teacher) await notify.invoiceIssued(ctx, created, input.student, await store.getSettings(teacher));
  return created;
}

/** Side effects of an invoice becoming paid. Each step is idempotent, so a repeat call changes nothing. */
export async function onInvoicePaid(ctx: PortalContext, invoice: InvoiceRecord) {
  const { store } = ctx;
  if (invoice.kind === "package" && invoice.packageLessons > 0) {
    await store.addCredit({ studentId: invoice.studentId, delta: invoice.packageLessons, reason: "package_paid", invoiceId: invoice.id });
  }
  for (const lesson of await store.listLessonsByInvoice(invoice.id)) {
    if (lesson.status === "pending_payment") await store.updateLesson(lesson.id, { status: "scheduled", holdExpiresAt: null });
  }
  const referral = await store.getReferralForReferred(invoice.studentId);
  if (referral && referral.status === "pending" && referral.discountInvoiceId === invoice.id) {
    await store.updateReferral(referral.id, { status: "completed", completedAt: new Date(ctx.now()).toISOString() });
    await store.createReferralCredit({ referralId: referral.id, studentId: referral.referrerStudentId, amountCents: REFERRER_CREDIT_CENTS });
  }
}

export const markPaidSchema = z.object({
  method: z.enum(["zelle", "cash", "card", "check", "bank_transfer", "other"]).default("zelle"),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reference: z.string().trim().max(200).default(""),
});

/**
 * Records the full amount due and marks the invoice paid. A second call on a paid invoice is a no-op,
 * so a repeated click or webhook can't add credits or payments twice.
 */
export async function markInvoicePaid(ctx: PortalContext, invoiceId: string, input: { method: PaymentMethod; paidAt?: string; reference?: string; note?: string; actorAccountId: string | null }) {
  const { store } = ctx;
  const invoice = await store.getInvoice(invoiceId);
  if (!invoice) throw notFound("That invoice wasn't found.");
  if (invoice.status === "paid") return { invoice: toInvoiceDTO(invoice), payment: null, alreadyPaid: true };
  if (invoice.status === "void" || invoice.status === "draft") throw new ApiError(409, "invoice_not_payable", "Only an issued invoice can be marked paid.");
  const due = amountDueCents(invoice);
  const payment = due > 0
    ? await store.recordPayment({ invoiceId, payerId: invoice.payerId, amountCents: due, method: input.method, note: input.note ?? "", reference: input.reference ?? "", paidAt: input.paidAt ? new Date(`${input.paidAt}T12:00:00Z`).toISOString() : undefined, recordedByAccountId: input.actorAccountId })
    : null;
  const updated = await store.updateInvoiceStatus(invoiceId, { amountPaidCents: invoice.totalCents, status: "paid" });
  await onInvoicePaid(ctx, updated);
  const student = await store.getStudent(updated.studentId);
  if (student) await notify.paymentReceived(ctx, updated, student);
  return { invoice: toInvoiceDTO(updated), payment: payment ? toPaymentDTO(payment, [updated]) : null, alreadyPaid: false };
}

export const paymentSchema = z.object({
  amount: z.number().finite().positive().max(100000).transform((d) => Math.round(d * 100)).optional(),
  method: z.enum(["zelle", "cash", "card", "manual", "check", "bank_transfer", "other"]).default("manual"),
  note: z.string().trim().max(500).default(""),
  reference: z.string().trim().max(200).default(""),
});

/** A part payment. When it covers the rest, the invoice becomes paid with the same side effects. */
export async function recordPartPayment(ctx: PortalContext, invoiceId: string, input: { amount?: number; method: PaymentMethod; note: string; reference: string }, actorAccountId: string) {
  const { store } = ctx;
  const invoice = await store.getInvoice(invoiceId);
  if (!invoice) throw notFound("That invoice wasn't found.");
  if (invoice.status === "void" || invoice.status === "draft" || invoice.status === "paid") throw new ApiError(409, "invoice_not_payable", "Only an unpaid, issued invoice can take a payment.");
  const due = amountDueCents(invoice);
  const amountCents = input.amount ?? due;
  if (amountCents > due) throw new ApiError(400, "invalid_input", "That is more than the amount due.");
  if (amountCents === due) return markInvoicePaid(ctx, invoiceId, { method: input.method, reference: input.reference, note: input.note, actorAccountId });
  const payment = await store.recordPayment({ invoiceId, payerId: invoice.payerId, amountCents, method: input.method, note: input.note, reference: input.reference, recordedByAccountId: actorAccountId });
  const paid = invoice.amountPaidCents + amountCents;
  const updated = await store.updateInvoiceStatus(invoiceId, { amountPaidCents: paid, status: derivePaymentStatus(invoice.totalCents, paid, invoice.status) });
  return { invoice: toInvoiceDTO(updated), payment: toPaymentDTO(payment, [updated]), alreadyPaid: false };
}

/**
 * Voids an unpaid invoice and undoes what it reserved: a held session is released, the referral discount and
 * any referrer credit it used become available again.
 */
export async function voidInvoice(ctx: PortalContext, invoiceId: string, opts: { releaseLessons?: boolean } = {}) {
  const { store } = ctx;
  const invoice = await store.getInvoice(invoiceId);
  if (!invoice) throw notFound("That invoice wasn't found.");
  if (invoice.status === "void") return toInvoiceDTO(invoice);
  if (invoice.amountPaidCents > 0) throw new ApiError(409, "invoice_has_payments", "This invoice has payments recorded, so it can't be voided.");
  const updated = await store.updateInvoiceStatus(invoiceId, { status: "void" });
  const referral = await store.getReferralForReferred(invoice.studentId);
  if (referral && referral.discountInvoiceId === invoiceId && referral.status === "pending") await store.updateReferral(referral.id, { discountInvoiceId: null });
  for (const credit of await store.listReferralCredits([invoice.studentId])) {
    if (credit.usedInvoiceId === invoiceId) await store.setReferralCreditUsed(credit.id, null);
  }
  if (opts.releaseLessons !== false) {
    for (const lesson of await store.listLessonsByInvoice(invoiceId)) {
      if (lesson.status === "pending_payment") await store.closeLesson(lesson.id, { status: "released", byAccountId: null, reason: "Invoice voided" });
    }
  }
  return toInvoiceDTO(updated);
}

export async function issueDraft(ctx: PortalContext, invoiceId: string) {
  const { store } = ctx;
  const invoice = await store.getInvoice(invoiceId);
  if (!invoice) throw notFound("That invoice wasn't found.");
  if (invoice.status !== "draft") throw new ApiError(409, "invoice_not_draft", "Only a draft invoice can be issued.");
  const updated = await store.updateInvoiceStatus(invoiceId, { status: "sent" });
  const student = await store.getStudent(updated.studentId);
  const teacher = student ? await teacherFor(store, student) : null;
  if (student && teacher) await notify.invoiceIssued(ctx, updated, student, await store.getSettings(teacher));
  return toInvoiceDTO(updated);
}

export const packageSchema = z.object({
  studentId: z.string().uuid(),
  method: z.enum(["zelle", "cash", "card"]),
});

/**
 * A 4-lesson package invoice: $380 by Zelle (or card), $375 in cash. It waits for payment; credits are added
 * only when it is marked paid. An unpaid package invoice for the same student is returned instead of a second one.
 */
export async function buyPackage(ctx: PortalContext, student: StudentRecord, method: PackageMethod, actorAccountId: string, cardPayments: boolean) {
  if (method === "card" && !cardPayments) throw new ApiError(400, "card_payments_off", "Card payments aren't available. Choose Zelle or cash.");
  const open = (await ctx.store.listInvoices({ studentIds: [student.id], includeDrafts: false }))
    .find((i) => i.kind === "package" && (i.status === "sent" || i.status === "partially_paid"));
  if (open) return { invoice: open, existing: true };
  const label = method === "cash" ? "4-lesson package (cash)" : method === "card" ? "4-lesson package (card)" : "4-lesson package (Zelle)";
  const invoice = await issueInvoice(ctx, {
    student, kind: "package", title: "4-lesson package", method, packageLessons: PACKAGE_LESSONS, actorAccountId,
    lines: [{ label, amountCents: PACKAGE_PRICE_CENTS[method], lessonId: null }],
  });
  return { invoice, existing: false };
}

/** The $100 invoice for one held session. */
export function sessionInvoice(ctx: PortalContext, student: StudentRecord, lessonId: string, label: string, actorAccountId: string | null) {
  return issueInvoice(ctx, {
    student, kind: "session", title: "Single session", method: "zelle", actorAccountId,
    lines: [{ label, amountCents: SESSION_PRICE_CENTS, lessonId }],
  });
}

const cents = z.number().finite().positive().max(100000).transform((d) => Math.round(d * 100));
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const newInvoiceSchema = z.object({
  studentId: z.string().uuid(),
  title: z.string().trim().max(200).default(""),
  issueDate: dateOnly.optional(),
  dueDate: dateOnly.optional(),
  draft: z.boolean().optional(),
  method: z.enum(["zelle", "cash"]).default("zelle"),
  lines: z.array(z.object({ label: z.string().trim().min(1).max(200), amount: cents, lessonId: z.string().uuid().nullable().optional() })).min(1).max(50),
});

/** A teacher's manual invoice. */
export async function createManualInvoice(ctx: PortalContext, student: StudentRecord, input: z.infer<typeof newInvoiceSchema>, actorAccountId: string) {
  const issueDate = input.issueDate ?? todayIso(ctx.now());
  const dueDate = input.dueDate ?? issueDate;
  if (dueDate < issueDate) throw new ApiError(400, "invalid_input", "The due date can't be before the issue date.");
  const created = await issueInvoice(ctx, {
    student, kind: "manual", title: input.title || input.lines[0].label, method: input.method, draft: input.draft, issueDate, dueDate, actorAccountId,
    lines: input.lines.map((l) => ({ label: l.label, amountCents: l.amount, lessonId: l.lessonId ?? null })),
  });
  return toInvoiceDTO(created);
}
