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

export type LessonStatus = "scheduled" | "pending_payment" | "completed" | "cancelled" | "rescheduled" | "released" | "no_show";

export interface LessonRecord {
  id: string;
  studentId: string;
  /** Required: every lesson belongs to a teacher (not null in the database). */
  teacherAccountId: string;
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
  /** Set while a single session waits for payment. The slot is released after this time. */
  holdExpiresAt: string | null;
  invoiceId: string | null;
  seriesId: string | null;
  lateCancel: boolean;
}

export interface NewLessonInput {
  studentId: string;
  /** Required. The store refuses a lesson without a teacher, and so does the database. */
  teacherAccountId: string;
  startsAt: string;
  endsAt: string;
  locationKind: "in_person" | "zoom";
  location: string;
  zoomUrl: string | null;
  createdByAccountId: string;
  source: "teacher" | "portal" | "import";
  rescheduledFromId?: string | null;
  status?: "scheduled" | "pending_payment";
  holdExpiresAt?: string | null;
  invoiceId?: string | null;
  seriesId?: string | null;
}

export interface StudioSettings {
  teacherAccountId: string;
  holdWindowMinutes: number;
  rescheduleNoticeHours: number;
  cancelNoticeHours: number;
  zelleRecipient: string;
  timezone: string;
}

export interface LessonHoursRow {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export type InvoiceKind = "package" | "session" | "manual";
export type PaymentMethodChoice = "zelle" | "cash" | "card";

export interface ReferralRecord {
  id: string;
  referrerStudentId: string;
  referredStudentId: string;
  code: string;
  status: "pending" | "completed";
  discountCents: number;
  discountInvoiceId: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ReferralCreditRecord {
  id: string;
  referralId: string;
  studentId: string;
  amountCents: number;
  usedInvoiceId: string | null;
  usedAt: string | null;
  createdAt: string;
}

export type InvoiceRecordStatus = "draft" | "sent" | "partially_paid" | "paid" | "void";

export interface InvoiceRecord {
  id: string;
  number: number;
  studentId: string;
  payerId: string | null;
  payerName: string;
  payerEmail: string | null;
  title: string;
  currency: string;
  totalCents: number;
  amountPaidCents: number;
  status: InvoiceRecordStatus;
  issueDate: string;
  dueDate: string;
  createdAt: string;
  lines: { label: string; amountCents: number; lessonId: string | null }[];
  kind: InvoiceKind;
  paymentMethodChoice: PaymentMethodChoice | null;
  packageLessons: number;
}

export interface NewInvoiceInput {
  studentId: string;
  payerId: string | null;
  title: string;
  issueDate: string;
  dueDate: string;
  status: "draft" | "sent";
  lines: { label: string; amountCents: number; lessonId: string | null }[];
  createdByAccountId: string | null;
  kind?: InvoiceKind;
  paymentMethodChoice?: PaymentMethodChoice | null;
  packageLessons?: number;
}

export interface PaymentRecord {
  id: string;
  invoiceId: string;
  payerId: string | null;
  amountCents: number;
  method: PaymentMethod;
  status: "pending" | "succeeded" | "failed" | "refunded";
  paidAt: string;
  note: string;
  reference: string;
}

export type PaymentMethod = "zelle" | "cash" | "card" | "manual" | "check" | "bank_transfer" | "other";

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

  listLessons(query: { studentIds?: string[]; teacherAccountId?: string; from?: string; to?: string; createdFrom?: string; statuses?: LessonRecord["status"][] }): Promise<LessonRecord[]>;
  getLesson(id: string): Promise<LessonRecord | null>;
  /** Inserts the lesson and its booking row. */
  createLesson(input: NewLessonInput): Promise<LessonRecord>;
  /** Marks a lesson cancelled (with who and why) or rescheduled. */
  closeLesson(id: string, input: { status: "cancelled" | "rescheduled" | "released"; byAccountId: string | null; reason: string | null; lateCancel?: boolean }): Promise<LessonRecord>;
  /** Confirms a held lesson (clears the hold) or moves its invoice link. */
  updateLesson(id: string, patch: { status?: "scheduled" | "pending_payment"; holdExpiresAt?: string | null; invoiceId?: string | null }): Promise<LessonRecord>;
  listLessonsByInvoice(invoiceId: string): Promise<LessonRecord[]>;
  /** Held lessons whose hold has run out (or whose start has arrived) as of `now`. */
  listExpiredHolds(now: string): Promise<LessonRecord[]>;
  createSeries(input: { studentId: string; teacherAccountId: string | null; createdByAccountId: string }): Promise<string>;

  getSettings(teacherAccountId: string): Promise<StudioSettings>;
  saveSettings(teacherAccountId: string, patch: Partial<Omit<StudioSettings, "teacherAccountId">>): Promise<StudioSettings>;
  listLessonHours(teacherAccountId: string): Promise<LessonHoursRow[]>;
  replaceLessonHours(teacherAccountId: string, rows: LessonHoursRow[]): Promise<LessonHoursRow[]>;

  creditBalances(studentIds: string[]): Promise<Record<string, number>>;
  /** False when the ledger already has this package payment or this lesson's entry (unique per reason). */
  addCredit(input: { studentId: string; delta: number; reason: "package_paid" | "lesson_booked" | "lesson_refund" | "adjustment"; invoiceId?: string | null; lessonId?: string | null; byAccountId?: string | null }): Promise<boolean>;

  getReferralCode(studentId: string): Promise<string | null>;
  saveReferralCode(studentId: string, code: string): Promise<void>;
  findStudentByReferralCode(code: string): Promise<string | null>;
  /** Null when the referred student already has a referral. */
  createReferral(input: { referrerStudentId: string; referredStudentId: string; code: string; discountCents: number }): Promise<ReferralRecord | null>;
  getReferralForReferred(studentId: string): Promise<ReferralRecord | null>;
  listReferrals(query: { referrerStudentIds?: string[] }): Promise<ReferralRecord[]>;
  updateReferral(id: string, patch: { status?: "completed"; discountInvoiceId?: string | null; completedAt?: string | null }): Promise<void>;
  /** False when this referral already earned its credit. */
  createReferralCredit(input: { referralId: string; studentId: string; amountCents: number }): Promise<boolean>;
  listReferralCredits(studentIds: string[]): Promise<ReferralCreditRecord[]>;
  setReferralCreditUsed(id: string, invoiceId: string | null): Promise<void>;

  setInvoiceStripeSession(invoiceId: string, sessionId: string): Promise<void>;
  /** False when this Stripe event was already handled. */
  claimStripeEvent(id: string, type: string, invoiceId: string | null): Promise<boolean>;

  listInvoices(query: { studentIds?: string[]; includeDrafts: boolean }): Promise<InvoiceRecord[]>;
  getInvoice(id: string): Promise<InvoiceRecord | null>;
  createInvoice(input: NewInvoiceInput): Promise<InvoiceRecord>;
  updateInvoiceStatus(id: string, patch: { status: InvoiceRecordStatus; amountPaidCents?: number }): Promise<InvoiceRecord>;
  listPayments(invoiceIds: string[]): Promise<PaymentRecord[]>;
  recordPayment(input: { invoiceId: string; payerId: string | null; amountCents: number; method: PaymentMethod; note: string; reference?: string; paidAt?: string; recordedByAccountId: string | null }): Promise<PaymentRecord>;
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
