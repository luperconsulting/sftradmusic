import type {
  AssignedVideoDTO,
  InvitationDTO,
  NoteDTO,
  PracticeAssignmentDTO,
  Role,
  StudentSummary,
  VideoDTO,
} from "../../shared/portal-types.js";
import type { StudentFormat } from "../../shared/student-form.js";
import type { StudentLink } from "../auth/policy.js";

export interface AccountRecord {
  id: string;
  userId: string;
  role: Role;
  status: "active" | "suspended";
  email: string;
  displayName: string;
  ghlContactId: string | null;
}

export interface StudentRecord extends StudentSummary {
  email: string | null;
  /** The teacher who owns this student. RLS lets a teacher read only their own students' records. */
  teacherAccountId: string | null;
  /** The billing contact (payer) row in Supabase. A child's payer is a guardian; an adult pays for themself. */
  payerId: string | null;
  /** Legacy GoHighLevel references. Optional, kept only for migration. Nothing at runtime reads them. */
  ghlContactId: string | null;
  billingContactId: string | null;
}

export interface NewStudentInput {
  fullName: string;
  isMinor: boolean;
  email: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
  format: StudentFormat;
  teacherAccountId: string | null;
}

export type LessonStatus = "scheduled" | "completed" | "cancelled" | "rescheduled" | "no_show";

export interface LessonRecord {
  id: string;
  studentId: string;
  teacherAccountId: string | null;
  startsAt: string;
  endsAt: string;
  locationKind: "in_person" | "zoom";
  location: string;
  zoomUrl: string | null;
  status: LessonStatus;
  cancelledAt: string | null;
  cancellationReason: string | null;
  rescheduledFromId: string | null;
  createdAt: string;
}

export interface NewLessonInput {
  studentId: string;
  teacherAccountId: string | null;
  startsAt: string;
  endsAt: string;
  locationKind: "in_person" | "zoom";
  location: string;
  zoomUrl: string | null;
  createdByAccountId: string;
  source: "teacher" | "portal" | "import";
  rescheduledFromId?: string | null;
}

export type InvoiceRecordStatus = "draft" | "sent" | "partially_paid" | "paid" | "void";

export interface InvoiceRecord {
  id: string;
  number: number;
  studentId: string;
  payerId: string | null;
  payerName: string;
  title: string;
  currency: string;
  totalCents: number;
  amountPaidCents: number;
  status: InvoiceRecordStatus;
  issueDate: string;
  dueDate: string;
  createdAt: string;
  lines: { label: string; amountCents: number; lessonId: string | null }[];
}

export interface NewInvoiceInput {
  studentId: string;
  payerId: string | null;
  title: string;
  issueDate: string;
  dueDate: string;
  status: "draft" | "sent";
  lines: { label: string; amountCents: number; lessonId: string | null }[];
  createdByAccountId: string;
}

export interface PaymentRecord {
  id: string;
  invoiceId: string;
  payerId: string | null;
  amountCents: number;
  method: "manual" | "cash" | "check" | "card" | "bank_transfer" | "other";
  status: "pending" | "succeeded" | "failed" | "refunded";
  paidAt: string;
  note: string;
}

export interface InvitationRecord {
  id: string;
  tokenHash: string;
  method: "email" | "code";
  email: string;
  name: string;
  role: "guardian" | "student";
  studentIds: string[];
  status: "pending" | "accepted" | "revoked";
  expiresAt: string;
  preview: { lessons: string; format: string; studentLine: string; accountFor: string; firstName: string; authUserId?: string };
}

export interface NoteInput {
  studentId: string;
  lessonDate: string;
  title: string;
  summary: string;
  technique: string;
  practice: string;
  goals: string;
  prep: string;
}

export interface VideoInput {
  title: string;
  category: string;
  description: string;
  source: "upload" | "url";
  externalUrl?: string;
  storagePath?: string;
}

export interface AssignmentInput {
  title: string;
  instructions: string;
  dueDate: string | null;
  videoId: string | null;
  lessonDate: string | null;
  studentIds: string[];
}

export interface PortalStore {
  getAccountByUser(userId: string): Promise<AccountRecord | null>;
  getLinks(accountId: string): Promise<StudentLink[]>;
  getStudent(id: string): Promise<StudentRecord | null>;
  getStudents(ids: string[]): Promise<StudentRecord[]>;
  listStudents(): Promise<StudentRecord[]>;
  /** Throws a 503 if the database is missing the core-data migration (0005). */
  checkStudentSchema(): Promise<void>;
  /**
   * Creates the student in Supabase with its guardian link (children) and billing contact.
   * An existing guardian with the same email is reused, so siblings share one payer. No outside system is called.
   */
  createStudent(input: NewStudentInput): Promise<{ student: StudentRecord; guardian: "created" | "reused" | null }>;

  /** The studio's first active teacher. New students without an explicit teacher are assigned here. */
  studioTeacherAccountId(): Promise<string | null>;

  listLessons(query: { studentIds?: string[]; teacherAccountId?: string; from?: string; to?: string }): Promise<LessonRecord[]>;
  getLesson(id: string): Promise<LessonRecord | null>;
  /** Inserts the lesson and its booking row. */
  createLesson(input: NewLessonInput): Promise<LessonRecord>;
  /** Marks a lesson cancelled (with who and why) or rescheduled. */
  closeLesson(id: string, input: { status: "cancelled" | "rescheduled"; byAccountId: string; reason: string | null }): Promise<LessonRecord>;

