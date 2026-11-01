import { createVerify } from "node:crypto";

/** RSA-SHA256 check of a raw webhook body against the configured public key. Any failure is a rejection. */
export function verifyWebhookSignature(rawBody: Buffer, signatureB64: string | undefined, publicKeyPem: string | null) {
  if (!publicKeyPem || !signatureB64) return false;
  try {
    return createVerify("RSA-SHA256").update(rawBody).end().verify(publicKeyPem, signatureB64, "base64");
  } catch {
    return false;
  }
}
