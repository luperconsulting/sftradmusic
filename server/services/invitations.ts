import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

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

export function hashesMatch(a: string, b: string) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
