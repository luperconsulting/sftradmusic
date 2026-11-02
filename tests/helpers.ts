import { memoryRateLimiter } from "../server/rateLimit";
import type { Deps } from "../server/app";
import type { GhlClient } from "../server/integrations/ghl";
import type { AuthAdmin, PortalStore, StudentRecord } from "../server/store/types";

export const STUDENT_A = "11111111-1111-4111-8111-111111111111";
export const STUDENT_B = "22222222-2222-4222-8222-222222222222";
export const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString().replace(/\.\d+Z$/, ".000Z");

export const studentRecord = (id: string, contact: string, payer: string): StudentRecord => ({
  id, firstName: "Test", fullName: "Test Student", styleLine: "", format: "In person", isMinor: true,
  guardianName: "G", guardianEmail: "g@example.com", email: null, studentSince: null, ghlContactId: contact, billingContactId: payer,
});

export const rawInvoice = (over: Record<string, unknown> = {}) => ({
  _id: "inv1", status: "sent", invoiceNumber: 1, total: 100, amountDue: 100, amountPaid: 0, currency: "USD",
  contactDetails: { id: "payerA", name: "G" }, invoiceItems: [], issueDate: "2026-01-01", dueDate: "2026-01-01", ...over,
});

export function fakeGhl(over: Partial<GhlClient> = {}): GhlClient {
  return {
    config: { token: "t", locationId: "loc", lessonCalendarId: "cal", timezone: "UTC", invoiceSenderUserId: "sender1" },
    getFreeSlots: async () => ({ d: [FUTURE] }),
    createAppointment: async (i) => ({ id: "new", calendarId: "cal", contactId: i.contactId, startTime: i.startTime, endTime: i.endTime }),
    updateAppointment: async (id, i) => ({ id, calendarId: "cal", contactId: "contactA", startTime: i.startTime, endTime: i.endTime }),
    getAppointment: async () => ({ id: "ev", calendarId: "cal", contactId: "contactA", startTime: FUTURE, endTime: FUTURE }),
    getContactAppointments: async () => [],
    listCalendarEvents: async () => [],
    listInvoices: async () => ({ invoices: [], total: 0 }),
    getInvoice: async () => rawInvoice(),
    sendInvoice: async () => ({}),
    findContactByEmail: async () => null,
    createContact: async ({ name, email }) => ({ contact: { id: `new-${name}`, name, email }, created: true }),
    searchContacts: async () => [],
    getContact: async (id) => ({ id, name: "Contact", email: null }),
    deleteContact: async () => undefined,
    ...over,
  };
}

type Who = { role: "teacher" | "guardian" | "student"; aal?: string; mfa?: boolean; status?: "active" | "suspended"; links?: { studentId: string; canBook: boolean; canPay: boolean }[] };

export function buildDeps(users: Record<string, Who>, ghl: GhlClient | null = fakeGhl(), store: Partial<PortalStore> = {}): Deps {
  const students: Record<string, StudentRecord> = {
    [STUDENT_A]: studentRecord(STUDENT_A, "contactA", "payerA"),
    [STUDENT_B]: studentRecord(STUDENT_B, "contactB", "payerB"),
  };
  const auth: Partial<AuthAdmin> = {
    verifyToken: async (token) => (users[token] ? { userId: token, email: `${token}@example.com`, aal: users[token].aal ?? "aal2", mfaEnrolled: users[token].mfa ?? true } : null),
    sendPasswordReset: async () => undefined,
    sendPortalInvite: async () => "invited-user",
    setBanned: async () => undefined,
  };
  const fullStore: Partial<PortalStore> = {
    getAccountByUser: async (id) => (users[id] ? { id, userId: id, role: users[id].role, status: users[id].status ?? "active", email: "", displayName: "T U", ghlContactId: null } : null),
    getLinks: async (id) => users[id]?.links ?? [],
    getStudent: async (id) => students[id] ?? null,
    getStudents: async (ids) => ids.map((i) => students[i]).filter(Boolean),
    listStudents: async () => Object.values(students),
    listNotes: async (_id, opts) => (opts.publishedOnly ? [] : [{ id: "draft" } as any]),
    listAssignedVideos: async () => [],
    listAssignments: async () => [],
    audit: async () => undefined,
    lastInvoiceLinkSentAt: async () => null,
    checkStudentSchema: async () => undefined,
    attachInvitationAuthUser: async () => undefined,
    revokeInvitation: async () => undefined,
    createInvitation: async (i: any) => ({ ...i, id: "inv", status: "pending" }),
    ...store,
  };
  return {
    config: { appUrl: "https://app.example.com", supabase: null, ghl: null, ghlWebhookPublicKey: null, safeMode: false, safeModeEmailAllowlist: ["luperdev@gmail.com"], videoBucket: "b", features: { packages: false, autopay: false, referrals: false, recurring: false, invoiceActions: false } },
    store: fullStore as PortalStore,
    auth: auth as AuthAdmin,
    ghl,
    limiter: memoryRateLimiter(),
  };
}
