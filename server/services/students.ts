import { studentFormError, studentFormMessages, type StudentFormat } from "../../shared/student-form.js";
import { ApiError } from "../http.js";
import type { PortalStore, StudentRecord } from "../store/types.js";

export interface NewStudent {
  fullName: string;
  isMinor: boolean;
  email: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
  format: StudentFormat;
}

const alreadyEnrolled = () => new ApiError(409, "student_already_exists", studentFormMessages.duplicateStudent);
const duplicateEmail = () => new ApiError(409, "student_already_exists", studentFormMessages.duplicateEmail);

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Turns the teacher form into a student, or a 400 whose message matches the form.
 * GoHighLevel contact ids are no longer accepted or needed; any sent by an old client are ignored.
 */
export function parseNewStudent(body: unknown): NewStudent {
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
    fullName: text(raw.fullName).trim().replace(/\s+/g, " "),
    isMinor,
    email,
    guardianName: isMinor ? text(raw.guardianName).trim() : null,
    guardianEmail: isMinor ? guardianEmail : null,
    format: format as StudentFormat,
  };
}

/**
 * Duplicate checks against the Supabase roster. Throws a 409 for:
 *  - a student email already on another student (a child may share the guardian's email, so that alone is allowed)
 *  - a child with the same name and the same guardian email
 *  - an adult with the same name and the same email
 */
export function assertNotDuplicate(roster: StudentRecord[], input: NewStudent) {
  const name = input.fullName.toLowerCase();
  const sameName = (s: StudentRecord) => s.fullName.trim().replace(/\s+/g, " ").toLowerCase() === name;
  const lower = (v: string | null) => (v ?? "").trim().toLowerCase();
  if (input.isMinor) {
    if (roster.some((s) => s.isMinor && sameName(s) && lower(s.guardianEmail) === input.guardianEmail)) throw alreadyEnrolled();
  } else if (roster.some((s) => !s.isMinor && sameName(s) && lower(s.email) === input.email)) {
    throw alreadyEnrolled();
  }
  // A child's own email can match their guardian's. Any other repeat of a student email is a duplicate.
  const ownEmail = input.email && input.email !== input.guardianEmail ? input.email : null;
  if (ownEmail && roster.some((s) => lower(s.email) === ownEmail && lower(s.email) !== lower(s.guardianEmail))) throw duplicateEmail();
}

/** Creates a student, with a guardian link and payer for a child, entirely in Supabase. */
export async function createStudent(
  store: Pick<PortalStore, "checkStudentSchema" | "listStudents" | "createStudent">,
  input: NewStudent,
  teacherAccountId: string | null,
) {
  await store.checkStudentSchema();
  assertNotDuplicate(await store.listStudents(), input);
  return store.createStudent({ ...input, teacherAccountId });
}

/** Creates the student row when an invitation for a new adult is accepted. Supabase only. */
export async function enrollInvitedStudent(
  store: Pick<PortalStore, "checkStudentSchema" | "listStudents" | "createStudent">,
  input: { fullName: string; email: string; teacherAccountId: string | null },
) {
  const { student } = await createStudent(store, {
    fullName: input.fullName,
    isMinor: false,
    email: input.email.toLowerCase(),
    guardianName: null,
    guardianEmail: null,
    format: "In person",
  }, input.teacherAccountId);
  return { student };
}
