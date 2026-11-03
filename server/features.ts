import type { Features } from "../shared/portal-types.js";

export type FeatureName = keyof Features;

/** Preview turns a flag on only when safe mode can use it without a real charge or an unwanted send. Production stays off. */
export const FEATURE_REVIEWS: Record<FeatureName, { pass: boolean; reason: string }> = {
  packages: { pass: true, reason: "Preview purchase records a placeholder package credit and does not call Stripe or GoHighLevel." },
  autopay: { pass: true, reason: "Preview saves the autopay choice as a Stripe test-mode log. No card is stored and nothing is charged." },
  referrals: { pass: true, reason: "Preview creates a do-not-disturb portal-test contact. Emails off the allowlist are suppressed. The allowlist is logged because there is no transactional mailer." },
  recurring: { pass: true, reason: "Preview books eight weekly lessons through the existing appointment call, which sets toNotify false in safe mode." },
  invoiceActions: { pass: true, reason: "On preview, send, remind, void, and mark-paid only write a log. They never call GoHighLevel, so nothing is sent or charged. Production stays off." },
};

const OFF: Features = { packages: false, autopay: false, referrals: false, recurring: false, invoiceActions: false };

/** Preview may turn on only a flag whose review passed. Production stays off. */
export function featuresForEnv(env: Record<string, string | undefined>): Features {
  if (env.VERCEL_ENV !== "preview") return { ...OFF };
  return {
    packages: FEATURE_REVIEWS.packages.pass,
    autopay: FEATURE_REVIEWS.autopay.pass,
    referrals: FEATURE_REVIEWS.referrals.pass,
    recurring: FEATURE_REVIEWS.recurring.pass,
    invoiceActions: FEATURE_REVIEWS.invoiceActions.pass,
  };
}
