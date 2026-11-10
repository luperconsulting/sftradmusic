import type { Features } from "../shared/portal-types.js";

export type FeatureName = keyof Features;

/** Preview turns a flag on only when safe mode can use it without a real charge or an unwanted send. Production stays off. */
export const FEATURE_REVIEWS: Record<FeatureName, { pass: boolean; reason: string }> = {
  packages: { pass: true, reason: "Preview records a 4, 8, or 12 lesson package and does not charge." },
  autopay: { pass: true, reason: "Preview opens Stripe Checkout in setup mode with a test key. Nothing is charged. Missing keys leave card saving off." },
  referrals: { pass: true, reason: "Preview records the referral in Supabase and emails only SAFE_MODE_EMAIL_ALLOWLIST when SMTP is set." },
  recurring: { pass: false, reason: "Portal self-booking is off until lesson availability lives in Supabase. The teacher books lessons from the student page." },
  invoiceActions: { pass: true, reason: "Issue, void and mark-paid change the invoice in Supabase only. Remind writes a log. Nothing is emailed or charged." },
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
