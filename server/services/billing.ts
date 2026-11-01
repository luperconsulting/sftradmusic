import type { BillingDTO, InvoiceDTO } from "../../shared/portal-types.js";
import { ApiError, forbidden, notConfigured } from "../http.js";
import { toInvoiceDTO, type GhlClient } from "../integrations/ghl.js";

// Statuses that can't leave money owing. Anything else with money due counts as outstanding, so an
// unfamiliar status from GoHighLevel blocks booking rather than letting it through.
const CLOSED = new Set(["draft", "void", "paid"]);

export const isOutstanding = (inv: InvoiceDTO) => !CLOSED.has(inv.status) && inv.amountDue > 0;

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
  const visible = all.filter((i) => i.status !== "draft");
  const openInvoices = visible.filter(isOutstanding);
  return {
    outstanding: openInvoices.reduce((sum, i) => sum + i.amountDue, 0),
    openInvoices,
    history: visible,
    bookingBlocked: openInvoices.length > 0,
  };
}

/** The real payment URL for an invoice the payer owns. Status is never changed here. */
export async function getInvoicePaymentLink(ghl: GhlClient, payerContactIds: string[], invoiceId: string) {
  const invoice = toInvoiceDTO(await ghl.getInvoice(invoiceId));
  if (!payerContactIds.includes(invoice.contactId)) throw forbidden();
  if (!isOutstanding(invoice)) throw new ApiError(409, "invoice_not_payable", "This invoice has nothing left to pay.");
  const { paymentUrlTemplate, paymentHosts } = ghl.config;
  if (!paymentUrlTemplate) throw notConfigured("Online invoice payment");
  const url = new URL(paymentUrlTemplate.replace("{invoiceId}", encodeURIComponent(invoice.id)));
  if (url.protocol !== "https:" || !paymentHosts.includes(url.hostname.toLowerCase())) throw notConfigured("Online invoice payment");
  return { url: url.toString(), amountDue: invoice.amountDue };
}
