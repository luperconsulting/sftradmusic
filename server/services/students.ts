import { studentFormError, studentFormMessages, type StudentFormat } from "../../shared/student-form.js";
import { ApiError } from "../http.js";
import type { GhlClient, GhlContact } from "../integrations/ghl.js";
import type { PortalStore, StudentRecord } from "../store/types.js";

export interface NewStudent {
  fullName: string;
  isMinor: boolean;
  email: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
  format: StudentFormat;
}

export interface ParsedStudent extends NewStudent {
  ghlContactId?: string;
  billingContactId?: string;
}

const alreadyEnrolled = () => new ApiError(409, "student_already_exists", studentFormMessages.duplicateStudent);
const duplicateEmail = () => new ApiError(409, "student_already_exists", studentFormMessages.duplicateEmail);

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Turns the teacher form into a student, or a 400 whose message matches the form. */
export function parseNewStudent(body: unknown): ParsedStudent {
  if (!body || typeof body !== "object") throw new ApiError(400, "invalid_input", "Some of the details provided aren't valid.");
  const raw = body as Record<string, unknown>;
  const ageCategory = raw.ageCategory === "child" || raw.ageCategory === "adult" ? raw.ageCategory : "";
  const format = raw.format === undefined || raw.format === "" ? "In person" : text(raw.format);
  const message = studentFormError({
    fullName: text(raw.fullName),
    ageCategory,
    email: text(raw.email),
    guardianName: text(raw.guardianName),
    guardianEmail: text(raw.guardianEmail),
    format,
  });
  if (message) throw new ApiError(400, "invalid_input", message);
  const isMinor = ageCategory === "child";
  const email = text(raw.email).trim().toLowerCase() || null;
  const guardianEmail = text(raw.guardianEmail).trim().toLowerCase() || null;
  return {
    fullName: text(raw.fullName).trim(),
    isMinor,
    email,
    guardianName: isMinor ? text(raw.guardianName).trim() : null,
    guardianEmail: isMinor ? guardianEmail : null,
    format: format as StudentFormat,
    ...optionalContactId("ghlContactId", raw.ghlContactId),
    ...optionalContactId("billingContactId", raw.billingContactId),
  };
}

function optionalContactId(key: "ghlContactId" | "billingContactId", value: unknown): Partial<ParsedStudent> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") throw new ApiError(400, "invalid_input", "Some of the details provided aren't valid.");
  const id = value.trim();
  if (!id || id.length > 100) throw new ApiError(400, "invalid_input", "Some of the details provided aren't valid.");
  return { [key]: id };
}

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

/**
 * Creates the student row when an invitation is accepted. No contact is created before this.
 * A failed insert deletes only contacts this call created and records them on the audit log.
 */
export async function enrollInvitedStudent(
  ghl: GhlClient,
  store: Pick<PortalStore, "checkStudentSchema" | "listStudents" | "createStudent" | "audit">,
  input: { fullName: string; email: string },
) {
  await store.checkStudentSchema();
  const details = {
    fullName: input.fullName,
    isMinor: false,
    email: input.email,
    guardianName: null,
    guardianEmail: null,
    format: "In person" as const,
  };
  const roster = await store.listStudents();
  if (roster.some((s) => (s.email ?? "").toLowerCase() === input.email)) throw duplicateEmail();
  const linked = await resolveStudentContacts(ghl, roster, details);
  try {
    const student = await store.createStudent({ ...details, ghlContactId: linked.ghlContactId, billingContactId: linked.billingContactId });
    if (!student) throw new ApiError(409, "contact_already_linked", "That GoHighLevel contact is already linked to a student.");
    return { student, createdContactIds: linked.createdContactIds };
  } catch (e) {
    if (linked.createdContactIds.length) {
      for (const id of linked.createdContactIds) {
        try {
          await ghl.deleteContact(id);
        } catch {
          console.error(`[ghl] could not remove contact ${id} after the student record failed to save`);
        }
      }
      await store.audit(null, "student.create_failed", "", { createdContactIds: linked.createdContactIds }).catch(() => undefined);
    }
    throw e;
  }
}
