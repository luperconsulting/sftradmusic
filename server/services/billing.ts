// Balances, invoice history and payment history, all read from Supabase. Nothing here charges a card or
// sends email. "Mark paid" records a payment the teacher already received outside the portal.
import { z } from "zod";
import type { BillingDTO, InvoiceDTO, PaymentDTO } from "../../shared/portal-types.js";
import { ApiError, notFound } from "../http.js";
import type { InvoiceRecord, InvoiceRecordStatus, PaymentRecord, PortalStore, StudentRecord } from "../store/types.js";

const CLOSED = new Set(["draft", "void", "paid"]);
const dollars = (cents: number) => Math.round(cents) / 100;

export const amountDueCents = (inv: Pick<InvoiceRecord, "totalCents" | "amountPaidCents">) => Math.max(inv.totalCents - inv.amountPaidCents, 0);

export function toInvoiceDTO(inv: InvoiceRecord): InvoiceDTO {
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

/** The billing panel for a set of invoices (already scoped to one student) and their payments. */
export function buildBilling(invoices: InvoiceRecord[], payments: PaymentRecord[]): BillingDTO {
  const visible = invoices.filter((i) => i.status !== "draft").map(toInvoiceDTO);
  const openInvoices = visible.filter(isOutstanding);
  return {
    outstanding: dollars(openInvoices.reduce((sum, i) => sum + Math.round(i.amountDue * 100), 0)),
    openInvoices,
    history: visible,
    bookingBlocked: openInvoices.length > 0,
    paymentsOpen: false,
    payments: payments.filter((p) => p.status === "succeeded").map((p) => toPaymentDTO(p, invoices)),
  };
}

export async function getStudentBilling(store: Pick<PortalStore, "listInvoices" | "listPayments">, studentId: string): Promise<BillingDTO> {
  const invoices = await store.listInvoices({ studentIds: [studentId], includeDrafts: false });
  const payments = await store.listPayments(invoices.map((i) => i.id));
  return buildBilling(invoices, payments);
}

const cents = z.number().finite().positive().max(100000).transform((d) => Math.round(d * 100));
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const newInvoiceSchema = z.object({
  studentId: z.string().uuid(),
  title: z.string().trim().max(200).default(""),
  issueDate: dateOnly.optional(),
  dueDate: dateOnly.optional(),
  draft: z.boolean().optional(),
  lines: z.array(z.object({ label: z.string().trim().min(1).max(200), amount: cents, lessonId: z.string().uuid().nullable().optional() })).min(1).max(50),
});

export async function createInvoice(store: PortalStore, student: StudentRecord, input: z.infer<typeof newInvoiceSchema>, actorAccountId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const issueDate = input.issueDate ?? today;
  const dueDate = input.dueDate ?? issueDate;
  if (dueDate < issueDate) throw new ApiError(400, "invalid_input", "The due date can't be before the issue date.");
  const created = await store.createInvoice({
    studentId: student.id,
    payerId: student.payerId,
    title: input.title || input.lines[0].label,
    issueDate,
    dueDate,
    status: input.draft ? "draft" : "sent",
    lines: input.lines.map((l) => ({ label: l.label, amountCents: l.amount, lessonId: l.lessonId ?? null })),
    createdByAccountId: actorAccountId,
  });
  return toInvoiceDTO(created);
}

export const paymentSchema = z.object({
  amount: cents.optional(),
  method: z.enum(["manual", "cash", "check", "card", "bank_transfer", "other"]).default("manual"),
  note: z.string().trim().max(500).default(""),
});

/** Records money the teacher already received. Defaults to the full amount still due. */
export async function recordPayment(store: PortalStore, invoiceId: string, input: z.infer<typeof paymentSchema>, actorAccountId: string) {
  const invoice = await store.getInvoice(invoiceId);
  if (!invoice) throw notFound("That invoice wasn't found.");
  if (invoice.status === "void" || invoice.status === "draft") throw new ApiError(409, "invoice_not_payable", "Only a sent invoice can be marked paid.");
  const due = amountDueCents(invoice);
  if (due <= 0) throw new ApiError(409, "invoice_not_payable", "This invoice has nothing left to pay.");
  const amountCents = input.amount ?? due;
  if (amountCents > due) throw new ApiError(400, "invalid_input", "That is more than the amount due.");
  const payment = await store.recordPayment({ invoiceId, payerId: invoice.payerId, amountCents, method: input.method, note: input.note, recordedByAccountId: actorAccountId });
  const paid = invoice.amountPaidCents + amountCents;
  const updated = await store.updateInvoiceStatus(invoiceId, { amountPaidCents: paid, status: derivePaymentStatus(invoice.totalCents, paid, invoice.status) });
  return { invoice: toInvoiceDTO(updated), payment: toPaymentDTO(payment, [updated]) };
}

export async function setInvoiceState(store: PortalStore, invoiceId: string, action: "send" | "void") {
  const invoice = await store.getInvoice(invoiceId);
  if (!invoice) throw notFound("That invoice wasn't found.");
  if (action === "void") {
    if (invoice.amountPaidCents > 0) throw new ApiError(409, "invoice_has_payments", "This invoice has payments recorded, so it can't be voided.");
    if (invoice.status === "void") return toInvoiceDTO(invoice);
    return toInvoiceDTO(await store.updateInvoiceStatus(invoiceId, { status: "void" }));
  }
  if (invoice.status !== "draft") throw new ApiError(409, "invoice_not_draft", "Only a draft invoice can be issued.");
  // Issuing makes it visible to the family in the portal. No email is sent.
  return toInvoiceDTO(await store.updateInvoiceStatus(invoiceId, { status: derivePaymentStatus(invoice.totalCents, invoice.amountPaidCents, "sent") }));
}
