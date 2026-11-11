// Referrals: one code per student. A new student who signs up with a code gets $15 off their first invoice.
// When that invoice is paid, the referrer earns a $25 credit that comes off their next invoice, exactly once.
// (The discount and credit lines are added in billing.issueInvoice; completion happens in billing.onInvoicePaid.)
import type { ReferralPanelDTO } from "../../shared/portal-types.js";
import { REFERRAL_DISCOUNT_CENTS } from "../../shared/pricing.js";
import { ApiError } from "../http.js";
import type { PortalStore } from "../store/types.js";

export const REFERRAL_CODE = /^SFTM-[A-Z0-9]{8}$/;

export function referralCodeFor(studentId: string) {
  return `SFTM-${studentId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/** The student's code, saved on first use so it can be looked up later. */
export async function ensureReferralCode(store: PortalStore, studentId: string) {
  const existing = await store.getReferralCode(studentId);
  if (existing) return existing;
  const code = referralCodeFor(studentId);
  await store.saveReferralCode(studentId, code);
  return code;
}

/**
 * Links a new student to the referrer behind `code`. Only before their first invoice, never to themself, once.
 */
export async function applyReferralCode(store: PortalStore, referredStudentId: string, rawCode: string) {
  const code = rawCode.trim().toUpperCase();
  if (!REFERRAL_CODE.test(code)) throw new ApiError(400, "invalid_referral_code", "That referral code isn't valid.");
  const referrer = await store.findStudentByReferralCode(code);
  if (!referrer) throw new ApiError(404, "invalid_referral_code", "That referral code isn't valid.");
  if (referrer === referredStudentId) throw new ApiError(400, "invalid_referral_code", "You can't use your own referral code.");
  if (await store.getReferralForReferred(referredStudentId)) throw new ApiError(409, "referral_exists", "A referral code was already used for this student.");
  const invoices = await store.listInvoices({ studentIds: [referredStudentId], includeDrafts: false });
  if (invoices.some((i) => i.status !== "void")) throw new ApiError(409, "referral_too_late", "Referral codes apply only before the first invoice.");
  const referral = await store.createReferral({ referrerStudentId: referrer, referredStudentId, code, discountCents: REFERRAL_DISCOUNT_CENTS });
  if (!referral) throw new ApiError(409, "referral_exists", "A referral code was already used for this student.");
  return referral;
}

/** The side panel: code, totals, pending and completed lists, credits earned and used. */
export async function referralPanel(store: PortalStore, studentId: string): Promise<ReferralPanelDTO> {
  const code = await ensureReferralCode(store, studentId);
  const [mine, credits, referredBy] = await Promise.all([
    store.listReferrals({ referrerStudentIds: [studentId] }),
    store.listReferralCredits([studentId]),
    store.getReferralForReferred(studentId),
  ]);
  const people = await store.getStudents(mine.map((r) => r.referredStudentId));
  const nameOf = (id: string) => people.find((p) => p.id === id)?.firstName ?? "A new student";
  const earned = credits.reduce((s, c) => s + c.amountCents, 0);
  const used = credits.filter((c) => c.usedInvoiceId).reduce((s, c) => s + c.amountCents, 0);
  return {
    code,
    totalReferred: mine.length,
    pending: mine.filter((r) => r.status === "pending").map((r) => ({ name: nameOf(r.referredStudentId), since: r.createdAt })),
    completed: mine.filter((r) => r.status === "completed").map((r) => ({ name: nameOf(r.referredStudentId), completedAt: r.completedAt ?? r.createdAt })),
    creditsEarnedCents: earned,
    creditsUsedCents: used,
    creditsAvailableCents: earned - used,
    referredBy: referredBy ? { code: referredBy.code, discountPending: referredBy.status === "pending" && !referredBy.discountInvoiceId } : null,
  };
}
