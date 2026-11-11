// API contract shared by the portal frontend and the /api server. Types only: nothing here ships secrets.
export type Role = "teacher" | "guardian" | "student";

export interface Features {
  /** Stripe Checkout in test mode for packages and sessions. Off unless CARD_PAYMENTS_ENABLED=true. */
  cardPayments: boolean;
}

/** What /api/me returns before the session has passed 2FA: just enough to choose the next screen. */
export interface MePending {
  mfaRequired: true;
  user: { role: Role; mfaEnabled: boolean; aal: string };
}

export interface MeResponse {
  mfaRequired?: false;
  user: { id: string; email: string; role: Role; displayName: string; mfaEnabled: boolean; aal: string };
  account: { label: string; ownerFirst: string; ownerFull: string; email: string; initials: string; isFamily: boolean };
  features: Features;
}

export interface StudentSummary {
  id: string;
  firstName: string;
  fullName: string;
  styleLine: string;
  format: "In person" | "Zoom";
  isMinor: boolean;
  guardianName: string | null;
  guardianEmail: string | null;
  studentSince: string | null;
}

export interface LessonDTO {
  id: string;
  studentId: string;
  startTime: string;
  endTime: string;
  status: string;
  locationLabel: string;
  locationSub: string;
  isZoom: boolean;
  /** The lesson this one replaced, when it was rescheduled. */
  rescheduledFromId?: string | null;
  /** Set while the lesson is held for payment ("pending_payment"). */
  holdExpiresAt?: string | null;
  invoiceId?: string | null;
  lateCancel?: boolean;
}

export interface NoteDTO {
  id: string;
  studentId: string;
  lessonDate: string;
  title: string;
  summary: string;
  technique: string;
  practice: string;
  goals: string;
  prep: string;
  status: "draft" | "published";
  publishedAt: string | null;
}

export interface VideoDTO {
  id: string;
  title: string;
  category: string;
  description: string;
  durationLabel: string;
  source: "upload" | "url";
  assignedCount?: number;
}

export interface AssignedVideoDTO extends VideoDTO {
  assignmentId: string;
  assignedAt: string;
  watchedAt: string | null;
}

export interface PracticeAssignmentDTO {
  id: string;
  title: string;
  instructions: string;
  dueDate: string | null;
  videoId: string | null;
  videoTitle: string | null;
  lessonDate: string | null;
  students: { id: string; name: string; completedAt: string | null }[];
}

export type InvoiceStatus = "draft" | "sent" | "payment_processing" | "paid" | "void" | "partially_paid" | "overdue";

export interface InvoiceDTO {
  id: string;
  number: string;
  title: string;
  status: InvoiceStatus;
  liveMode?: boolean;
  issueDate: string;
  dueDate: string;
  total: number;
  amountDue: number;
  amountPaid: number;
  currency: string;
  /** The payer (billing contact) id in Supabase. Empty when the invoice has no payer on file. */
  contactId: string;
  contactName: string;
  studentId: string;
  lines: { label: string; amount: number }[];
  /** Always null. Card payments, when on, go through POST /api/invoices/:id/checkout. */
  payUrl: string | null;
  kind?: "package" | "session" | "manual";
  /** The offline method the family chose: Zelle ($380 package) or cash ($375 package). */
  paymentMethod?: "zelle" | "cash" | "card" | null;
  /** The open "I've sent it" report, if any. The invoice stays unpaid until the teacher confirms it. */
  paymentReport?: PaymentReportDTO | null;
}

/** A payer's report that they sent money outside the portal (Zelle today; the method is generic text). */
export interface PaymentReportDTO {
  id: string;
  invoiceId: string;
  method: string;
  /** What the payer says they sent, in dollars. Null means the amount due. */
  amount: number | null;
  note: string;
  status: "pending" | "confirmed" | "not_received";
  reportedAt: string;
  reviewedAt: string | null;
}

/** The teacher's "Reported payments" list row. */
export interface TeacherPaymentReportDTO extends PaymentReportDTO {
  studentId: string;
  studentName: string;
  invoiceNumber: string;
  memo: string;
  amountDue: number;
  reportedBy: string;
}

