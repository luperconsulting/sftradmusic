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

/**
 * Pay Now's server side. Verified against the live API: invoice responses contain no hosted payment URL, and no
 * read-only endpoint provides one. So this checks ownership and payability, then says so plainly. A URL is never
 * built from a guessed pattern.
 */
export async function getInvoicePaymentLink(ghl: GhlClient, payerContactIds: string[], invoiceId: string) {
  const invoice = toInvoiceDTO(await ghl.getInvoice(invoiceId));
  if (!payerContactIds.includes(invoice.contactId)) throw forbidden();
  if (!isOutstanding(invoice)) throw new ApiError(409, "invoice_not_payable", "This invoice has nothing left to pay.");
  throw new ApiError(503, "payment_link_unavailable", "Paying from the portal isn't available yet. Please use the payment link in your invoice email or text, or contact Zane.");
}
