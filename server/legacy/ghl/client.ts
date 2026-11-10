// LEGACY. Kept for migrating old GoHighLevel records. The portal never imports this at runtime; see README.md.
// GoHighLevel API v2 client. Every path and field comes from GoHighLevel's published OpenAPI files
// (github.com/GoHighLevel/highlevel-api-docs: apps/calendars.json, contacts.json, invoices.json).
import { ApiError } from "../../http.js";
import type { InvoiceDTO, InvoiceStatus, LessonDTO } from "../../../shared/portal-types.js";

const BASE = "https://services.leadconnectorhq.com";
const CALENDAR_VERSION = "2021-04-15";
const CRM_VERSION = "2021-07-28";

export interface GhlConfig {
  token: string;
  locationId: string;
  lessonCalendarId: string;
  timezone: string;
  /** The GoHighLevel user invoices are sent as. Without one, the portal can't send payment links. */
  invoiceSenderUserId: string | null;
  /**
   * Non-production default. New contacts are do-not-disturb and tagged, bookings do not notify,
   * and invoice send is logged instead of delivered. Unset means off, so a caller that forgets the flag
   * does not silently change live behavior; loadConfig sets it from GHL_SAFE_MODE.
   */
  safeMode?: boolean;
}

export interface GhlAppointment {
  id: string;
  calendarId: string;
  contactId: string;
  startTime: string;
  endTime: string;
  title?: string;
  address?: string;
  appointmentStatus?: string;
}

export interface GhlClient {
  config: GhlConfig;
  getFreeSlots(fromMs: number, toMs: number): Promise<Record<string, string[]>>;
  createAppointment(input: { contactId: string; startTime: string; endTime: string; title: string; address: string }): Promise<GhlAppointment>;
  updateAppointment(eventId: string, input: { startTime: string; endTime: string; address?: string }): Promise<GhlAppointment>;
  getAppointment(eventId: string): Promise<GhlAppointment>;
  getContactAppointments(contactId: string): Promise<GhlAppointment[]>;
  listCalendarEvents(fromMs: number, toMs: number): Promise<GhlAppointment[]>;
  listInvoices(query: { contactId?: string; limit?: number; offset?: number }): Promise<{ invoices: any[]; total: number }>;
  getInvoice(invoiceId: string): Promise<any>;
  searchContacts(query: string): Promise<GhlContact[]>;
  getContact(contactId: string): Promise<GhlContact>;
  /** Null when this location has no contact with that email. */
  findContactByEmail(email: string): Promise<GhlContact | null>;
  /** Creates a contact. `created` is false when GoHighLevel matched an existing one instead. */
  createContact(input: { name: string; email: string | null }): Promise<{ contact: GhlContact; created: boolean }>;
  /** Deletes a contact this portal just created. Never call this for a contact the request only reused. */
  deleteContact(contactId: string): Promise<void>;
  /**
   * Sends an existing invoice by email to the contact it's addressed to.
   * SMS is never requested. In safe mode this only logs and returns `{ suppressed: true }`.
   */
  sendInvoice(invoiceId: string, input: { userId: string; liveMode: boolean }): Promise<unknown>;
}

export interface GhlContact { id: string; name: string; email: string | null }

const toContact = (c: any): GhlContact => ({
  id: c.id,
  name: c.contactName || c.name || [c.firstName ?? c.firstNameLowerCase, c.lastName ?? c.lastNameLowerCase].filter(Boolean).join(" ") || c.email || "Unnamed contact",
  email: c.email ?? null,
});

const PORTAL_TEST_TAG = "portal-test";

