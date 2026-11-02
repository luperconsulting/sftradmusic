// GoHighLevel API v2 client. Every path and field comes from GoHighLevel's published OpenAPI files
// (github.com/GoHighLevel/highlevel-api-docs: apps/calendars.json, contacts.json, invoices.json).
import { ApiError } from "../http.js";
import type { InvoiceDTO, InvoiceStatus, LessonDTO } from "../../shared/portal-types.js";

const BASE = "https://services.leadconnectorhq.com";
const CALENDAR_VERSION = "2021-04-15";
const CRM_VERSION = "2021-07-28";

export interface GhlConfig {
  token: string;
  locationId: string;
  lessonCalendarId: string;
  timezone: string;
  paymentUrlTemplate: string | null;
  paymentHosts: string[];
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
}

export function createGhlClient(config: GhlConfig, fetchImpl: typeof fetch = fetch): GhlClient {
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
      if (res.status === 404) throw new ApiError(404, "not_found", "Not found.");
      if (res.status === 400 || res.status === 422) throw new ApiError(409, "ghl_rejected", "That request couldn't be completed. Please choose another time or try again.");
      throw new ApiError(503, "ghl_unavailable", "We couldn't reach the scheduling and billing system. Please try again shortly.");
    }
    return res.json() as Promise<any>;
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
          toNotify: true,
        }),
      }),
    updateAppointment: (eventId, input) =>
      call(`/calendars/events/appointments/${encodeURIComponent(eventId)}`, CALENDAR_VERSION, {
        method: "PUT",
        body: JSON.stringify({ ...input, ignoreFreeSlotValidation: false, toNotify: true }),
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
    getInvoice: (invoiceId) => call(`/invoices/${encodeURIComponent(invoiceId)}?${invoiceQuery({})}`, CRM_VERSION),
  };
}

export function toInvoiceDTO(raw: any): InvoiceDTO {
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
    lines: (raw.invoiceItems ?? []).map((i: any) => ({ label: i.name ?? "Item", amount: Number(i.amount ?? 0) * Number(i.qty ?? 1) })),
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
