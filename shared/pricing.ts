// The only prices the studio offers. Lessons are 60 minutes. Shared by the portal and the API.
export const LESSON_MINUTES = 60;
export const SESSION_PRICE_CENTS = 10000;
export const PACKAGE_LESSONS = 4;
/** A 4-lesson package costs $380 by Zelle (or card, when card payments are on) and $375 in cash up front. */
export const PACKAGE_PRICE_CENTS = { zelle: 38000, cash: 37500, card: 38000 } as const;
export type PackageMethod = keyof typeof PACKAGE_PRICE_CENTS;
export const REFERRAL_DISCOUNT_CENTS = 1500;
export const REFERRER_CREDIT_CENTS = 2500;
export const SERIES_WEEKS_MAX = 12;
export const SERIES_WEEKS_DEFAULT = 8;

export function formatMoney(cents: number) {
  const amount = cents / 100;
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export const OUTSTANDING_MESSAGE_HOLD = "You have a lesson waiting for payment. Please pay that invoice before booking another lesson.";
