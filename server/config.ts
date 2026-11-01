// Reads server configuration. Anything missing leaves that integration "not configured", and the routes
// depending on it fail with 503. Nothing falls back to simulated data.
import { supabaseKeyKind } from "../shared/supabase-keys.js";

export interface ServerConfig {
  appUrl: string;
  supabase: { url: string; serviceRoleKey: string } | null;
  ghl: {
    token: string;
    locationId: string;
    lessonCalendarId: string;
    timezone: string;
    paymentUrlTemplate: string | null;
    paymentHosts: string[];
  } | null;
  ghlWebhookPublicKey: string | null;
  videoBucket: string;
  features: {
    packages: boolean;
    autopay: boolean;
    referrals: boolean;
    recurring: boolean;
    invoiceActions: boolean;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const ghlToken = env.GHL_PRIVATE_INTEGRATION_TOKEN;
  const locationId = env.GHL_LOCATION_ID;
  const calendarId = env.GHL_LESSON_CALENDAR_ID;
  // A public key here would make every store call fail on RLS, so treat it as not configured.
  const usableServerKey = !!serviceRoleKey && supabaseKeyKind(serviceRoleKey) !== "public";
  const paymentUrlTemplate = env.GHL_INVOICE_PAYMENT_URL_TEMPLATE || null;
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
            paymentUrlTemplate,
            paymentHosts: (env.GHL_PAYMENT_LINK_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
          }
        : null,
    ghlWebhookPublicKey: env.GHL_WEBHOOK_PUBLIC_KEY || null,
    videoBucket: env.SUPABASE_VIDEO_BUCKET || "lesson-videos",
    // Financial features stay off until reviewed, and switching one on only unlocks a route if its backend exists.
    features: { packages: false, autopay: false, referrals: false, recurring: false, invoiceActions: false },
  };
}
