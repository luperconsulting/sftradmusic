// Authorization rules as pure functions, so they can be tested without any service.
import type { Role } from "../../shared/portal-types.js";
import { ApiError, forbidden } from "../http.js";

export interface StudentLink {
  studentId: string;
  canBook: boolean;
  canPay: boolean;
}

export interface Actor {
  userId: string;
  accountId: string;
  email: string;
  role: Role;
  status: "active" | "suspended";
  aal: string;
  mfaEnrolled: boolean;
  links: StudentLink[];
}

export function assertSessionAllowed(actor: Actor) {
  if (actor.status !== "active") throw new ApiError(403, "account_suspended", "This account's access has been turned off. Please contact Zane.");
  if (actor.role === "teacher" && actor.aal !== "aal2") throw new ApiError(403, "mfa_required", "Two-factor verification is required.");
  // Once someone has turned on 2FA, a password-only session is not enough, whatever the UI does.
  if (actor.mfaEnrolled && actor.aal !== "aal2") throw new ApiError(403, "mfa_required", "Two-factor verification is required.");
}

export function assertTeacher(actor: Actor) {
  if (actor.role !== "teacher") throw forbidden("This area is restricted to the teacher account.");
}

export function canViewStudent(actor: Actor, studentId: string) {
  return actor.role === "teacher" || actor.links.some((l) => l.studentId === studentId);
}

export function assertCanViewStudent(actor: Actor, studentId: string) {
  // Same response whether the student exists or not, so IDs can't be probed.
  if (!canViewStudent(actor, studentId)) throw forbidden();
}

export function canBookFor(actor: Actor, studentId: string) {
  return actor.role !== "teacher" && actor.links.some((l) => l.studentId === studentId && l.canBook);
}

export function canPayFor(actor: Actor, studentId: string) {
  return actor.role !== "teacher" && actor.links.some((l) => l.studentId === studentId && l.canPay);
}
