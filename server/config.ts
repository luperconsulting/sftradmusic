// Reads server configuration. Anything missing leaves that integration "not configured", and the routes
// depending on it fail with 503. Nothing falls back to simulated data.
import { featuresForEnv } from "./features.js";
import { supabaseKeyKind } from "../shared/supabase-keys.js";

export interface ServerConfig {
  appUrl: string;
  supabase: { url: string; serviceRoleKey: string } | null;
  ghl: {
    token: string;
    locationId: string;
    lessonCalendarId: string;
    timezone: string;
    invoiceSenderUserId: string | null;
    /** When true, contact creates are marked do-not-disturb and no invoice or booking notification is sent. */
    safeMode: boolean;
  } | null;
  ghlWebhookPublicKey: string | null;
  /** Same switch as GoHighLevel safe mode. It does not suppress Supabase auth mail. */
  safeMode: boolean;
  /** Used only while safe mode is on. Portal invitation email is limited to these addresses. */
  safeModeEmailAllowlist: string[];
  videoBucket: string;
  features: {
    packages: boolean;
    autopay: boolean;
    referrals: boolean;
    recurring: boolean;
    invoiceActions: boolean;
  };
}

/**
 * Safe mode is on unless this process is a production deployment, or GHL_SAFE_MODE says otherwise.
 * Vercel Preview runs with NODE_ENV=production, so the Vercel environment is what decides, not NODE_ENV alone.
 */
export function ghlSafeMode(env: Record<string, string | undefined>): boolean {
  const raw = env.GHL_SAFE_MODE?.trim().toLowerCase();
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
  const ghlToken = env.GHL_PRIVATE_INTEGRATION_TOKEN;
  const locationId = env.GHL_LOCATION_ID;
  const calendarId = env.GHL_LESSON_CALENDAR_ID;
  // A public key here would make every store call fail on RLS, so treat it as not configured.
  const usableServerKey = !!serviceRoleKey && supabaseKeyKind(serviceRoleKey) !== "public";
  const safeMode = ghlSafeMode(env);
  return {
    appUrl: env.APP_URL || "http://localhost:3000",
    supabase: supabaseUrl && usableServerKey ? { url: supabaseUrl, serviceRoleKey: serviceRoleKey! } : null,
    ghl:
      ghlToken && locationId && calendarId
        ? {
            token: ghlToken,
            locationId,
            lessonCalendarId: calendarId,
            timezone: env.GHL_TIMEZONE || "America/Los_Angeles",
            invoiceSenderUserId: env.GHL_INVOICE_SENDER_USER_ID || null,
            safeMode,
          }
        : null,
    ghlWebhookPublicKey: env.GHL_WEBHOOK_PUBLIC_KEY || null,
    safeMode,
    safeModeEmailAllowlist: safeInviteAllowlist(env),
    videoBucket: env.SUPABASE_VIDEO_BUCKET || "lesson-videos",
    // A passing flag can be true on Preview only. Production is always off. See server/features.ts.
    features: featuresForEnv(env),
  };
}
