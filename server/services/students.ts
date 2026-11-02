import { ApiError } from "../http.js";
import type { GhlClient, GhlContact } from "../integrations/ghl.js";
import type { StudentRecord } from "../store/types.js";

export interface NewStudent {
  fullName: string;
  isMinor: boolean;
  email: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
}

const alreadyEnrolled = () => new ApiError(409, "student_already_exists", "This student is already enrolled.");

/**
 * Finds or creates the GoHighLevel contacts for a new student. Everything that can refuse the request runs
 * before the first create, so a duplicate never leaves new contacts behind.
 */
export async function resolveStudentContacts(ghl: GhlClient, students: StudentRecord[], input: NewStudent) {
  const sameName = (s: StudentRecord) => s.fullName.toLowerCase() === input.fullName.toLowerCase();
  // A child who shares the parent's email can't have it on their own contact: GoHighLevel would match the parent.
  const studentEmail = input.email && input.email !== input.guardianEmail ? input.email : null;

  const guardian = input.isMinor ? await ghl.findContactByEmail(input.guardianEmail!) : null;
  const existing = studentEmail ? await ghl.findContactByEmail(studentEmail) : null;
  if (existing && students.some((s) => s.ghlContactId === existing.id)) throw alreadyEnrolled();
  if (studentEmail && students.some((s) => s.email === studentEmail)) throw alreadyEnrolled();
  if (input.isMinor && students.some((s) => sameName(s) && (s.guardianEmail === input.guardianEmail || s.billingContactId === guardian?.id))) throw alreadyEnrolled();

  const billing: { contact: GhlContact; created: boolean } | null = !input.isMinor ? null : guardian
    ? { contact: guardian, created: false }
    : await ghl.createContact({ name: input.guardianName!, email: input.guardianEmail! });
  const student = existing
    ? { contact: existing, created: false }
    : await ghl.createContact({ name: input.fullName, email: studentEmail });

  return {
    ghlContactId: student.contact.id,
    billingContactId: billing?.contact.id ?? student.contact.id,
    createdContactIds: [student, ...(billing ? [billing] : [])].filter((c) => c.created).map((c) => c.contact.id),
    contacts: { student: student.created ? "created" : "reused", billing: billing ? (billing.created ? "created" : "reused") : "same" },
  };
}
