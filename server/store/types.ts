import type {
  AssignedVideoDTO,
  InvitationDTO,
  NoteDTO,
  PracticeAssignmentDTO,
  Role,
  StudentSummary,
  VideoDTO,
} from "../../shared/portal-types.js";
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
  ghlContactId: string;
  billingContactId: string;
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
  preview: { lessons: string; format: string; studentLine: string; accountFor: string; firstName: string };
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
  /** Atomically claims a pending, unexpired invitation. Returns false if it was already used. */
  claimInvitation(id: string): Promise<boolean>;
  releaseInvitation(id: string): Promise<void>;
  revokeInvitation(id: string): Promise<void>;
  createAccountForInvitation(invite: InvitationRecord, userId: string): Promise<void>;
  setAccountStatus(accountId: string, status: "active" | "suspended"): Promise<AccountRecord>;
  getAccount(accountId: string): Promise<AccountRecord | null>;

  /** When a payment link was last sent, from the audit log, so the limit holds across server instances. */
  lastInvoiceLinkSentAt(invoiceId: string): Promise<string | null>;
  audit(actorAccountId: string | null, action: string, target: string, meta?: Record<string, unknown>): Promise<void>;
}

export interface AuthAdmin {
  /** Validates a Supabase access token with Supabase. Returns null for anything invalid or expired. */
  verifyToken(token: string): Promise<{ userId: string; email: string; aal: string; mfaEnrolled: boolean } | null>;
  createUser(email: string, password: string): Promise<string>;
  deleteUser(userId: string): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  setBanned(userId: string, banned: boolean): Promise<void>;
}
