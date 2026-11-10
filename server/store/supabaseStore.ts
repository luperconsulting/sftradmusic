import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AssignedVideoDTO, InvitationDTO, NoteDTO, PracticeAssignmentDTO, VideoDTO } from "../../shared/portal-types.js";
import { ApiError } from "../http.js";
import { inviteRateLimitSeconds } from "../services/invitations.js";
import type { AccountRecord, AuthAdmin, InvitationRecord, PortalStore, StudentRecord } from "./types.js";

const PLAYBACK_TTL_SECONDS = 15 * 60;

function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(`store: ${res.error.message}`);
  return res.data as T;
}

const needsStudentEmailColumn = (error: { code?: string } | null) => error?.code === "PGRST204" || error?.code === "42703";
const studentMigrationError = () => new ApiError(503, "migration_required", "Student records need a database update first (migration 0002).");

const toAccount = (r: any): AccountRecord => ({
  id: r.id,
  userId: r.user_id,
  role: r.role,
  status: r.status,
  email: r.email,
  displayName: r.display_name,
  ghlContactId: r.ghl_contact_id,
});
const toStudent = (r: any): StudentRecord => ({
  id: r.id,
  firstName: r.first_name,
  fullName: r.full_name,
  styleLine: r.style_line,
  format: r.format,
  isMinor: r.is_minor,
  guardianName: r.guardian_name,
  email: r.email ?? null,
  guardianEmail: r.guardian_email,
  studentSince: r.student_since,
  ghlContactId: r.ghl_contact_id,
  billingContactId: r.billing_contact_id,
});
const toNote = (r: any): NoteDTO => ({
  id: r.id,
  studentId: r.student_id,
  lessonDate: r.lesson_date,
  title: r.title,
  summary: r.summary,
  technique: r.technique,
  practice: r.practice,
  goals: r.goals,
  prep: r.prep,
  status: r.status,
  publishedAt: r.published_at,
});
const toVideo = (r: any): VideoDTO => ({
  id: r.id,
  title: r.title,
  category: r.category,
  description: r.description,
  durationLabel: r.duration_label,
  source: r.source,
});
const toInvitation = (r: any): InvitationRecord => ({
  id: r.id,
  tokenHash: r.token_hash,
  method: r.method,
  email: r.email,
  name: r.name,
  role: r.role,
  studentIds: r.student_ids,
  status: r.status,
  expiresAt: r.expires_at,
  preview: r.preview,
});
const toAssignment = (r: any): PracticeAssignmentDTO => ({
  id: r.id,
  title: r.title,
  instructions: r.instructions,
  dueDate: r.due_date,
  videoId: r.video_id,
  videoTitle: r.videos?.title ?? null,
  lessonDate: r.lesson_date,
  students: (r.practice_assignment_students ?? []).map((s: any) => ({
    id: s.student_id,
    name: s.students?.full_name ?? "",
    completedAt: s.completed_at,
  })),
});
const ASSIGNMENT_SELECT = "*, videos(title), practice_assignment_students(student_id, completed_at, students(full_name))";