/** GET /api/invoices/:id/zelle. Only for signed-in payers linked to the invoice. */
export type ZelleDetailsDTO =
  | { available: true; recipient: string; amountDue: number; memo: string; qrDataUrl: string | null; report: PaymentReportDTO | null }
  | { available: false; message: string; amountDue: number; memo: string; report: PaymentReportDTO | null };

/** The memo a payer puts on a Zelle payment, e.g. "SFTM-1042". */
export const invoiceMemo = (number: string | number) => `SFTM-${number}`;

export interface PaymentDTO {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  method: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  paidAt: string;
  reference?: string;
}

export interface ReferralPanelDTO {
  code: string;
  totalReferred: number;
  pending: { name: string; since: string }[];
  completed: { name: string; completedAt: string }[];
  creditsEarnedCents: number;
  creditsUsedCents: number;
  creditsAvailableCents: number;
  /** The code this student signed up with, if any, and whether its $15 discount is still to come. */
  referredBy: { code: string; discountPending: boolean } | null;
}

export interface StudioPolicyDTO {
  zelleRecipient: string;
  holdWindowMinutes: number;
  rescheduleNoticeHours: number;
  cancelNoticeHours: number;
}

export interface BillingDTO {
  outstanding: number;
  openInvoices: InvoiceDTO[];
  history: InvoiceDTO[];
  bookingBlocked: boolean;
  /** False while the portal takes no payments, so it never opens a checkout. */
  paymentsOpen: boolean;
  payments: PaymentDTO[];
}

export interface DashboardResponse {
  students: StudentSummary[];
  student: StudentSummary | null;
  upcoming: LessonDTO[];
  history: LessonDTO[];
  notes: NoteDTO[];
  videos: AssignedVideoDTO[];
  assignments: PracticeAssignmentDTO[];
  /** Lesson credits left: 4 per paid package, 1 used per booked lesson. */
  packageLessons: number;
  /** The teacher's payment and notice rules, including the Zelle recipient. Null when not readable. */
  policy: StudioPolicyDTO | null;
  /** The referral side panel. Null when not readable. */
  referrals: ReferralPanelDTO | null;
  /** null means billing could not be read. The UI must never present that as a zero balance. */
  billing: BillingDTO | null;
  /** Lessons read from Supabase. false means lesson data is unavailable, not empty. */
  lessonsAvailable: boolean;
  canBook: boolean;
  canPay: boolean;
  readOnly: boolean;
}

export interface SlotsResponse {
  timezone: string;
  days: Record<string, string[]>;
}

export interface InvitationDTO {
  id: string;
  name: string;
  email: string;
  studentName: string;
  status: "pending" | "code_issued" | "accepted" | "expired" | "revoked" | "reset_sent" | "disabled";
  method: "email" | "code";
  sentAt: string;
  expiresAt: string | null;
  accountId: string | null;
  /** Only ever present in the response that created it. Only a hash is stored. */
  credential?: string;
  inviteUrl?: string;
  /** True when Supabase accepted the invitation email. Safe mode does not turn this off for an allowlisted address. */
  emailed?: boolean;
}

export interface InvitationPreview {
  firstName: string;
  studentLine: string;
  accountFor: string;
  email: string;
  lessons: string;
  format: string;
  expiresAt: string;
}

export interface GhlContactOption {
  id: string;
  name: string;
  email: string | null;
  /** Set when this contact is already linked to a student. */
  studentName: string | null;
}

export interface TeacherStudentRow extends StudentSummary {
  email: string | null;
  nextLesson: string | null;
  /** The next lesson's state: held lessons (waiting for payment) count as upcoming. */
  nextLessonStatus?: "confirmed" | "pending_payment" | null;
  /** Upcoming lessons, confirmed or held. */
  upcomingCount?: number;
  noteCount: number;
  videoCount: number;
  assignmentCount: number;
  /** Placeholder package credits recorded in the portal. */
  packageLessons: number;
  accountId: string | null;
  portalStatus: "active" | "suspended" | "none";
  transferPending: boolean;
}

export interface IntegrationHealth {
  supabase: boolean;
  storage: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export const OUTSTANDING_BALANCE_MESSAGE =
  "You have an outstanding balance. Please complete payment before scheduling another lesson.";
