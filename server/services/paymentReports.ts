// Manual payments (Zelle today) as report-then-confirm. Zelle has no links, API or webhooks, so the payer sends
// money in their own bank app and reports it here. A report never marks an invoice paid: only the teacher's
// Confirm records a payment. Not received closes the report and the invoice stays unpaid. No email is sent.
import { z } from "zod";
import { invoiceMemo, type PaymentReportDTO, type TeacherPaymentReportDTO, type ZelleDetailsDTO } from "../../shared/portal-types.js";
import { ApiError, notFound } from "../http.js";
import type { InvoiceRecord, PaymentReportRecord, PortalStore, StudentRecord } from "../store/types.js";
import { amountDueCents, markInvoicePaid, recordPartPayment, toInvoiceDTO } from "./billing.js";
import { teacherFor, type PortalContext } from "./context.js";

export const ASK_TEACHER = "Ask your teacher how to pay.";

export function toReportDTO(r: PaymentReportRecord): PaymentReportDTO {
  return {
    id: r.id,
    invoiceId: r.invoiceId,
    method: r.method,
    amount: r.amountCents === null ? null : r.amountCents / 100,
    note: r.note,
    status: r.status,
    reportedAt: r.createdAt,
    reviewedAt: r.reviewedAt,
  };
}

const isUnpaid = (inv: InvoiceRecord) => (inv.status === "sent" || inv.status === "partially_paid") && amountDueCents(inv) > 0;

async function openReport(store: PortalStore, invoiceId: string) {
  return (await store.listPaymentReports({ invoiceIds: [invoiceId], status: "pending" }))[0] ?? null;
}

/** Zelle details for one invoice. The recipient comes from the teacher's settings; blank hides Zelle. */
export async function zelleDetails(store: PortalStore, invoice: InvoiceRecord, student: StudentRecord): Promise<ZelleDetailsDTO> {
  const teacherId = await teacherFor(store, student);
  const settings = teacherId ? await store.getSettings(teacherId) : null;
  const report = await openReport(store, invoice.id);
  const base = { amountDue: amountDueCents(invoice) / 100, memo: invoiceMemo(invoice.number), report: report ? toReportDTO(report) : null };
  const recipient = settings?.zelleRecipient.trim() ?? "";
  if (!recipient) return { available: false, message: ASK_TEACHER, ...base };
  return { available: true, recipient, qrDataUrl: settings?.zelleQrDataUrl ?? null, ...base };
}

export const reportSchema = z.object({
  method: z.string().trim().toLowerCase().regex(/^[a-z][a-z_]{1,31}$/).default("zelle"),
  amount: z.number().finite().positive().max(100000).transform((d) => Math.round(d * 100)).optional(),
  note: z.string().trim().max(500).default(""),
});

/** "I've sent it." Records a pending report. The invoice is not marked paid. */
export async function reportPayment(store: PortalStore, invoice: InvoiceRecord, input: z.infer<typeof reportSchema>, accountId: string) {
  if (!isUnpaid(invoice)) throw new ApiError(409, "invoice_not_payable", "This invoice has nothing left to pay.");
  const report = await store.createPaymentReport({
    invoiceId: invoice.id, studentId: invoice.studentId, reportedByAccountId: accountId,
    method: input.method, amountCents: input.amount ?? null, note: input.note,
  });
  if (!report) throw new ApiError(409, "report_pending", "A payment for this invoice is already waiting for confirmation.");
  return toReportDTO(report);
}

export async function teacherReportList(store: PortalStore, students: StudentRecord[], status: PaymentReportRecord["status"] | undefined): Promise<TeacherPaymentReportDTO[]> {
  const reports = await store.listPaymentReports({ studentIds: students.map((s) => s.id), status });
  const invoices = new Map((await Promise.all([...new Set(reports.map((r) => r.invoiceId))].map((id) => store.getInvoice(id)))).filter(Boolean).map((i) => [i!.id, i!]));
  const accounts = new Map((await Promise.all([...new Set(reports.map((r) => r.reportedByAccountId))].map((id) => store.getAccount(id)))).filter(Boolean).map((a) => [a!.id, a!]));
  const names = new Map(students.map((s) => [s.id, s.fullName]));
  return reports.map((r) => {
    const inv = invoices.get(r.invoiceId);
    return {
      ...toReportDTO(r),
      studentId: r.studentId,
      studentName: names.get(r.studentId) ?? "",
      invoiceNumber: inv ? String(inv.number) : "",
      memo: inv ? invoiceMemo(inv.number) : "",
      amountDue: inv ? amountDueCents(inv) / 100 : 0,
      reportedBy: accounts.get(r.reportedByAccountId)?.displayName ?? "",
    };
  });
}

export const confirmSchema = z.object({
  amount: z.number().finite().positive().max(100000).transform((d) => Math.round(d * 100)).optional(),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reference: z.string().trim().max(200).default(""),
});

/**
 * Confirm: the money arrived. Claims the report first (so a double click can't record twice), then records a
 * payment in the existing payment history with the report's method, which updates the amount paid, the payment
 * status and the balance. The full amount due runs the paid side effects (credits, confirming a held lesson).
 */
export async function confirmReport(ctx: PortalContext, report: PaymentReportRecord, input: z.infer<typeof confirmSchema>, teacherAccountId: string) {
  const { store } = ctx;
  if (report.status !== "pending") throw new ApiError(409, "report_closed", "That report was already reviewed.");
  const invoice = await store.getInvoice(report.invoiceId);
  if (!invoice) throw notFound("That invoice wasn't found.");
  if (!isUnpaid(invoice)) throw new ApiError(409, "invoice_not_payable", "This invoice has nothing left to pay.");
  const due = amountDueCents(invoice);
  const amountCents = Math.min(input.amount ?? report.amountCents ?? due, due);
  if (!(await store.reviewPaymentReport(report.id, { status: "confirmed", reviewedByAccountId: teacherAccountId, paymentId: null }))) {
    throw new ApiError(409, "report_closed", "That report was already reviewed.");
  }
  const note = `Reported by the payer${report.note ? `: ${report.note}` : ""}`;
  const result = amountCents >= due
    ? await markInvoicePaid(ctx, invoice.id, { method: report.method, paidAt: input.paidAt, reference: input.reference, note, actorAccountId: teacherAccountId })
    : await recordPartPayment(ctx, invoice.id, { amount: amountCents, method: report.method, note, reference: input.reference }, teacherAccountId);
  if (result.payment) await store.setPaymentReportPayment(report.id, result.payment.id);
  const closed = (await store.getPaymentReport(report.id))!;
  return { report: toReportDTO(closed), invoice: result.invoice, payment: result.payment };
}

/** Not received: the report is kept for history and the invoice stays (or returns to) unpaid. */
export async function rejectReport(store: PortalStore, report: PaymentReportRecord, teacherAccountId: string) {
  if (report.status !== "pending") throw new ApiError(409, "report_closed", "That report was already reviewed.");
  if (!(await store.reviewPaymentReport(report.id, { status: "not_received", reviewedByAccountId: teacherAccountId, paymentId: null }))) {
    throw new ApiError(409, "report_closed", "That report was already reviewed.");
  }
  const invoice = await store.getInvoice(report.invoiceId);
  return { report: toReportDTO((await store.getPaymentReport(report.id))!), invoice: invoice ? toInvoiceDTO(invoice) : null };
}
