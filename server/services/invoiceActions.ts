import { ApiError } from "../http.js";

const ACTIONS = new Set(["send", "remind", "void", "mark-paid"]);

/**
 * Preview-only record of an invoice button. Safe mode logs the action and returns.
 * This function never calls GoHighLevel, so it cannot send, void, or mark an invoice paid.
 */
export function recordInvoiceAction(input: { enabled: boolean; safeMode: boolean; action: string; invoiceId: string }) {
  if (!ACTIONS.has(input.action) || !input.enabled || !input.safeMode) {
    throw new ApiError(501, "feature_not_enabled", "Manage this invoice in GoHighLevel for now. This portal does not send or charge.");
  }
  console.info(`[invoice] safe mode: ${input.action} invoice ${input.invoiceId}. Nothing was sent or charged.`);
  return { ok: true as const, suppressed: true as const, action: input.action, invoiceId: input.invoiceId };
}
