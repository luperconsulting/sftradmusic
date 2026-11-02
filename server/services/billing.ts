import type { BillingDTO, InvoiceDTO } from "../../shared/portal-types.js";
import { ApiError, forbidden } from "../http.js";
import { toInvoiceDTO, type GhlClient } from "../integrations/ghl.js";

// Statuses that can't leave money owing. Anything else with money due counts as outstanding, so an
// unfamiliar status from GoHighLevel blocks booking rather than letting it through.
const CLOSED = new Set(["draft", "void", "paid"]);

// Test-mode invoices aren't real debts, so they must not block a family from booking.
export const isOutstanding = (inv: InvoiceDTO) => inv.liveMode !== false && !CLOSED.has(inv.status) && inv.amountDue > 0;

export async function listAllInvoices(ghl: GhlClient, contactId: string): Promise<InvoiceDTO[]> {
  const out: InvoiceDTO[] = [];
  const limit = 100;
  for (let offset = 0; offset < 5000; offset += limit) {
    const page = await ghl.listInvoices({ contactId, limit, offset });
    // Re-check ownership on every row: an ignored filter must never show another family's invoice.
    out.push(...page.invoices.map(toInvoiceDTO).filter((i) => i.contactId === contactId));
    if (page.invoices.length < limit) break;
  }
  return out;
}

export async function getBilling(ghl: GhlClient, payerContactId: string): Promise<BillingDTO> {
  const all = await listAllInvoices(ghl, payerContactId);
  const visible = all.filter((i) => i.status !== "draft" && i.liveMode !== false);
  const openInvoices = visible.filter(isOutstanding);
  return {
    outstanding: openInvoices.reduce((sum, i) => sum + i.amountDue, 0),
    openInvoices,
    history: visible,
    bookingBlocked: openInvoices.length > 0,
  };
}

export const LINK_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Pay Now's server side. Live invoice responses have no hosted payment URL, so GoHighLevel sends its own invoice,
 * with its own payment link, to the contact on the invoice. No URL is built here, and no recipient comes from the
 * browser. Payment status is never changed.
 */
export async function sendInvoicePaymentLink(
  ghl: GhlClient,
  payerContactIds: string[],
  invoiceId: string,
  lastSentAt: (invoiceId: string) => Promise<string | null>,
) {
  const invoice = toInvoiceDTO(await ghl.getInvoice(invoiceId));
  if (!payerContactIds.includes(invoice.contactId)) throw forbidden();
  if (!isOutstanding(invoice)) throw new ApiError(409, "invoice_not_payable", "This invoice has nothing left to pay.");
  const senderId = ghl.config.invoiceSenderUserId;
  if (!senderId) {
    throw new ApiError(503, "payment_link_unavailable", "Paying from the portal isn't available yet. Please use the payment link in your invoice email or text, or contact Zane.");
  }
  const last = await lastSentAt(invoice.id);
  if (last && Date.now() - new Date(last).getTime() < LINK_COOLDOWN_MS) {
    throw new ApiError(429, "link_recently_sent", ghl.config.safeMode
      ? "That was just recorded. Please wait a few minutes before trying again."
      : "We just sent your payment link. Please check your email.");
  }
  // Safe mode never reaches GoHighLevel. The client refuses too, in case another caller forgets.
  if (ghl.config.safeMode) {
    console.info(`[ghl] safe mode: would email invoice ${invoice.id} (liveMode=${invoice.liveMode !== false}). No email or SMS was sent.`);
    return { sent: false, suppressed: true, invoiceId: invoice.id, amountDue: invoice.amountDue };
  }
  await ghl.sendInvoice(invoice.id, { userId: senderId, liveMode: invoice.liveMode !== false });
  return { sent: true, suppressed: false, invoiceId: invoice.id, amountDue: invoice.amountDue };
}
