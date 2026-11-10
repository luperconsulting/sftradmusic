import { memoryRateLimiter } from "../server/rateLimit";
import type { Deps } from "../server/app";
import type { AuthAdmin, PortalStore, StudentRecord } from "../server/store/types";
import { ARZO_EMAIL, GUARDIAN_EMAIL, memoryCoreStore, type CoreTables } from "./memoryStore";

export const STUDENT_A = "11111111-1111-4111-8111-111111111111";
export const STUDENT_B = "22222222-2222-4222-8222-222222222222";
export const PAYER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const PAYER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString().replace(/\.\d+Z$/, ".000Z");

/** Arzo Luper, the test student. STUDENT_A is the adult; STUDENT_B is a child whose guardian uses a luperdev alias. Unassigned to a teacher unless a test says so. */
export const studentRecord = (id: string, payerId: string, over: Partial<StudentRecord> = {}): StudentRecord => ({
  id, firstName: "Arzo", fullName: "Arzo Luper", styleLine: "", format: "In person", isMinor: false,
  guardianName: null, guardianEmail: null, email: ARZO_EMAIL, studentSince: null,
  teacherAccountId: null, payerId, ghlContactId: null, billingContactId: null, ...over,
});

export function fixtureTables(): CoreTables {
  return {
    students: [
      studentRecord(STUDENT_A, PAYER_A),
      studentRecord(STUDENT_B, PAYER_B, { firstName: "Arzo", fullName: "Arzo Luper Jr", isMinor: true, email: null, guardianName: "Arzo Luper", guardianEmail: GUARDIAN_EMAIL }),
    ],
    guardians: [{ id: "g1", fullName: "Arzo Luper", email: GUARDIAN_EMAIL, accountId: null }],
    studentGuardians: [{ studentId: STUDENT_B, guardianId: "g1" }],
    payers: [
      { id: PAYER_A, fullName: "Arzo Luper", email: ARZO_EMAIL, guardianId: null },
      { id: PAYER_B, fullName: "Arzo Luper", email: GUARDIAN_EMAIL, guardianId: "g1" },
    ],
    lessons: [], bookings: [], invoices: [], payments: [],
  };
}

type Who = { role: "teacher" | "guardian" | "student"; aal?: string; mfa?: boolean; status?: "active" | "suspended"; links?: { studentId: string; canBook: boolean; canPay: boolean }[] };

export function buildDeps(users: Record<string, Who>, store: Partial<PortalStore> = {}, tables: CoreTables = fixtureTables()): Deps {
  const auth: Partial<AuthAdmin> = {
    verifyToken: async (token) => (users[token] ? { userId: token, email: `luperdev+${token}@gmail.com`, aal: users[token].aal ?? "aal2", mfaEnrolled: users[token].mfa ?? true } : null),
    sendPasswordReset: async () => undefined,
    sendPortalInvite: async () => null,
    verifyEmailOtp: async () => null,
    setBanned: async () => undefined,
  };
  const fullStore: Partial<PortalStore> = {
    ...memoryCoreStore(tables),
    getAccountByUser: async (id) => (users[id] ? { id, userId: id, role: users[id].role, status: users[id].status ?? "active", email: "", displayName: "T U", ghlContactId: null } : null),
    getLinks: async (id) => users[id]?.links ?? [],
    listNotes: async (_id, opts) => (opts.publishedOnly ? [] : [{ id: "draft" } as any]),
    listAssignedVideos: async () => [],
    listAssignments: async () => [],
    studentCounts: async () => ({}),
    studentAccounts: async () => ({}),
    recentNotes: async () => [],
    recentAssignedVideos: async () => [],
    listInvitations: async () => [],
    getAccount: async (id) => (users[id] ? { id, userId: id, role: users[id].role, status: users[id].status ?? "active", email: "", displayName: "Arzo Luper", ghlContactId: null } : null),
    audit: async () => undefined,
    listAudit: async () => [],
    lastInvoiceLinkSentAt: async () => null,
    attachInvitationAuthUser: async () => undefined,
    revokeInvitation: async () => undefined,
    revokePendingForEmail: async () => undefined,
    getInvitation: async () => null,
    findPendingInvitationByEmail: async () => null,
    deleteStudent: async () => undefined,
    createInvitation: async (i: any) => ({ ...i, id: "inv", status: "pending" }),
    ...store,
  };
  return {
    config: { appUrl: "https://app.example.com", supabase: null, safeMode: false, safeModeEmailAllowlist: [ARZO_EMAIL], videoBucket: "b", smtp: null, stripe: null, features: { packages: false, autopay: false, referrals: false, recurring: false, invoiceActions: false } },
    store: fullStore as PortalStore,
    auth: auth as AuthAdmin,
    limiter: memoryRateLimiter(),
  };
}
