import type { Features } from "../shared/portal-types.js";

export type FeatureName = keyof Features;

/** Each flag stays off until its backend can be used without a real charge, text, or fake payment. */
export const FEATURE_REVIEWS: Record<FeatureName, { pass: boolean; reason: string }> = {
  packages: { pass: false, reason: "POST /api/packages/purchase returns 501. There is no package charge that stays a test record." },
  autopay: { pass: false, reason: "POST /api/autopay returns 501. Turning the switch on would describe a real per-lesson charge." },
  referrals: { pass: false, reason: "POST /api/referrals/invite and /api/referrals/apply return 501." },
  recurring: { pass: false, reason: "Weekly repeat only flashes a message. Booking still creates one appointment." },
  invoiceActions: { pass: false, reason: "Send, remind, void, and mark-paid return 501 so the portal cannot mark an invoice paid." },
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
