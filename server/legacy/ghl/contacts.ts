// LEGACY. Used only to migrate old GoHighLevel records. The portal never imports this at runtime.
import { studentFormMessages } from "../../../shared/student-form.js";
import { ApiError } from "../../http.js";
import type { GhlClient, GhlContact } from "./client.js";

export interface LegacyStudentRow {
  fullName: string;
  email: string | null;
  guardianEmail: string | null;
  ghlContactId: string | null;
  billingContactId: string | null;
}

export interface LegacyNewStudent {
  fullName: string;
  isMinor: boolean;
  email: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
}

const alreadyEnrolled = () => new ApiError(409, "student_already_exists", studentFormMessages.duplicateStudent);
const duplicateEmail = () => new ApiError(409, "student_already_exists", studentFormMessages.duplicateEmail);

/**
 * Finds or creates the GoHighLevel contacts for a student. Everything that can refuse the request runs
 * before the first create, so a duplicate never leaves new contacts behind.
 */
export async function resolveStudentContacts(ghl: GhlClient, students: LegacyStudentRow[], input: LegacyNewStudent) {
  const sameName = (s: LegacyStudentRow) => s.fullName.toLowerCase() === input.fullName.toLowerCase();
  const studentEmail = input.email && input.email !== input.guardianEmail ? input.email : null;

  const guardian = input.isMinor ? await ghl.findContactByEmail(input.guardianEmail!) : null;
  const existing = studentEmail ? await ghl.findContactByEmail(studentEmail) : null;
  if (existing && students.some((s) => s.ghlContactId === existing.id)) throw alreadyEnrolled();
  if (studentEmail && students.some((s) => (s.email ?? "").toLowerCase() === studentEmail)) throw duplicateEmail();
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
