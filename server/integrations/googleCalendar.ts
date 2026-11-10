// Google Calendar free/busy, read with a service account the calendar is shared with ("See only free/busy").
// The key never leaves the server, and only busy intervals come back: no event titles or details.
import { createSign } from "node:crypto";
import { ApiError } from "../http.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";

export interface GoogleCalendarConfig {
  clientEmail: string;
  privateKey: string;
  calendarIds: string[];
}

export interface BusyInterval {
  start: number;
  end: number;
}

export interface GoogleBusyClient {
  /** Busy intervals across every configured calendar. Throws rather than return a partial answer. */
  busy(fromMs: number, toMs: number): Promise<BusyInterval[]>;
}

export const availabilityUnavailable = () =>
  new ApiError(503, "availability_unavailable", "Open times can't be checked right now. Please try again shortly.");

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export function createGoogleCalendar(config: GoogleCalendarConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): GoogleBusyClient {
  let cached: { token: string; expiresAt: number } | null = null;

  async function accessToken() {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: config.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(config.privateKey).toString("base64url");
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`google token ${res.status}`);
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("google token missing");
    cached = { token: data.access_token, expiresAt: now() + (data.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return {
    async busy(fromMs, toMs) {
      try {
        const res = await fetchImpl(FREEBUSY_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), items: config.calendarIds.map((id) => ({ id })) }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`google freeBusy ${res.status}`);
        const data = (await res.json()) as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> };
        const out: BusyInterval[] = [];
        for (const id of config.calendarIds) {
          const cal = data.calendars?.[id];
          // A calendar Google can't read (not shared, wrong ID) comes back with errors and no busy list.
          // Treating that as "free" would offer times that are taken, so it fails the whole request.
          if (!cal || (cal.errors?.length ?? 0) > 0 || !Array.isArray(cal.busy)) throw new Error("google calendar not readable");
          for (const b of cal.busy) {
            const start = Date.parse(b.start), end = Date.parse(b.end);
            if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("google busy unreadable");
            out.push({ start, end });
          }
        }
        return out;
      } catch (e) {
        // The reason goes to the server log only; the visitor gets the safe message.
        console.error(`[google] free/busy failed: ${e instanceof Error ? e.message : "unknown"}`);
        throw availabilityUnavailable();
      }
    },
  };
}
