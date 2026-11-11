import type { GoogleBusyClient } from "../integrations/googleCalendar.js";
import type { Mailer } from "../mail/mailer.js";
import type { PortalStore, StudentRecord } from "../store/types.js";

/** What the portal's business rules need: Supabase, mail, Google free/busy and a clock. */
export interface PortalContext {
  store: PortalStore;
  mailer: Mailer;
  google: GoogleBusyClient | null;
  appUrl: string;
  now: () => number;
}

/** Lesson and billing email goes to the payer: the guardian for a child, the student for an adult. */
export const recipientFor = (s: Pick<StudentRecord, "isMinor" | "guardianEmail" | "email">) => (s.isMinor ? s.guardianEmail : s.email) ?? null;

/** The teacher whose rules apply to this student. */
export async function teacherFor(store: PortalStore, s: Pick<StudentRecord, "teacherAccountId">) {
  return s.teacherAccountId ?? (await store.studioTeacherAccountId());
}
