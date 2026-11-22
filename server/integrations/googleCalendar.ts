// Google Calendar: free/busy reads, and intro-call events written to the booking calendar, as a service account
// the calendars are shared with (the booking calendar needs "Make changes to events").
// There is no key: on Vercel, the function's OIDC token is exchanged through Workload Identity Federation
// for a short-lived Google access token that impersonates the service account. Nothing reaches the browser,
// free/busy returns only busy intervals, with no event titles or details.
import { getVercelOidcToken } from "@vercel/oidc";
import { IdentityPoolClient, type IdentityPoolClientOptions } from "google-auth-library";
import { ApiError } from "../http.js";

const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
export const FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
/** Lets the service account create events, only on calendars shared with it as "Make changes to events". */
export const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const EVENTS_URL = (calendarId: string) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

export interface GoogleCalendarConfig {
  projectNumber: string;
  poolId: string;
  providerId: string;
  serviceAccountEmail: string;
  calendarIds: string[];
}

export interface BusyInterval {
  start: number;
  end: number;
}

export interface CalendarEventInput {
  /** Google event id: 5–1024 characters from a–v and 0–9. The same id can't be booked twice. */
  id: string;
  calendarId: string;
  summary: string;
  description: string;
  startMs: number;
  endMs: number;
  timeZone: string;
}

export interface GoogleBusyClient {
  /** Busy intervals across every configured calendar. Throws rather than return a partial answer. */
  busy(fromMs: number, toMs: number): Promise<BusyInterval[]>;
  /**
   * Creates the event. Throws `slot_taken` (409) when a live event already has this id, and
   * `booking_unavailable` (503) on any other failure.
   */
  createEvent(input: CalendarEventInput): Promise<{ id: string; htmlLink: string | null }>;
}

/** Returns a Google access token for the service account. Implementations cache it. */
export type GoogleTokenSource = () => Promise<string>;

export const slotTaken = () => new ApiError(409, "slot_taken", "That time was just taken. Please pick another.");
export const bookingUnavailable = () =>
  new ApiError(503, "booking_unavailable", "Your call couldn't be booked right now. Please try again shortly.");

export const availabilityUnavailable = () =>
  new ApiError(503, "availability_unavailable", "Open times can't be checked right now. Please try again shortly.");

/** Options for exchanging a Vercel OIDC token for a Google access token as the service account. */
export function workloadIdentityOptions(config: GoogleCalendarConfig, oidcToken: () => Promise<string> = () => getVercelOidcToken()): IdentityPoolClientOptions {
  return {
    type: "external_account",
    audience: `//iam.googleapis.com/projects/${config.projectNumber}/locations/global/workloadIdentityPools/${config.poolId}/providers/${config.providerId}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(config.serviceAccountEmail)}:generateAccessToken`,
    scopes: [FREEBUSY_SCOPE, EVENTS_SCOPE],
    subject_token_supplier: { getSubjectToken: () => oidcToken() },
  };
}

export function workloadIdentityTokenSource(config: GoogleCalendarConfig, oidcToken?: () => Promise<string>): GoogleTokenSource {
  // The client caches the access token and refreshes it shortly before it expires.
  const client = new IdentityPoolClient(workloadIdentityOptions(config, oidcToken));
  return async () => {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("google access token missing");
    return token;
  };
}

/** A short reason for the server log. It never includes tokens, response bodies or request details. */
export function failureReason(e: unknown): string {
  if (!(e instanceof Error)) return "unknown";
  if (e.name === "AccessTokenMissingError" || e.name === "RefreshAccessTokenFailedError") return "vercel oidc token unavailable";
  const status = (e as { status?: unknown; response?: { status?: unknown } }).response?.status ?? (e as { status?: unknown }).status;
  if (typeof status === "number") return `google auth ${status}`;
  // Messages this module throws itself are fixed strings; anything else is reduced to its type.
  return e.message.startsWith("google ") ? e.message : e.name || "error";
}

export function createGoogleCalendar(config: GoogleCalendarConfig, tokenSource: GoogleTokenSource = workloadIdentityTokenSource(config), fetchImpl: typeof fetch = fetch): GoogleBusyClient {
  return {
    async busy(fromMs, toMs) {
      try {
        const token = await tokenSource();
        const res = await fetchImpl(FREEBUSY_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
        console.error(`[google] free/busy failed: ${failureReason(e)}`);
        throw availabilityUnavailable();
      }
    },

    async createEvent(input) {
      const body = JSON.stringify({
        id: input.id,
        status: "confirmed",
        summary: input.summary,
        description: input.description,
        start: { dateTime: new Date(input.startMs).toISOString(), timeZone: input.timeZone },
        end: { dateTime: new Date(input.endMs).toISOString(), timeZone: input.timeZone },
        // No attendees: a service account can't invite people. The client's invite goes out by email instead.
        reminders: { useDefault: true },
      });
      try {
        const token = await tokenSource();
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
        const send = (url: string, method: string, payload?: string) => fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(8000) });
        let res = await send(EVENTS_URL(input.calendarId), "POST", body);
        if (res.status === 409) {
          // The id exists. A cancelled event with this id (a call that was deleted) is reused; a live one means taken.
          const existing = await send(`${EVENTS_URL(input.calendarId)}/${input.id}`, "GET");
          const current = existing.ok ? ((await existing.json()) as { status?: string }) : null;
          if (current?.status !== "cancelled") throw slotTaken();
          res = await send(`${EVENTS_URL(input.calendarId)}/${input.id}`, "PUT", body);
        }
        if (!res.ok) throw new Error(`google events ${res.status}`);
        const data = (await res.json()) as { id?: string; htmlLink?: string };
        return { id: data.id ?? input.id, htmlLink: data.htmlLink ?? null };
      } catch (e) {
        if (e instanceof ApiError && e.code === "slot_taken") throw e;
        console.error(`[google] create event failed: ${failureReason(e)}`);
        throw bookingUnavailable();
      }
    },
  };
}