  listInvoices(query: { studentIds?: string[]; includeDrafts: boolean }): Promise<InvoiceRecord[]>;
  getInvoice(id: string): Promise<InvoiceRecord | null>;
  createInvoice(input: NewInvoiceInput): Promise<InvoiceRecord>;
  updateInvoiceStatus(id: string, patch: { status: InvoiceRecordStatus; amountPaidCents?: number }): Promise<InvoiceRecord>;
  listPayments(invoiceIds: string[]): Promise<PaymentRecord[]>;
  recordPayment(input: { invoiceId: string; payerId: string | null; amountCents: number; method: PaymentRecord["method"]; note: string; recordedByAccountId: string }): Promise<PaymentRecord>;
  studentCounts(): Promise<Record<string, { notes: number; videos: number; assignments: number }>>;
  studentAccounts(): Promise<Record<string, { accountId: string; status: "active" | "suspended" }>>;

  listNotes(studentId: string, opts: { publishedOnly: boolean }): Promise<NoteDTO[]>;
  recentNotes(limit: number): Promise<(NoteDTO & { studentName: string })[]>;
  getNote(id: string): Promise<NoteDTO | null>;
  saveNote(id: string | null, input: NoteInput, authorAccountId: string): Promise<NoteDTO>;
  publishNote(id: string): Promise<NoteDTO>;

  listVideos(): Promise<VideoDTO[]>;
  getVideo(id: string): Promise<(VideoDTO & { externalUrl: string | null; storagePath: string | null }) | null>;
  saveVideo(id: string | null, input: VideoInput): Promise<VideoDTO>;
  listAssignedVideos(studentId: string): Promise<AssignedVideoDTO[]>;
  recentAssignedVideos(limit: number): Promise<{ title: string; to: string; assignedAt: string }[]>;
  videoAssignees(videoId: string): Promise<string[]>;
  setVideoAssignees(videoId: string, studentIds: string[]): Promise<void>;
  isVideoAssignedToAny(videoId: string, studentIds: string[]): Promise<boolean>;
  markVideoWatched(videoId: string, studentId: string): Promise<void>;
  signedPlaybackUrl(storagePath: string): Promise<string>;
  signedUploadUrl(storagePath: string): Promise<string>;

  listAssignments(studentId: string | null): Promise<PracticeAssignmentDTO[]>;
  createAssignment(input: AssignmentInput): Promise<PracticeAssignmentDTO>;
  setAssignmentComplete(assignmentId: string, studentId: string, done: boolean): Promise<void>;

  listInvitations(): Promise<InvitationDTO[]>;
  createInvitation(input: Omit<InvitationRecord, "id" | "status">): Promise<InvitationRecord>;
  findInvitationByHash(hash: string): Promise<InvitationRecord | null>;
  /** Newest pending invite for this email, including one whose clock has run out. */
  findPendingInvitationByEmail(email: string): Promise<InvitationRecord | null>;
  /** Atomically claims a pending, unexpired invitation. Returns false if it was already used. */
  claimInvitation(id: string): Promise<boolean>;
  releaseInvitation(id: string): Promise<void>;
  getInvitation(id: string): Promise<InvitationRecord | null>;
  revokeInvitation(id: string): Promise<void>;
  /** Pending invites for this email stop working. A resend calls this before issuing a new code. */
  /** Revokes this email's pending invitations, except the one just issued. */
  revokePendingForEmail(email: string, exceptId?: string): Promise<void>;
  /** Remembers the Supabase login created by an invite email. Not returned to the browser. */
  attachInvitationAuthUser(id: string, authUserId: string): Promise<void>;
  deleteStudent(id: string): Promise<void>;
  createAccountForInvitation(invite: InvitationRecord, userId: string): Promise<void>;
  setAccountStatus(accountId: string, status: "active" | "suspended"): Promise<AccountRecord>;
  getAccount(accountId: string): Promise<AccountRecord | null>;

  /** Rows written by audit(), oldest first. Used for package credits, autopay, and referrals. */
  listAudit(action: string): Promise<{ target: string; meta: Record<string, unknown> }[]>;

  /** When a payment link was last sent, from the audit log, so the limit holds across server instances. */
  lastInvoiceLinkSentAt(invoiceId: string): Promise<string | null>;
  audit(actorAccountId: string | null, action: string, target: string, meta?: Record<string, unknown>): Promise<void>;
}

export interface AuthAdmin {
  /** Validates a Supabase access token with Supabase. Returns null for anything invalid or expired. */
  verifyToken(token: string): Promise<{ userId: string; email: string; aal: string; mfaEnrolled: boolean } | null>;
  createUser(email: string, password: string, existingUserId?: string | null): Promise<string>;
  deleteUser(userId: string): Promise<void>;
  /**
   * Emails a Supabase one-time code (signInWithOtp). The message is the Magic Link template.
   * Public sign-ups are off, so the login is created (or reused) with the admin API first.
   * redirectTo is only a fallback if that template still contains a link. It must be this deployment's /invite page.
   * Returns null: the login is confirmed only when the code is verified.
   */
  sendPortalInvite(email: string, redirectTo: string): Promise<string | null>;
  /** Checks the email OTP from {{ .Token }} with verifyOtp type "email". Null when Supabase rejects it. */
  verifyEmailOtp(email: string, code: string): Promise<{ userId: string; accessToken: string; refreshToken: string } | null>;
  sendPasswordReset(email: string): Promise<void>;
  setBanned(userId: string, banned: boolean): Promise<void>;
}
