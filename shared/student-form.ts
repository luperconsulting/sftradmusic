// Shared by the teacher form and the API so both reject the same input with the same sentences.
export const STUDENT_FORMATS = ["In person", "Zoom"] as const;
export type StudentFormat = (typeof STUDENT_FORMATS)[number];

export const studentFormMessages = {
  name: "Enter the student's full name.",
  age: "Choose whether the student is a child or an adult.",
  format: "Choose a lesson format.",
  emailRequired: "Enter the student's email address.",
  emailInvalid: "Enter a valid email address.",
  guardianName: "Enter the parent or guardian's name.",
  guardianEmailRequired: "Enter the parent or guardian's email address.",
  guardianEmailInvalid: "Enter a valid email address for the parent or guardian.",
  duplicateEmail: "A student with this email is already enrolled.",
  duplicateStudent: "This student is already enrolled.",
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function studentFormError(input: {
  fullName?: string;
  ageCategory?: string;
  email?: string;
  guardianName?: string;
  guardianEmail?: string;
  format?: string;
}): string | null {
  const name = (input.fullName ?? "").trim();
  if (!name) return studentFormMessages.name;
  if (name.length > 120) return "Some of the details provided aren't valid.";
  if (input.ageCategory !== "child" && input.ageCategory !== "adult") return studentFormMessages.age;
  const email = (input.email ?? "").trim();
  const guardianName = (input.guardianName ?? "").trim();
  const guardianEmail = (input.guardianEmail ?? "").trim();
  if (email.length > 200 || guardianName.length > 120 || guardianEmail.length > 200) return "Some of the details provided aren't valid.";
  if (input.ageCategory === "adult") {
    if (!email) return studentFormMessages.emailRequired;
    if (!EMAIL_RE.test(email)) return studentFormMessages.emailInvalid;
  } else {
    if (email && !EMAIL_RE.test(email)) return studentFormMessages.emailInvalid;
    if (!guardianName) return studentFormMessages.guardianName;
    if (!guardianEmail) return studentFormMessages.guardianEmailRequired;
    if (!EMAIL_RE.test(guardianEmail)) return studentFormMessages.guardianEmailInvalid;
  }
  if (input.format !== "In person" && input.format !== "Zoom") return studentFormMessages.format;
  return null;
}
