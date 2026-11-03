import { lessonPackageById, packageLessonsFor } from "../../shared/lesson-packages.js";
import { ApiError } from "../http.js";
import type { GhlClient } from "../integrations/ghl.js";
import { sendReferralEmail, type ReferralMessage, type SmtpAuth } from "../mail/referralMail.js";
import type { PortalStore } from "../store/types.js";

export const PACKAGE_PURCHASE = "package.purchase";
export const AUTOPAY_SAVE = "autopay.save";
export const REFERRAL_INVITE = "referral.invite";
export const REFERRAL_APPLY = "referral.apply";

/** Preview safe mode only. Every other environment refuses before any charge or send. */
export function assertPreviewSafe(enabled: boolean, safeMode: boolean) {
  if (!enabled || !safeMode) {
    throw new ApiError(501, "feature_not_enabled", "This is only available on preview, and it does not charge or send.");
  }
}

export async function purchaseLessonPackage(store: PortalStore, input: { actorAccountId: string; studentId: string; packageId: string; enabled: boolean; safeMode: boolean }) {
  assertPreviewSafe(input.enabled, input.safeMode);
  const item = lessonPackageById(input.packageId);
  if (!item) throw new ApiError(400, "invalid_input", "Choose a lesson package.");
  console.info(`[package] safe mode: recorded ${item.name} (${formatCents(item.amountCents)}) for student ${input.studentId}. Nothing was charged or sent.`);
  await store.audit(input.actorAccountId, PACKAGE_PURCHASE, input.studentId, {
    packageId: item.id,
    name: item.name,
    lessons: item.lessons,
    amountCents: item.amountCents,
    suppressed: true,
  });
  const lessonsRemaining = packageLessonsFor(await store.listAudit(PACKAGE_PURCHASE), input.studentId);
  return { ok: true as const, suppressed: true as const, packageId: item.id, lessonsAdded: item.lessons, lessonsRemaining };
}

export async function saveAutopayPreference(store: PortalStore, input: { actorAccountId: string; studentId: string; enabled: boolean; safeMode: boolean; featureOn: boolean }) {
  assertPreviewSafe(input.featureOn, input.safeMode);
  console.info(`[autopay] safe mode: recorded autopay ${input.enabled ? "on" : "off"} for student ${input.studentId} as a Stripe test-mode stand-in. No Stripe call was made and nothing was charged.`);
  await store.audit(input.actorAccountId, AUTOPAY_SAVE, input.studentId, { enabled: input.enabled, suppressed: true, processor: "stripe-test-log" });
  return { ok: true as const, suppressed: true as const, enabled: input.enabled, processor: "stripe-test-log" as const };
}

export function autopayEnabledFor(rows: { target: string; meta: Record<string, unknown> }[], studentId: string) {
  const mine = rows.filter((row) => row.target === studentId);
  const latest = mine[mine.length - 1];
  return latest?.meta.enabled === true;
}

export async function sendReferral(store: PortalStore, ghl: GhlClient, input: {
  actorAccountId: string;
  email: string;
  studentId: string | null;
  enabled: boolean;
  safeMode: boolean;
  allowlist: string[];
  appUrl: string;
  smtp: SmtpAuth | null;
  deliver?: (message: ReferralMessage) => Promise<void>;
}) {
  assertPreviewSafe(input.enabled, input.safeMode);
  if (ghl.config.safeMode !== true) throw new ApiError(501, "feature_not_enabled", "Referrals are only tracked while safe mode is on.");
  const email = input.email.trim().toLowerCase();
  const allowlisted = input.allowlist.map((item) => item.toLowerCase()).includes(email);
  // createContact adds dnd and the portal-test tag when the client is in safe mode.
  const { contact } = await ghl.createContact({ name: `Referral ${email}`, email });
  const code = referralCodeFor(input.studentId ?? contact.id);
  const mailed = await sendReferralEmail({
    to: email,
    code,
    appUrl: input.appUrl,
    safeMode: input.safeMode,
    allowlist: input.allowlist,
    smtp: input.smtp,
    deliver: input.deliver,
  });
  await store.audit(input.actorAccountId, REFERRAL_INVITE, input.studentId ?? contact.id, {
    email,
    contactId: contact.id,
    allowlisted,
    suppressed: mailed.suppressed,
    emailed: mailed.emailed,
  });
  return { ok: true as const, suppressed: mailed.suppressed, emailed: mailed.emailed, allowlisted, contactId: contact.id, mailer: mailed.mailer };
}

export async function applyReferralCode(store: PortalStore, input: { actorAccountId: string; studentId: string; code: string; enabled: boolean; safeMode: boolean }) {
  assertPreviewSafe(input.enabled, input.safeMode);
  const code = input.code.trim().toUpperCase();
  if (!/^SFTM-[A-Z0-9]{8}$/.test(code)) throw new ApiError(400, "invalid_input", "That referral code isn't valid.");
  console.info(`[referral] safe mode: recorded code ${code} for student ${input.studentId}. No discount was charged or applied in GoHighLevel.`);
  await store.audit(input.actorAccountId, REFERRAL_APPLY, input.studentId, { code, suppressed: true });
  return { ok: true as const, suppressed: true as const, code };
}

export function referralCodeFor(studentId: string) {
  return `SFTM-${studentId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function formatCents(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}