export function createGhlClient(config: GhlConfig, fetchImpl: typeof fetch = fetch): GhlClient {
  const safeMode = config.safeMode === true;
  async function call(path: string, version: string, init: RequestInit = {}) {
    let res: Response;
    try {
      res = await fetchImpl(BASE + path, {
        ...init,
        headers: {
          Authorization: `Bearer ${config.token}`,
          Version: version,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ApiError(503, "ghl_unavailable", "We couldn't reach the scheduling and billing system. Please try again shortly.");
    }
    if (!res.ok) {
      console.error(`[ghl] ${init.method || "GET"} ${path.split("?")[0]} -> ${res.status}`);
      if (path === "/contacts/") {
        if (res.status === 401 || res.status === 403) throw new ApiError(503, "ghl_contact_permission", "GoHighLevel didn't allow creating a contact. The connection needs the contacts.write permission.");
        // With duplicates turned off, GoHighLevel refuses and names the contact it matched.
        const duplicateId = res.status === 400 ? (await res.json().catch(() => null))?.meta?.contactId : null;
        if (duplicateId) return { duplicateId };
      }
      if (res.status === 404) throw new ApiError(404, "not_found", "Not found.");
      if (res.status === 400 || res.status === 422) throw new ApiError(409, "ghl_rejected", "That request couldn't be completed. Please choose another time or try again.");
      throw new ApiError(503, "ghl_unavailable", "We couldn't reach the scheduling and billing system. Please try again shortly.");
    }
    if (res.status === 204) return {};
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text) as any;
  }
  const invoiceQuery = (extra: Record<string, string>) =>
    new URLSearchParams({ altId: config.locationId, altType: "location", ...extra }).toString();

  return {
    config,
    async getFreeSlots(fromMs, toMs) {
      const q = new URLSearchParams({ startDate: String(fromMs), endDate: String(toMs), timezone: config.timezone });
      const data = await call(`/calendars/${config.lessonCalendarId}/free-slots?${q}`, CALENDAR_VERSION);
      const days: Record<string, string[]> = {};
      for (const [day, value] of Object.entries<any>(data)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(value?.slots)) days[day] = value.slots;
      }
      return days;
    },
    createAppointment: (input) =>
      call("/calendars/events/appointments", CALENDAR_VERSION, {
        method: "POST",
        body: JSON.stringify({
          calendarId: config.lessonCalendarId,
          locationId: config.locationId,
          contactId: input.contactId,
          startTime: input.startTime,
          endTime: input.endTime,
          title: input.title,
          address: input.address,
          appointmentStatus: "confirmed",
          ignoreFreeSlotValidation: false,
          toNotify: !safeMode,
        }),
      }),
    updateAppointment: (eventId, input) =>
      call(`/calendars/events/appointments/${encodeURIComponent(eventId)}`, CALENDAR_VERSION, {
        method: "PUT",
        body: JSON.stringify({ ...input, ignoreFreeSlotValidation: false, toNotify: !safeMode }),
      }),
    async getAppointment(eventId) {
      const data = await call(`/calendars/events/appointments/${encodeURIComponent(eventId)}`, CALENDAR_VERSION);
      return data.event ?? data;
    },
    async getContactAppointments(contactId) {
      const data = await call(`/contacts/${encodeURIComponent(contactId)}/appointments`, CRM_VERSION);
      return data.events ?? [];
    },
    async listCalendarEvents(fromMs, toMs) {
      const q = new URLSearchParams({ locationId: config.locationId, calendarId: config.lessonCalendarId, startTime: String(fromMs), endTime: String(toMs) });
      const data = await call(`/calendars/events?${q}`, CALENDAR_VERSION);
      return data.events ?? [];
    },
    async listInvoices({ contactId, limit = 100, offset = 0 }) {
      const q = invoiceQuery({ limit: String(limit), offset: String(offset), ...(contactId ? { contactId } : {}) });
      const data = await call(`/invoices/?${q}`, CRM_VERSION);
      return { invoices: data.invoices ?? [], total: data.total ?? 0 };
    },
    async searchContacts(query) {
      const data = await call("/contacts/search", CRM_VERSION, {
        method: "POST",
        body: JSON.stringify({ locationId: config.locationId, page: 1, pageLimit: 25, ...(query ? { query } : {}) }),
      });
      return (data.contacts ?? []).map(toContact);
    },
    async getContact(contactId) {
      const data = await call(`/contacts/${encodeURIComponent(contactId)}`, CRM_VERSION);
      return toContact(data.contact ?? data);
    },
    async findContactByEmail(email) {
      const q = new URLSearchParams({ locationId: config.locationId, email });
      const found = (await call(`/contacts/search/duplicate?${q}`, CRM_VERSION)).contact;
      return found?.id ? toContact(found) : null;
    },
    async createContact({ name, email }) {
      const [firstName, ...rest] = name.trim().split(/\s+/);
      const data = await call("/contacts/", CRM_VERSION, {
        method: "POST",
        body: JSON.stringify({
          locationId: config.locationId,
          firstName,
          lastName: rest.join(" ") || undefined,
          name,
          ...(email ? { email } : {}),
          source: "SF Trad Music portal",
          // Safe mode keeps a Preview contact from entering live workflows or receiving messages.
          ...(safeMode ? { dnd: true, tags: [PORTAL_TEST_TAG] } : {}),
        }),
      });
      if (data.duplicateId) return { contact: { id: data.duplicateId, name, email }, created: false };
      if (!data.contact?.id) throw new ApiError(503, "ghl_unavailable", "We couldn't reach the scheduling and billing system. Please try again shortly.");
      return { contact: toContact(data.contact), created: true };
    },
    async deleteContact(contactId) {
      await call(`/contacts/${encodeURIComponent(contactId)}`, CRM_VERSION, { method: "DELETE" });
    },
    getInvoice: (invoiceId) => call(`/invoices/${encodeURIComponent(invoiceId)}?${invoiceQuery({})}`, CRM_VERSION),
    async sendInvoice(invoiceId, input) {
      // action is fixed to email. sms and sms_and_email are never sent, in safe mode or otherwise.
      const action = "email";
      if (safeMode) {
        console.info(`[ghl] safe mode: would email invoice ${invoiceId} (liveMode=${String(input.liveMode)}). No email or SMS was sent.`);
        return { suppressed: true };
      }
      return call(`/invoices/${encodeURIComponent(invoiceId)}/send`, CRM_VERSION, {
        method: "POST",
        body: JSON.stringify({ altId: config.locationId, altType: "location", userId: input.userId, action, liveMode: input.liveMode }),
      });
    },
  };
}

/** A real https payment link from GoHighLevel. Safe mode returns null so preview cannot charge. */
export function invoicePayUrl(raw: any, safeMode: boolean): string | null {
  if (safeMode) return null;
  for (const value of [raw?.paymentLink, raw?.invoiceUrl, raw?.publicInvoiceUrl, raw?.url]) {
    if (typeof value === "string" && /^https:\/\//i.test(value)) return value;
  }
  return null;
}

export function toInvoiceDTO(raw: any, safeMode = false): InvoiceDTO {
  return {
    id: raw._id,
    number: String(raw.invoiceNumber ?? ""),
    title: raw.title ?? raw.name ?? "Invoice",
    status: raw.status as InvoiceStatus,
    liveMode: raw.liveMode,
    issueDate: raw.issueDate ?? "",
    dueDate: raw.dueDate ?? "",
    total: Number(raw.total ?? 0),
    amountDue: Number(raw.amountDue ?? 0),
    amountPaid: Number(raw.amountPaid ?? 0),
    currency: raw.currency ?? "USD",
    contactId: raw.contactDetails?.id ?? "",
    contactName: raw.contactDetails?.name ?? "",
    studentId: "",
    lines: (raw.invoiceItems ?? []).map((i: any) => ({ label: i.name ?? "Item", amount: Number(i.amount ?? 0) * Number(i.qty ?? 1) })),
    payUrl: invoicePayUrl(raw, safeMode),
  };
}

export function toLessonDTO(a: GhlAppointment, studentId: string): LessonDTO {
  const isZoom = /zoom/i.test(a.address ?? "") || /zoom/i.test(a.title ?? "");
  return {
    id: a.id,
    studentId,
    startTime: a.startTime,
    endTime: a.endTime,
    status: a.appointmentStatus ?? "confirmed",
    isZoom,
    locationLabel: isZoom ? "Zoom" : "Music City SF",
    locationSub: isZoom ? "Link opens 5 minutes before" : "Room 4, 1353 Bush St",
  };
}
