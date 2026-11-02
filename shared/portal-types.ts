// API contract shared by the portal frontend and the /api server. Types only: nothing here ships secrets.
export type Role = "teacher" | "guardian" | "student";

export interface Features {
  packages: boolean;
  autopay: boolean;
  referrals: boolean;
  recurring: boolean;
  invoiceActions: boolean;
}

export interface MeResponse {
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
  contactId: string;
  contactName: string;
  lines: { label: string; amount: number }[];
}

export interface BillingDTO {
  outstanding: number;
  openInvoices: InvoiceDTO[];
  history: InvoiceDTO[];
  bookingBlocked: boolean;
}

export interface DashboardResponse {
  students: StudentSummary[];
  student: StudentSummary | null;
  upcoming: LessonDTO[];
  history: LessonDTO[];
  notes: NoteDTO[];
  videos: AssignedVideoDTO[];
  assignments: PracticeAssignmentDTO[];
  /** null means billing could not be read. The UI must never present that as a zero balance. */
  billing: BillingDTO | null;
  /** Lessons read from GoHighLevel. false means lesson data is unavailable, not empty. */
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

export interface TeacherStudentRow extends StudentSummary {
  nextLesson: string | null;
  noteCount: number;
  videoCount: number;
  assignmentCount: number;
  accountId: string | null;
  portalStatus: "active" | "suspended" | "none";
  transferPending: boolean;
  ghlContactId: string;
  billingContactId: string;
}

export interface IntegrationHealth {
  supabase: boolean;
  ghl: boolean;
  storage: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export const OUTSTANDING_BALANCE_MESSAGE =
  "You have an outstanding balance. Please complete payment before scheduling another lesson.";
