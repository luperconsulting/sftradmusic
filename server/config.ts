// Reads server configuration. GoHighLevel is not read here: the portal runs on Supabase alone.
// Anything missing leaves that integration "not configured", and the routes
// depending on it fail with 503. Nothing falls back to simulated data.
import { stripeKeysFromEnv, type StripeKeys } from "./integrations/stripeCheckout.js";
import type { GoogleCalendarConfig } from "./integrations/googleCalendar.js";
import { smtpFromEnv, type SmtpAuth } from "./mail/mailer.js";
import { supabaseKeyKind } from "../shared/supabase-keys.js";

export interface ServerConfig {
  appUrl: string;
  supabase: { url: string; serviceRoleKey: string } | null;
  /** Preview safe mode: portal email goes only to safeModeEmailAllowlist. It does not suppress Supabase auth mail. */
  safeMode: boolean;
  /** Used only while safe mode is on. Portal email is limited to these addresses. */
  safeModeEmailAllowlist: string[];
  videoBucket: string;
  /** Present only when both SMTP_USER and SMTP_PASS are set. The values are never sent to the browser. */
  smtp: SmtpAuth | null;
  /** Present only for sk_test_ and pk_test_ keys. Live keys are ignored, so nothing real can be charged. */
  stripe: StripeKeys | null;
  /** Verifies /api/webhooks/stripe. Without it the webhook refuses every event. */
  stripeWebhookSecret: string | null;
  /** Google Calendar free/busy via Workload Identity Federation. Null until every setting is present. */
  google: GoogleCalendarConfig | null;
  /** Bearer token for GET /api/ops/summary. Null turns the endpoint off. */
  opsApiToken: string | null;
  /** Public booking widget slot length in minutes (intro calls). */
  bookingSlotMinutes: number;
  features: {
    /** CARD_PAYMENTS_ENABLED=true and Stripe test keys present. Off by default. */
    cardPayments: boolean;
  };
}

/**
 * Safe mode is on unless this process is a production deployment, or SAFE_MODE says otherwise.
 * Vercel Preview runs with NODE_ENV=production, so the Vercel environment is what decides, not NODE_ENV alone.
 */
export function previewSafeMode(env: Record<string, string | undefined>): boolean {
  const raw = env.SAFE_MODE?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  if (env.VERCEL_ENV) return env.VERCEL_ENV !== "production";
  return env.NODE_ENV !== "production";
}

/** The one address a Preview teacher can invite when SAFE_MODE_EMAIL_ALLOWLIST is unset. */
export const DEFAULT_SAFE_INVITE_ALLOWLIST = ["luperdev@gmail.com"];

/** Comma, semicolon, or whitespace separated. An empty value keeps the default test address. */
export function safeInviteAllowlist(env: Record<string, string | undefined>): string[] {
  const raw = env.SAFE_MODE_EMAIL_ALLOWLIST;
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_SAFE_INVITE_ALLOWLIST];
  return [...new Set(raw.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  // A public key here would make every store call fail on RLS, so treat it as not configured.
  const usableServerKey = !!serviceRoleKey && supabaseKeyKind(serviceRoleKey) !== "public";
  const safeMode = previewSafeMode(env);
  const stripe = stripeKeysFromEnv(env);
  return {
    appUrl: env.APP_URL || "http://localhost:3000",
    supabase: supabaseUrl && usableServerKey ? { url: supabaseUrl, serviceRoleKey: serviceRoleKey! } : null,
    safeMode,
    safeModeEmailAllowlist: safeInviteAllowlist(env),
    videoBucket: env.SUPABASE_VIDEO_BUCKET || "lesson-videos",
    smtp: smtpFromEnv(env),
    stripe,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim().startsWith("whsec_") ? env.STRIPE_WEBHOOK_SECRET.trim() : null,
    google: googleFromEnv(env),
    opsApiToken: (env.OPS_API_TOKEN?.trim().length ?? 0) >= 24 ? env.OPS_API_TOKEN!.trim() : null,
    bookingSlotMinutes: Number(env.BOOKING_SLOT_MINUTES) > 0 ? Number(env.BOOKING_SLOT_MINUTES) : 15,
    features: { cardPayments: env.CARD_PAYMENTS_ENABLED?.trim().toLowerCase() === "true" && !!stripe },
  };
}

export function googleFromEnv(env: Record<string, string | undefined>): GoogleCalendarConfig | null {
  const projectNumber = env.GCP_PROJECT_NUMBER?.trim();
  const poolId = env.GCP_WORKLOAD_IDENTITY_POOL_ID?.trim();
  const providerId = env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID?.trim();
  const serviceAccountEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const calendarIds = (env.GOOGLE_CALENDAR_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return projectNumber && poolId && providerId && serviceAccountEmail && calendarIds.length
    ? { projectNumber, poolId, providerId, serviceAccountEmail, calendarIds }
    : null;
}
