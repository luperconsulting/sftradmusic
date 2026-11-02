import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ApiError } from "../http.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
/** Email OTP codes. Supabase must use the same one-hour expiry. */
export const INVITE_CODE_TTL_MS = 60 * 60 * 1000;

export const hashCredential = (value: string) =>
  createHash("sha256").update(normalizeCredential(value)).digest("hex");

// Codes are typed by hand, so case and stray spaces shouldn't matter. Link tokens are unaffected in practice.
export const normalizeCredential = (value: string) =>
  /^sftm-/i.test(value.trim()) ? value.trim().toUpperCase() : value.trim();

/** The design's SFTM-XXXX has only about a million values, so codes are SFTM-XXXX-XXXX (about a trillion). */
export function newEnrollmentCode() {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `SFTM-${pick()}-${pick()}`;
}

export const newInviteToken = () => randomBytes(32).toString("base64url");

/** Name stored for an invite. The teacher may leave it blank; the email still identifies the person. */
export function inviteeFullName(name: string, email: string) {
  const trimmed = name.trim();
  if (trimmed) return trimmed;
  const local = email.split("@")[0]?.replace(/[._+-]+/g, " ").trim();
  return local || email;
}

/** The page where the invitee types the email and the one-time code. No secret belongs in this URL. */
export function portalInvitePage(appUrl: string) {
  return `${appUrl.replace(/\/$/, "")}/invite`;
}

/**
 * Safe mode limits who may be emailed a portal invitation. It does not apply to enrollment codes,
 * and it never applies to GoHighLevel. When safe mode is off, every address may be emailed.
 */
export function assertPortalInviteEmail(safeMode: boolean, email: string, allowlist: string[]) {
  if (!safeMode) return;
  if (allowlist.includes(email.trim().toLowerCase())) return;
  throw new ApiError(403, "invite_not_allowed", "Safe mode only emails portal invitations to addresses on SAFE_MODE_EMAIL_ALLOWLIST.");
}

export function hashesMatch(a: string, b: string) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