export function createSupabaseStore(url: string, serviceRoleKey: string, bucket: string): PortalStore {
  const db: SupabaseClient = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async getAccountByUser(userId) {
      const r = must(await db.from("accounts").select("*").eq("user_id", userId).maybeSingle());
      return r ? toAccount(r) : null;
    },
    async getAccount(id) {
      const r = must(await db.from("accounts").select("*").eq("id", id).maybeSingle());
      return r ? toAccount(r) : null;
    },
    async getLinks(accountId) {
      const rows = must(await db.from("account_students").select("*").eq("account_id", accountId)) as any[];
      return rows.map((r) => ({ studentId: r.student_id, canBook: r.can_book, canPay: r.can_pay }));
    },
    async getStudent(id) {
      const r = must(await db.from("students").select("*").eq("id", id).maybeSingle());
      return r ? toStudent(r) : null;
    },
    async getStudents(ids) {
      if (!ids.length) return [];
      return (must(await db.from("students").select("*").in("id", ids)) as any[]).map(toStudent);
    },
    async listStudents() {
      return (must(await db.from("students").select("*").order("full_name")) as any[]).map(toStudent);
    },
    async checkStudentSchema() {
      const { error } = await db.from("students").select("email").limit(1);
      if (needsStudentEmailColumn(error)) throw studentMigrationError();
      must({ data: [], error });
    },
    async createStudent(input) {
      const { data, error } = await db.from("students").insert({
        first_name: input.fullName.split(/\s+/)[0],
        full_name: input.fullName,
        is_minor: input.isMinor,
        email: input.email,
        guardian_name: input.guardianName,
        guardian_email: input.guardianEmail,
        format: input.format,
        ghl_contact_id: input.ghlContactId,
        billing_contact_id: input.billingContactId,
      }).select("*").single();
      if (error?.code === "23505") return null;
      // The email column comes from migration 0002.
      if (needsStudentEmailColumn(error)) throw studentMigrationError();
      return toStudent(must({ data, error }));
    },
    async studentCounts() {
      const [notes, videos, assignments] = await Promise.all([
        db.from("lesson_notes").select("student_id"),
        db.from("video_assignments").select("student_id"),
        db.from("practice_assignment_students").select("student_id"),
      ]);
      const out: Record<string, { notes: number; videos: number; assignments: number }> = {};
      const bump = (rows: any[], key: "notes" | "videos" | "assignments") => {
        for (const r of rows) (out[r.student_id] ??= { notes: 0, videos: 0, assignments: 0 })[key]++;
      };
      bump(must(notes) as any[], "notes");
      bump(must(videos) as any[], "videos");
      bump(must(assignments) as any[], "assignments");
      return out;
    },
    async studentAccounts() {
      const rows = must(await db.from("account_students").select("student_id, accounts(id, status)")) as any[];
      const out: Record<string, { accountId: string; status: "active" | "suspended" }> = {};
      for (const r of rows) if (r.accounts) out[r.student_id] = { accountId: r.accounts.id, status: r.accounts.status };
      return out;
    },
    async listNotes(studentId, { publishedOnly }) {
      let q = db.from("lesson_notes").select("*").eq("student_id", studentId).order("lesson_date", { ascending: false });
      if (publishedOnly) q = q.eq("status", "published");
      return (must(await q) as any[]).map(toNote);
    },
    async recentNotes(limit) {
      const rows = must(await db.from("lesson_notes").select("*, students(full_name)").order("updated_at", { ascending: false }).limit(limit)) as any[];
      return rows.map((r) => ({ ...toNote(r), studentName: r.students?.full_name ?? "" }));
    },
    async getNote(id) {
      const r = must(await db.from("lesson_notes").select("*").eq("id", id).maybeSingle());
      return r ? toNote(r) : null;
    },
    async saveNote(id, input, authorAccountId) {
      const row = {
        student_id: input.studentId,
        lesson_date: input.lessonDate,
        title: input.title,
        summary: input.summary,
        technique: input.technique,
        practice: input.practice,
        goals: input.goals,
        prep: input.prep,
        author_account_id: authorAccountId,
        updated_at: new Date().toISOString(),
      };
      const res = id
        ? await db.from("lesson_notes").update(row).eq("id", id).select().single()
        : await db.from("lesson_notes").insert(row).select().single();
      return toNote(must(res));
    },
    async publishNote(id) {
      const now = new Date().toISOString();
      return toNote(must(await db.from("lesson_notes").update({ status: "published", published_at: now, updated_at: now }).eq("id", id).select().single()));
    },
    async listVideos() {
      const rows = must(await db.from("videos").select("*, video_assignments(count)").order("created_at", { ascending: false })) as any[];
      return rows.map((r) => ({ ...toVideo(r), assignedCount: r.video_assignments?.[0]?.count ?? 0 }));
    },
    async getVideo(id) {
      const r: any = must(await db.from("videos").select("*").eq("id", id).maybeSingle());
      return r ? { ...toVideo(r), externalUrl: r.external_url, storagePath: r.storage_path } : null;
    },
    async saveVideo(id, input) {
      const row = {
        title: input.title,
        category: input.category,
        description: input.description,
        source: input.source,
        ...(input.externalUrl !== undefined ? { external_url: input.externalUrl } : {}),
        ...(input.storagePath !== undefined ? { storage_path: input.storagePath } : {}),
      };
      const res = id ? await db.from("videos").update(row).eq("id", id).select().single() : await db.from("videos").insert(row).select().single();
      return toVideo(must(res));
    },
    async listAssignedVideos(studentId) {
      const rows = must(await db.from("video_assignments").select("*, videos(*)").eq("student_id", studentId).order("assigned_at", { ascending: false })) as any[];
      return rows.map((r): AssignedVideoDTO => ({ ...toVideo(r.videos), assignmentId: r.id, assignedAt: r.assigned_at, watchedAt: r.watched_at }));
    },
    async recentAssignedVideos(limit) {
      const rows = must(await db.from("video_assignments").select("assigned_at, videos(title), students(first_name)").order("assigned_at", { ascending: false }).limit(limit)) as any[];
      return rows.map((r) => ({ title: r.videos?.title ?? "", to: r.students?.first_name ?? "", assignedAt: r.assigned_at }));
    },
    async videoAssignees(videoId) {
      return (must(await db.from("video_assignments").select("student_id").eq("video_id", videoId)) as any[]).map((r) => r.student_id);
    },
    async setVideoAssignees(videoId, studentIds) {
      const current = new Set((must(await db.from("video_assignments").select("student_id").eq("video_id", videoId)) as any[]).map((r) => r.student_id as string));
      const add = studentIds.filter((s) => !current.has(s));
      const remove = [...current].filter((s) => !studentIds.includes(s));
      if (add.length) must(await db.from("video_assignments").insert(add.map((student_id) => ({ video_id: videoId, student_id }))));
      if (remove.length) must(await db.from("video_assignments").delete().eq("video_id", videoId).in("student_id", remove));
    },
    async isVideoAssignedToAny(videoId, studentIds) {
      if (!studentIds.length) return false;
      const rows = must(await db.from("video_assignments").select("id").eq("video_id", videoId).in("student_id", studentIds).limit(1)) as any[];
      return rows.length > 0;
    },
    async markVideoWatched(videoId, studentId) {
      must(await db.from("video_assignments").update({ watched_at: new Date().toISOString() }).eq("video_id", videoId).eq("student_id", studentId).is("watched_at", null));
    },
    async signedPlaybackUrl(path) {
      const res = must(await db.storage.from(bucket).createSignedUrl(path, PLAYBACK_TTL_SECONDS));
      return (res as any).signedUrl;
    },
    async signedUploadUrl(path) {
      const res = must(await db.storage.from(bucket).createSignedUploadUrl(path));
      return (res as any).signedUrl;
    },
    async listAssignments(studentId) {
      const rows = must(await db.from("practice_assignments").select(ASSIGNMENT_SELECT).order("created_at", { ascending: false })) as any[];
      const all = rows.map(toAssignment);
      if (!studentId) return all;
      // A family sees its own student only, not who else got the same assignment.
      return all
        .filter((a) => a.students.some((s) => s.id === studentId))
        .map((a) => ({ ...a, students: a.students.filter((s) => s.id === studentId) }));
    },
    async createAssignment(input) {
      const row: any = must(
        await db.from("practice_assignments").insert({
          title: input.title,
          instructions: input.instructions,
          due_date: input.dueDate,
          video_id: input.videoId,
          lesson_date: input.lessonDate,
        }).select().single(),
      );
      must(await db.from("practice_assignment_students").insert(input.studentIds.map((student_id) => ({ assignment_id: row.id, student_id }))));
      return toAssignment(must(await db.from("practice_assignments").select(ASSIGNMENT_SELECT).eq("id", row.id).single()));
    },
    async setAssignmentComplete(assignmentId, studentId, done) {
      must(await db.from("practice_assignment_students").update({ completed_at: done ? new Date().toISOString() : null }).eq("assignment_id", assignmentId).eq("student_id", studentId));
    },
    async listInvitations() {
      const rows = must(await db.from("invitations").select("*").order("sent_at", { ascending: false })) as any[];
      return rows.map((r): InvitationDTO => {
        const expired = r.status === "pending" && new Date(r.expires_at).getTime() < Date.now();
        return {
          id: r.id,
          name: r.name,
          email: r.email,
          studentName: r.preview?.studentLine ?? "—",
          status: expired ? "expired" : r.status === "pending" ? (r.method === "code" ? "code_issued" : "pending") : r.status,
          method: r.method,
          sentAt: r.sent_at,
          expiresAt: r.expires_at,
          accountId: null,
        };
      });
    },
    async createInvitation(input) {
      return toInvitation(must(await db.from("invitations").insert({
        token_hash: input.tokenHash,
        method: input.method,
        email: input.email,
        name: input.name,
        role: input.role,
        student_ids: input.studentIds,
        expires_at: input.expiresAt,
        preview: input.preview,
      }).select().single()));
    },
    async findInvitationByHash(hash) {
      const r = must(await db.from("invitations").select("*").eq("token_hash", hash).maybeSingle());
      return r ? toInvitation(r) : null;
    },
    async findPendingInvitationByEmail(email) {
      const rows = must(await db.from("invitations").select("*").eq("email", email.toLowerCase()).eq("status", "pending").order("sent_at", { ascending: false }).limit(1)) as any[];
      return rows[0] ? toInvitation(rows[0]) : null;
    },
    async claimInvitation(id) {
      const rows = must(await db.from("invitations").update({ status: "accepted" }).eq("id", id).eq("status", "pending").gt("expires_at", new Date().toISOString()).select("id")) as any[];
      return rows.length === 1;
    },
    async releaseInvitation(id) {
      must(await db.from("invitations").update({ status: "pending" }).eq("id", id));
    },
    async getInvitation(id) {
      const r = must(await db.from("invitations").select("*").eq("id", id).maybeSingle());
      return r ? toInvitation(r) : null;
    },
    async revokeInvitation(id) {
      must(await db.from("invitations").update({ status: "revoked" }).eq("id", id));
    },
    async revokePendingForEmail(email, exceptId) {
      let q = db.from("invitations").update({ status: "revoked" }).eq("email", email.toLowerCase()).eq("status", "pending");
      if (exceptId) q = q.neq("id", exceptId);
      must(await q);
    },
    async deleteStudent(id) {
      must(await db.from("students").delete().eq("id", id));
    },
    async attachInvitationAuthUser(id, authUserId) {
      const row = must(await db.from("invitations").select("preview").eq("id", id).single()) as { preview: Record<string, unknown> };
      must(await db.from("invitations").update({ preview: { ...row.preview, authUserId } }).eq("id", id));
    },
    async createAccountForInvitation(invite, userId) {
      const acct: any = must(await db.from("accounts").insert({ user_id: userId, role: invite.role, email: invite.email, display_name: invite.name }).select().single());
      must(await db.from("account_students").insert(invite.studentIds.map((student_id) => ({ account_id: acct.id, student_id }))));
    },
    async setAccountStatus(accountId, status) {
      return toAccount(must(await db.from("accounts").update({ status }).eq("id", accountId).select().single()));
    },
    async listAudit(action) {
      const rows = must(await db.from("audit_log").select("target, meta").eq("action", action).order("created_at", { ascending: true })) as { target: string; meta: Record<string, unknown> | null }[];
      return rows.map((row) => ({ target: row.target, meta: row.meta ?? {} }));
    },
    async lastInvoiceLinkSentAt(invoiceId) {
      const rows = must(await db.from("audit_log").select("created_at").eq("action", "invoice.link_sent").eq("target", invoiceId).order("created_at", { ascending: false }).limit(1)) as any[];
      return rows[0]?.created_at ?? null;
    },
    async audit(actor, action, target, meta = {}) {
      must(await db.from("audit_log").insert({ actor_account_id: actor, action, target, meta }));
    },
  };
}

const isExistingLogin = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === "email_exists" || error.code === "user_already_exists" || /already (been )?registered/i.test(error.message ?? ""));

/** GoTrue refuses to create a login for an OTP: sign-ups are off (signup_disabled) or shouldCreateUser was false (otp_disabled). */
const isSignupRefused = (error: { status?: number; code?: string; message?: string } | null) =>
  !!error && (error.code === "signup_disabled" || error.code === "otp_disabled" || /signups? not allowed/i.test(error.message ?? ""));

async function setLoginPassword(admin: SupabaseClient, userId: string, password: string) {
  const { data, error } = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
  if (error || !data.user) throw new Error("auth: could not create user");
  return data.user.id;
}

async function findUserIdByEmail(url: string, serviceRoleKey: string, email: string) {
  let res: Response;
  try {
    res = await fetch(`${url}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as { users?: { id?: string; email?: string }[] } | null;
  const match = (body?.users ?? []).find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());
  return match?.id ?? null;
}

export function createSupabaseAuthAdmin(url: string, serviceRoleKey: string, appUrl: string): AuthAdmin {
  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async verifyToken(token) {
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data.user) return null;
      // getUser proved the token is genuine, so its claims can be read for the assurance level.
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      return {
        userId: data.user.id,
        email: data.user.email ?? "",
        aal: claims.aal ?? "aal1",
        mfaEnrolled: (data.user.factors ?? []).some((f) => f.status === "verified"),
      };
    },
    async createUser(email, password, existingUserId) {
      if (existingUserId) return setLoginPassword(admin, existingUserId, password);
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (!error && data.user) return data.user.id;
      if (!isExistingLogin(error)) throw new Error("auth: could not create user");
      const id = await findUserIdByEmail(url, serviceRoleKey, email);
      if (!id) throw new Error("auth: could not create user");
      return setLoginPassword(admin, id, password);
    },
    async sendPortalInvite(email, redirectTo) {
      // Public sign-ups are off, so signInWithOtp may not create the login itself (422 signup_disabled).
      // The service role creates it first, or reuses the existing one. The address is only trusted once the
      // emailed code is verified, and a login with no accounts row still gets 403.
      const created = await admin.auth.admin.createUser({ email, email_confirm: true });
      if (created.error && !isExistingLogin(created.error)) throw new Error("auth: could not create login");
      // The Magic Link template's {{ .Token }} is this code. verifyEmailOtp checks it with type "email".
      const { error } = await admin.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
      });
      const wait = inviteRateLimitSeconds(error);
      if (wait !== null) throw new ApiError(429, "invite_rate_limited", `Please wait ${wait} seconds before resending.`);
      if (isSignupRefused(error)) {
        throw new ApiError(503, "invite_signup_disabled", "Supabase has no login for this email and wouldn't create one. Check the server's Supabase service-role key, then try again.");
      }
      if (error) throw new Error("auth: could not send invitation");
      return null;
    },
    async verifyEmailOtp(email, code) {
      const { data, error } = await admin.auth.verifyOtp({ email, token: code, type: "email" });
      if (error || !data.session || !data.user) return null;
      return { userId: data.user.id, accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
    },
    async deleteUser(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error("auth: could not remove user");
    },
    async sendPasswordReset(email) {
      const { error } = await admin.auth.resetPasswordForEmail(email, { redirectTo: `${appUrl}/reset-password` });
      if (error) throw new Error("auth: could not send reset");
    },
    async setBanned(userId, banned) {
      const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: banned ? "876000h" : "none" });
      if (error) throw new Error("auth: could not update access");
    },
  };
}
