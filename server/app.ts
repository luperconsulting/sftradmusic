import { parseNewStudent, createStudent, enrollInvitedStudent } from "./services/students.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OUTSTANDING_BALANCE_MESSAGE, type DashboardResponse, type InvitationPreview, type MePending, type MeResponse, type TeacherStudentRow } from "../shared/portal-types.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { ApiError, errorHandler, forbidden, notConfigured, notFound, parse, uuid, wrap } from "./http.js";
import { memoryRateLimiter, type RateLimiter } from "./rateLimit.js";
import { assertCanViewStudent, assertSessionAllowed, assertTeacher, canBookFor, canPayFor, type Actor } from "./auth/policy.js";
import { createCardSetup } from "./integrations/stripeSetup.js";
import { createInvoice, getStudentBilling, isOutstanding, newInvoiceSchema, paymentSchema, recordPayment, setInvoiceState, toInvoiceDTO } from "./services/billing.js";
import { cancelLesson, createTeacherLesson, LOCATIONS, rescheduleTeacherLesson, splitLessons, teacherLessonSchema, toLessonDTO } from "./services/lessons.js";
import { applyReferralCode, autopayEnabledFor, PACKAGE_PURCHASE, purchaseLessonPackage, referralCodeFor, saveAutopayPreference, sendReferral, AUTOPAY_SAVE, assertPreviewSafe } from "./services/previewFeatures.js";
import { packageLessonsFor } from "../shared/lesson-packages.js";
import { isEmailOtp } from "../shared/email-otp.js";
import { assertPortalInviteEmail, hashCredential, INVITE_CODE_TTL_MS, INVITE_TTL_MS, inviteeFullName, newEnrollmentCode, newInviteToken, portalInvitePage } from "./services/invitations.js";
import { createSupabaseAuthAdmin, createSupabaseStore } from "./store/supabaseStore.js";
import type { AuthAdmin, PortalStore, StudentRecord } from "./store/types.js";

export interface Deps {
  config: ServerConfig;
  store: PortalStore | null;
  auth: AuthAdmin | null;
  limiter: RateLimiter;
}

export function defaultDeps(): Deps {
  const config = loadConfig();
  return {
    config,
    store: config.supabase ? createSupabaseStore(config.supabase.url, config.supabase.serviceRoleKey, config.videoBucket) : null,
    auth: config.supabase ? createSupabaseAuthAdmin(config.supabase.url, config.supabase.serviceRoleKey, config.appUrl) : null,
    limiter: memoryRateLimiter(),
  };
}

type AuthedRequest = Request & { actor: Actor };
const CATEGORIES = ["Technique", "Repertoire", "Practice Exercises", "Music Theory", "Additional Resources"] as const;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const shortText = z.string().trim().max(300);
const longText = z.string().trim().max(20000);
const password = z.string().min(12).max(200);

const noteSchema = z.object({
  studentId: uuid,
  lessonDate: dateOnly,
  title: shortText,
  summary: longText,
  technique: longText,
  practice: longText,
  goals: longText,
  prep: longText,
});
const videoSchema = z.object({ title: z.string().trim().min(1).max(200), category: z.enum(CATEGORIES), description: shortText.default("") });
// External videos are limited to providers the site's CSP allows to be framed.
const videoUrlSchema = z.string().url().refine((u) => {
  const url = new URL(u);
  return url.protocol === "https:" && /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(url.hostname);
}, "unsupported");
const assignmentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  instructions: longText,
  dueDate: dateOnly.nullable(),
  videoId: uuid.nullable(),
  lessonDate: dateOnly.nullable(),
  studentIds: z.array(uuid).min(1).max(100),
});
// Self-booking needs an availability source. Until that lives in Supabase, the teacher books lessons.
const bookingUnavailable = () =>
  new ApiError(503, "booking_unavailable", "Online booking isn't available yet. Please contact Zane to schedule or move a lesson.");
const portalBookingSchema = z.object({
  studentId: uuid,
  startTime: z.string().datetime({ offset: true }),
  location: z.enum(["Music City SF", "Zoom"]),
  repeatWeekly: z.boolean().optional(),
});

const inviteSchema = z.object({
  method: z.enum(["email", "code"]).optional(),
  role: z.enum(["guardian", "student"]).optional(),
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().max(120).optional(),
  studentIds: z.array(uuid).max(10).optional(),
});

export function createApp(deps: Deps) {
  const { config, limiter } = deps;
  const app = express();
  app.disable("x-powered-by");

  const needStore = () => {
    if (!deps.store || !deps.auth) throw notConfigured("Sign-in");
    return { store: deps.store, auth: deps.auth };
  };
  const clientKey = (req: Request) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();

  app.use(express.json({ limit: "256kb" }));

  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    // Sessions travel in the Authorization header, not cookies, so classic CSRF doesn't apply. Rejecting
    // other origins on writes is an extra layer.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.header("origin");
      if (origin) {
        // Compared by host because the proxy in front of the app ends TLS
        let host = "";
        try { host = new URL(origin).host; } catch { /* a malformed Origin is rejected below */ }
        if (host !== new URL(config.appUrl).host && host !== req.get("host")) {
          next(forbidden("Cross-origin requests aren't allowed."));
          return;
        }
      }
    }
    next();
  });

  const authenticate = (allowAal1 = false) => async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const { store, auth } = needStore();
      const header = req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      const session = token ? await auth.verifyToken(token) : null;
      if (!session) throw new ApiError(401, "unauthenticated", "Please sign in.");
      const account = await store.getAccountByUser(session.userId);
      if (!account) throw new ApiError(403, "no_account", "No portal account is linked to this sign-in.");
      const actor: Actor = {
        userId: session.userId,
        accountId: account.id,
        email: session.email,
        role: account.role,
        status: account.status,
        aal: session.aal,
        mfaEnrolled: session.mfaEnrolled,
        links: account.role === "teacher" ? [] : await store.getLinks(account.id),
      };
      if (allowAal1) {
        if (actor.status !== "active") assertSessionAllowed(actor);
      } else {
        assertSessionAllowed(actor);
      }
      (req as AuthedRequest).actor = actor;
      next();
    } catch (e) {
      next(e);
    }
  };
  const requireTeacher = (req: Request, _res: Response, next: NextFunction) => {
    try {
      assertTeacher((req as AuthedRequest).actor);
      next();
    } catch (e) {
      next(e);
    }
  };
  const actorOf = (req: Request) => (req as AuthedRequest).actor;
  const audit = (req: Request, action: string, target: string, meta?: Record<string, unknown>) =>
    needStore().store.audit(actorOf(req).accountId, action, target, meta);
  /** A teacher owns a student when it is assigned to them, or to nobody yet. */
  const ownsStudent = (actor: Actor, s: StudentRecord) => actor.role === "teacher" && (!s.teacherAccountId || s.teacherAccountId === actor.accountId);
  const loadStudent = async (req: Request, studentId: string): Promise<StudentRecord> => {
    const actor = actorOf(req);
    assertCanViewStudent(actor, studentId);
    const student = await needStore().store.getStudent(studentId);
    // Same 403 as a missing link, so another teacher's student IDs can't be probed.
    if (student && actor.role === "teacher" && !ownsStudent(actor, student)) throw forbidden();
    if (!student) throw notFound();
    return student;
  };
  const teacherStudents = async (req: Request) => (await needStore().store.listStudents()).filter((s) => ownsStudent(actorOf(req), s));

  app.get("/api/health", (_req, res) => {
    res.json({ supabase: !!deps.store });
  });

  // ---- public: invitation-only account creation -------------------------------------------------------------
  const findLiveInvite = async (credential: string) => {
    const invite = await needStore().store.findInvitationByHash(hashCredential(credential));
    if (!invite || invite.status !== "pending") throw new ApiError(404, "invalid_invitation", "That code isn't valid or has already been used.");
    if (new Date(invite.expiresAt).getTime() < Date.now()) throw new ApiError(410, "invitation_expired", "This invitation has expired.");
    return invite;
  };

  app.post("/api/invitations/verify", wrap(async (req) => {
    limiter.hit(`invite-verify:${clientKey(req)}`, 10, 15 * 60000);
    const { credential } = parse(z.object({ credential: z.string().trim().min(8).max(200) }), req.body);
    const invite = await findLiveInvite(credential);
    // Listed field by field so a server-only auth user id stored on the row never reaches the browser.
    const preview: InvitationPreview = {
      firstName: invite.preview.firstName,
      studentLine: invite.preview.studentLine,
      accountFor: invite.preview.accountFor,
      lessons: invite.preview.lessons,
      format: invite.preview.format,
      email: invite.email,
      expiresAt: invite.expiresAt,
    };
    return preview;
  }));

  const completeInvitation = async (invite: Awaited<ReturnType<typeof findLiveInvite>>, opts: { userId?: string; password?: string }) => {
    const { store, auth } = needStore();
    if (!(await store.claimInvitation(invite.id))) throw new ApiError(404, "invalid_invitation", "That code isn't valid or has already been used.");
    let userId: string | null = opts.userId ?? null;
    let createdStudentId: string | null = null;
    try {
      let studentIds = invite.studentIds;
      // The student row does not exist until the code is confirmed. It is created in Supabase only.
      if (studentIds.length === 0) {
        const enrolled = await enrollInvitedStudent(store, {
          fullName: inviteeFullName(invite.name, invite.email),
          email: invite.email,
          teacherAccountId: await store.studioTeacherAccountId(),
        });
        createdStudentId = enrolled.student.id;
        studentIds = [enrolled.student.id];
      }
      if (!userId) userId = await auth.createUser(invite.email, opts.password ?? "", invite.preview.authUserId);
      await store.createAccountForInvitation({ ...invite, studentIds }, userId);
    } catch (e) {
      // A login this request created is removed. An OTP login is left, so a resent code can try again.
      if (userId && !opts.userId) await auth.deleteUser(userId).catch(() => console.error("[api] could not remove partial user"));
      if (createdStudentId) {
        await store.deleteStudent(createdStudentId).catch(() => console.error("[api] could not remove the student created for this invite"));
      }
      await store.releaseInvitation(invite.id);
      throw e;
    }
  };

  app.post("/api/invitations/redeem", wrap(async (req) => {
    limiter.hit(`invite-redeem:${clientKey(req)}`, 10, 15 * 60000);
    const { credential, password: pw } = parse(z.object({ credential: z.string().trim().min(8).max(200), password }), req.body);
    const { store } = needStore();
    const invite = await findLiveInvite(credential);
    await completeInvitation(invite, { password: pw });
    await store.audit(null, "invitation.redeemed", invite.id);
    return { email: invite.email };
  }));

  app.post("/api/invitations/verify-code", wrap(async (req) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email().max(200), code: z.string().trim() }), req.body);
    limiter.hit(`invite-code:${clientKey(req)}:${body.email}`, 8, 15 * 60000);
    if (!isEmailOtp(body.code)) throw new ApiError(400, "invalid_code", "Enter the code from the email.");
    const { store, auth } = needStore();
    const invite = await store.findPendingInvitationByEmail(body.email);
    if (!invite) throw new ApiError(404, "invalid_invitation", "That code isn't valid or has already been used.");
    if (new Date(invite.expiresAt).getTime() < Date.now()) throw new ApiError(410, "invitation_expired", "This code has expired. Ask Zane to send a new one.");
    const session = await auth.verifyEmailOtp(body.email, body.code);
    if (!session) throw new ApiError(401, "invalid_code", "That code isn't valid or has expired.");
    await completeInvitation(invite, { userId: session.userId });
    await store.audit(null, "invitation.redeemed", invite.id);
    return { accessToken: session.accessToken, refreshToken: session.refreshToken, email: invite.email };
  }));

  // ---- signed-in, any role ---------------------------------------------------------------------------------
  // The one route open to a password-only (AAL1) session, so the client can send it to the 2FA screen.
  // Until 2FA passes it returns only the role and factor status; every data route still requires AAL2.
  app.get("/api/me", authenticate(true), wrap(async (req) => {
    const actor = actorOf(req);
    if (actor.aal !== "aal2" || !actor.mfaEnrolled) {
      const pending: MePending = { mfaRequired: true, user: { role: actor.role, mfaEnabled: actor.mfaEnrolled, aal: actor.aal } };
      return pending;
    }
    const { store } = needStore();
    const account = (await store.getAccount(actor.accountId))!;
    const students = await store.getStudents(actor.links.map((l) => l.studentId));
    const parts = account.displayName.split(/\s+/).filter(Boolean);
    const initials = parts.map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    const last = parts[parts.length - 1] ?? "";
    const body: MeResponse = {
      user: { id: actor.userId, email: actor.email, role: actor.role, displayName: account.displayName, mfaEnabled: actor.mfaEnrolled, aal: actor.aal },
      account: {
        label: actor.role === "guardian" ? `The ${last} Family` : account.displayName,
        ownerFirst: parts[0] ?? "",
        ownerFull: account.displayName,
        email: account.email,
        initials,
        isFamily: actor.role === "guardian" || students.length > 1,
      },
      features: config.features,
    };
    return body;
  }));

  // ---- student / family ------------------------------------------------------------------------------------
  app.get("/api/portal/dashboard", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    const { store } = needStore();
    const requested = req.query.studentId ? parse(uuid, req.query.studentId) : null;
    const isTeacher = actor.role === "teacher";
    if (isTeacher && !requested) throw new ApiError(400, "invalid_input", "Choose a student to preview.");
    const students = isTeacher ? [await loadStudent(req, requested!)] : await store.getStudents(actor.links.map((l) => l.studentId));
    const student = requested ? await loadStudent(req, requested) : students[0] ?? null;
    const empty: DashboardResponse = {
      students: students.map(publicStudent),
      student: null,
      upcoming: [],
      history: [],
      notes: [],
      videos: [],
      assignments: [],
      billing: null,
      packageLessons: 0,
      autopayEnabled: false,
      lessonsAvailable: false,
      canBook: false,
      canPay: false,
      readOnly: isTeacher,
    };
    if (!student) return empty;
    if (isTeacher) await audit(req, "teacher.preview_student", student.id);
    const [notes, videos, assignments, purchases, autopayRows] = await Promise.all([
      store.listNotes(student.id, { publishedOnly: true }),
      store.listAssignedVideos(student.id),
      store.listAssignments(student.id),
      store.listAudit(PACKAGE_PURCHASE),
      store.listAudit(AUTOPAY_SAVE),
    ]);
    let upcoming: DashboardResponse["upcoming"] = [];
    let history: DashboardResponse["history"] = [];
    let billing: DashboardResponse["billing"] = null;
    let lessonsAvailable = false;
    // One failed read mustn't take notes and videos down with it. A null section shows as "unavailable".
    await Promise.all([
      store.listLessons({ studentIds: [student.id] }).then((lessons) => {
        ({ upcoming, history } = splitLessons(lessons));
        lessonsAvailable = true;
      }).catch((e) => console.error("[api] lessons unavailable", e instanceof Error ? e.message : "")),
      getStudentBilling(store, student.id).then((b) => { billing = b; }).catch((e) => console.error("[api] billing unavailable", e instanceof Error ? e.message : "")),
    ]);
    const body: DashboardResponse = {
      ...empty,
      student: publicStudent(student),
      upcoming,
      history,
      notes,
      videos,
      assignments,
      packageLessons: packageLessonsFor(purchases, student.id),
      autopayEnabled: autopayEnabledFor(autopayRows, student.id),
      // Invoices can include siblings and the payer's details, so only payers and the teacher receive them.
      billing: isTeacher || canPayFor(actor, student.id) ? billing : null,
      lessonsAvailable,
      canBook: canBookFor(actor, student.id),
      canPay: canPayFor(actor, student.id),
    };
    return body;
  }));

  app.get("/api/lessons/slots", authenticate(), wrap(async (req) => {
    const q = parse(z.object({ studentId: uuid, from: dateOnly, to: dateOnly }), req.query);
    await loadStudent(req, q.studentId);
    throw bookingUnavailable();
  }));

  app.post("/api/lessons", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    limiter.hit(`book:${actor.accountId}`, 20, 60 * 60000);
    const input = parse(portalBookingSchema, req.body);
    await loadStudent(req, input.studentId);
    if (!canBookFor(actor, input.studentId)) throw forbidden("This account can't book lessons for this student.");
    // The balance gate still runs first, from Supabase, so an unpaid family sees the right reason.
    const billing = await getStudentBilling(needStore().store, input.studentId);
    if (billing.bookingBlocked) throw new ApiError(402, "outstanding_balance", OUTSTANDING_BALANCE_MESSAGE);
    throw bookingUnavailable();
  }));

  app.post("/api/lessons/:lessonId/reschedule", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    limiter.hit(`book:${actor.accountId}`, 20, 60 * 60000);
    const input = parse(portalBookingSchema, req.body);
    await loadStudent(req, input.studentId);
    if (!canBookFor(actor, input.studentId)) throw forbidden("This account can't change lessons for this student.");
    throw bookingUnavailable();
  }));

  // The portal takes no payments yet. Invoices are paid outside it and the teacher records the payment.
  app.post("/api/invoices/:invoiceId/send-payment-link", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    limiter.hit(`pay:${actor.accountId}`, 5, 15 * 60000);
    const invoiceId = parse(uuid, req.params.invoiceId);
    const invoice = await needStore().store.getInvoice(invoiceId);
    if (!invoice || !canPayFor(actor, invoice.studentId)) throw forbidden();
    if (!isOutstanding(toInvoiceDTO(invoice))) throw new ApiError(409, "invoice_not_payable", "This invoice has nothing left to pay.");
    throw new ApiError(503, "payment_link_unavailable", "Paying from the portal isn't available yet. Please pay Zane directly; your balance updates once the payment is recorded.");
  }));

  app.get("/api/videos/:id/playback", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    const id = parse(uuid, req.params.id);
    const { store } = needStore();
    if (actor.role !== "teacher" && !(await store.isVideoAssignedToAny(id, actor.links.map((l) => l.studentId)))) throw forbidden();
    const video = await store.getVideo(id);
    if (!video) throw notFound();
    if (video.storagePath) return { kind: "file", url: await store.signedPlaybackUrl(video.storagePath) };
    if (video.externalUrl) return { kind: "external", url: video.externalUrl };
    throw notFound();
  }));

  app.post("/api/videos/:id/watched", authenticate(), wrap(async (req) => {
    const id = parse(uuid, req.params.id);
    const { studentId } = parse(z.object({ studentId: uuid }), req.body);
    if (actorOf(req).role === "teacher") return { ok: true }; // a teacher preview must not mark anything watched
    await loadStudent(req, studentId);
    await needStore().store.markVideoWatched(id, studentId);
    return { ok: true };
  }));

  app.post("/api/assignments/:id/complete", authenticate(), wrap(async (req) => {
    const id = parse(uuid, req.params.id);
    const { studentId, done } = parse(z.object({ studentId: uuid, done: z.boolean() }), req.body);
    if (actorOf(req).role === "teacher") return { ok: true }; // a teacher preview must not change a student's record
    await loadStudent(req, studentId);
    await needStore().store.setAssignmentComplete(id, studentId, done);
    return { ok: true };
  }));

  app.post("/api/packages/purchase", authenticate(), wrap(async (req) => {
    assertPreviewSafe(config.features.packages, config.safeMode);
    const actor = actorOf(req);
    const input = parse(z.object({ studentId: uuid, packageId: z.string().trim().min(1).max(80) }), req.body);
    if (actor.role !== "teacher" && !canPayFor(actor, input.studentId)) throw forbidden();
    await loadStudent(req, input.studentId);
    return purchaseLessonPackage(needStore().store, { actorAccountId: actor.accountId, studentId: input.studentId, packageId: input.packageId, enabled: true, safeMode: true });
  }));

  app.post("/api/autopay", authenticate(), wrap(async (req) => {
    assertPreviewSafe(config.features.autopay, config.safeMode);
    const actor = actorOf(req);
    const input = parse(z.object({ studentId: uuid, enabled: z.boolean() }), req.body);
    if (actor.role !== "teacher" && !canPayFor(actor, input.studentId)) throw forbidden();
    await loadStudent(req, input.studentId);
    const saved = await saveAutopayPreference(needStore().store, { actorAccountId: actor.accountId, studentId: input.studentId, enabled: input.enabled, safeMode: true, featureOn: true });
    if (!input.enabled) return { ...saved, charged: false as const, cardSaving: !!config.stripe, checkoutUrl: null };
    const setup = await createCardSetup({ keys: config.stripe, safeMode: true, studentId: input.studentId, appUrl: config.appUrl });
    return { ...saved, charged: false as const, cardSaving: setup.available, checkoutUrl: setup.url, setupIntentId: setup.setupIntentId };
  }));

  app.get("/api/referrals", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    const studentId = parse(uuid, req.query.studentId);
    await loadStudent(req, studentId);
    const invites = (await needStore().store.listAudit("referral.invite")).filter((row) => row.target === studentId);
    return { code: referralCodeFor(studentId), invites: invites.map((row) => ({ email: String(row.meta.email ?? ""), allowlisted: row.meta.allowlisted === true })) };
  }));

  app.post("/api/referrals/invite", authenticate(), wrap(async (req) => {
    assertPreviewSafe(config.features.referrals, config.safeMode);
    const actor = actorOf(req);
    const input = parse(z.object({ email: z.string().trim().toLowerCase().email().max(200), studentId: uuid.optional() }), req.body);
    const studentId = input.studentId ?? null;
    if (actor.role !== "teacher") {
      if (!studentId) throw new ApiError(400, "invalid_input", "Choose a student for this referral.");
      await loadStudent(req, studentId);
    } else if (studentId) {
      await loadStudent(req, studentId);
    }
    return sendReferral(needStore().store, {
      actorAccountId: actor.accountId,
      email: input.email,
      studentId,
      enabled: true,
      safeMode: true,
      allowlist: config.safeModeEmailAllowlist,
      appUrl: config.appUrl,
      smtp: config.smtp,
    });
  }));

  app.post("/api/referrals/apply", authenticate(), wrap(async (req) => {
    assertPreviewSafe(config.features.referrals, config.safeMode);
    const actor = actorOf(req);
    const input = parse(z.object({ studentId: uuid, code: z.string().trim().min(4).max(40) }), req.body);
    await loadStudent(req, input.studentId);
    return applyReferralCode(needStore().store, { actorAccountId: actor.accountId, studentId: input.studentId, code: input.code, enabled: true, safeMode: true });
  }));

  // ---- teacher ---------------------------------------------------------------------------------------------
  const teacher = express.Router();
  teacher.use(authenticate(), requireTeacher);

  teacher.get("/students", wrap(async (req) => {
    const { store } = needStore();
    const now = Date.now();
    const students = await teacherStudents(req);
    const [counts, accounts, purchases, lessons] = await Promise.all([
      store.studentCounts(),
      store.studentAccounts(),
      store.listAudit(PACKAGE_PURCHASE),
      store.listLessons({ studentIds: students.map((s) => s.id), from: new Date(now).toISOString() }),
    ]);
    const nextByStudent: Record<string, string> = {};
    for (const l of lessons) if (l.status === "scheduled") nextByStudent[l.studentId] ??= new Date(l.startsAt).toISOString();
    const rows: TeacherStudentRow[] = students.map((s) => ({
      ...publicStudent(s),
      email: s.email,
      nextLesson: nextByStudent[s.id] ?? null,
      noteCount: counts[s.id]?.notes ?? 0,
      videoCount: counts[s.id]?.videos ?? 0,
      assignmentCount: counts[s.id]?.assignments ?? 0,
      packageLessons: packageLessonsFor(purchases, s.id),
      accountId: accounts[s.id]?.accountId ?? null,
      portalStatus: accounts[s.id]?.status ?? "none",
      transferPending: false,
    }));
    return { students: rows };
  }));

  teacher.post("/students", wrap(async (req) => {
    const input = parseNewStudent(req.body);
    const { store } = needStore();
    const { student, guardian } = await createStudent(store, input, actorOf(req).accountId);
    await audit(req, "student.create", student.id, { guardian });
    return { student: { id: student.id, fullName: student.fullName }, guardian };
  }));
  teacher.get("/students/:id", wrap(async (req) => {
    const student = await loadStudent(req, parse(uuid, req.params.id));
    const { store } = needStore();
    const [notes, videos, assignments, purchases] = await Promise.all([
      store.listNotes(student.id, { publishedOnly: false }),
      store.listAssignedVideos(student.id),
      store.listAssignments(student.id),
      store.listAudit(PACKAGE_PURCHASE),
    ]);
    const [lessons, billing] = await Promise.all([
      store.listLessons({ studentIds: [student.id] }).then((rows) => rows.map(toLessonDTO)).catch(() => null),
      getStudentBilling(store, student.id).catch(() => null),
    ]);
    return { student: publicStudent(student), notes, videos, assignments, lessons, billing, packageLessons: packageLessonsFor(purchases, student.id) };
  }));

  teacher.get("/overview", wrap(async (req) => {
    const { store } = needStore();
    const [students, recentNotes, recentVideos, invitations] = await Promise.all([teacherStudents(req), store.recentNotes(3), store.recentAssignedVideos(3), store.listInvitations()]);
    return { studentCount: students.length, adultCount: students.filter((s) => !s.isMinor).length, recentNotes, recentVideos, invitations };
  }));

  teacher.get("/calendar", wrap(async (req) => {
    const q = parse(z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }), req.query);
    if (q.to <= q.from || q.to - q.from > 31 * 86400000) throw new ApiError(400, "invalid_input", "That date range isn't valid.");
    const students = await teacherStudents(req);
    const byId = new Map(students.map((s) => [s.id, s]));
    const lessons = await needStore().store.listLessons({ studentIds: [...byId.keys()], from: new Date(q.from).toISOString(), to: new Date(q.to).toISOString() });
    return {
      events: lessons.filter((l) => l.status === "scheduled" || l.status === "completed").map((l) => {
        const dto = toLessonDTO(l);
        return {
          id: l.id,
          startTime: dto.startTime,
          endTime: dto.endTime,
          title: `Lesson: ${byId.get(l.studentId)?.fullName ?? ""}`,
          address: l.location,
          status: dto.status,
          studentId: l.studentId,
          studentName: byId.get(l.studentId)?.fullName ?? "",
        };
      }),
    };
  }));

  teacher.post("/lessons", wrap(async (req) => {
    const input = parse(teacherLessonSchema, req.body);
    const student = await loadStudent(req, input.studentId);
    const lesson = await createTeacherLesson(needStore().store, student, input, actorOf(req).accountId);
    await audit(req, "lesson.create", lesson.id, { studentId: student.id });
    return { lesson };
  }));
  const loadTeacherLesson = async (req: Request) => {
    const lesson = await needStore().store.getLesson(parse(uuid, req.params.id));
    if (!lesson) throw notFound("That lesson wasn't found.");
    await loadStudent(req, lesson.studentId);
    return lesson;
  };
  teacher.post("/lessons/:id/reschedule", wrap(async (req) => {
    const input = parse(z.object({ startTime: z.string().datetime({ offset: true }), minutes: z.number().int().min(15).max(240).optional(), location: z.enum(Object.keys(LOCATIONS) as [keyof typeof LOCATIONS]).optional() }), req.body);
    const current = await loadTeacherLesson(req);
    const lesson = await rescheduleTeacherLesson(needStore().store, current.id, input, actorOf(req).accountId);
    await audit(req, "lesson.reschedule", lesson.id, { from: current.id });
    return { lesson };
  }));
  teacher.post("/lessons/:id/cancel", wrap(async (req) => {
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    const current = await loadTeacherLesson(req);
    const lesson = await cancelLesson(needStore().store, current.id, reason || null, actorOf(req).accountId);
    await audit(req, "lesson.cancel", lesson.id);
    return { lesson };
  }));

  teacher.get("/invoices", wrap(async (req) => {
    const students = await teacherStudents(req);
    const invoices = await needStore().store.listInvoices({ studentIds: students.map((s) => s.id), includeDrafts: true });
    return { invoices: invoices.map(toInvoiceDTO), total: invoices.length };
  }));
  teacher.post("/invoices", wrap(async (req) => {
    const input = parse(newInvoiceSchema, req.body);
    const student = await loadStudent(req, input.studentId);
    const invoice = await createInvoice(needStore().store, student, input, actorOf(req).accountId);
    await audit(req, "invoice.create", invoice.id, { studentId: student.id });
    return { invoice };
  }));
  const loadTeacherInvoice = async (req: Request) => {
    const invoice = await needStore().store.getInvoice(parse(uuid, req.params.id));
    if (!invoice) throw notFound("That invoice wasn't found.");
    await loadStudent(req, invoice.studentId);
    return invoice;
  };
  teacher.post("/invoices/:id/payments", wrap(async (req) => {
    const input = parse(paymentSchema, req.body ?? {});
    const invoice = await loadTeacherInvoice(req);
    const result = await recordPayment(needStore().store, invoice.id, input, actorOf(req).accountId);
    await audit(req, "invoice.payment_recorded", invoice.id, { paymentId: result.payment.id });
    return result;
  }));
  // Supabase changes only. Nothing is emailed or charged.
  teacher.post("/invoices/:id/mark-paid", wrap(async (req) => {
    const invoice = await loadTeacherInvoice(req);
    const result = await recordPayment(needStore().store, invoice.id, { method: "manual", note: "Marked paid by the teacher" }, actorOf(req).accountId);
    await audit(req, "invoice.mark-paid", invoice.id, { paymentId: result.payment.id });
    return { ok: true, suppressed: false, ...result };
  }));
  for (const action of ["send", "void"] as const) {
    teacher.post(`/invoices/:id/${action}`, wrap(async (req) => {
      const invoice = await loadTeacherInvoice(req);
      const updated = await setInvoiceState(needStore().store, invoice.id, action);
      await audit(req, `invoice.${action}`, invoice.id);
      return { ok: true, suppressed: false, invoice: updated };
    }));
  }
  teacher.post("/invoices/:id/remind", wrap(async (req) => {
    const invoice = await loadTeacherInvoice(req);
    // Reminders are not sent yet. The request is logged so nothing goes out by surprise.
    await audit(req, "invoice.remind", invoice.id, { suppressed: true });
    return { ok: true, suppressed: true, action: "remind", invoiceId: invoice.id };
  }));

  teacher.post("/notes", wrap(async (req) => {
    const input = parse(noteSchema, req.body);
    await loadStudent(req, input.studentId);
    const note = await needStore().store.saveNote(null, input, actorOf(req).accountId);
    await audit(req, "note.create", note.id);
    return note;
  }));
  teacher.put("/notes/:id", wrap(async (req) => {
    const input = parse(noteSchema, req.body);
    const note = await needStore().store.saveNote(parse(uuid, req.params.id), input, actorOf(req).accountId);
    await audit(req, "note.update", note.id);
    return note;
  }));
  teacher.post("/notes/:id/publish", wrap(async (req) => {
    const note = await needStore().store.publishNote(parse(uuid, req.params.id));
    await audit(req, "note.publish", note.id, { studentId: note.studentId });
    return note;
  }));

  teacher.get("/videos", wrap(async () => ({ videos: await needStore().store.listVideos() })));
  teacher.post("/videos/url", wrap(async (req) => {
    const input = parse(videoSchema.extend({ url: videoUrlSchema }), req.body);
    const video = await needStore().store.saveVideo(null, { title: input.title, category: input.category, description: input.description, source: "url", externalUrl: input.url });
    await audit(req, "video.add_url", video.id);
    return video;
  }));
  teacher.post("/videos/upload", wrap(async (req) => {
    const input = parse(videoSchema.extend({ fileName: z.string().min(1).max(200) }), req.body);
    const ext = input.fileName.split(".").pop()?.toLowerCase();
    if (ext !== "mp4" && ext !== "mov") throw new ApiError(400, "invalid_input", "Videos must be MP4 or MOV.");
    const storagePath = `${randomUUID()}.${ext}`;
    const { store } = needStore();
    const uploadUrl = await store.signedUploadUrl(storagePath);
    const video = await store.saveVideo(null, { title: input.title, category: input.category, description: input.description, source: "upload", storagePath });
    await audit(req, "video.upload", video.id);
    return { video, uploadUrl };
  }));
  teacher.put("/videos/:id", wrap(async (req) => {
    const id = parse(uuid, req.params.id);
    const input = parse(videoSchema, req.body);
    const { store } = needStore();
    const existing = await store.getVideo(id);
    if (!existing) throw notFound();
    const video = await store.saveVideo(id, { ...input, source: existing.source });
    await audit(req, "video.update", id);
    return video;
  }));
  teacher.get("/videos/:id/assignees", wrap(async (req) => ({ studentIds: await needStore().store.videoAssignees(parse(uuid, req.params.id)) })));
  teacher.put("/videos/:id/assignees", wrap(async (req) => {
    const id = parse(uuid, req.params.id);
    const { studentIds } = parse(z.object({ studentIds: z.array(uuid).max(500) }), req.body);
    await needStore().store.setVideoAssignees(id, studentIds);
    await audit(req, "video.assign", id, { count: studentIds.length });
    return { ok: true };
  }));

  teacher.get("/assignments", wrap(async () => ({ assignments: await needStore().store.listAssignments(null) })));
  teacher.post("/assignments", wrap(async (req) => {
    const input = parse(assignmentSchema, req.body);
    const created = await needStore().store.createAssignment(input);
    await audit(req, "assignment.create", created.id);
    return created;
  }));

  teacher.get("/invitations", wrap(async () => ({ invitations: await needStore().store.listInvitations() })));
  const issueInvite = async (req: Request, input: { email: string; name: string; method: "email" | "code"; role: "guardian" | "student"; studentIds: string[] }) => {
    const { store, auth } = needStore();
    if (input.method === "email") assertPortalInviteEmail(config.safeMode, input.email, config.safeModeEmailAllowlist);
    const linked = input.studentIds.length ? await store.getStudents(input.studentIds) : [];
    if (input.studentIds.length && linked.length !== input.studentIds.length) throw notFound("That student wasn't found.");
    // A new code replaces any still-pending invite for this email, including a resend of the same row.
    await store.revokePendingForEmail(input.email);
    const credential = input.method === "code" ? newEnrollmentCode() : newInviteToken();
    const inviteUrl = input.method === "email" ? portalInvitePage(config.appUrl) : undefined;
    const fullName = inviteeFullName(input.name, input.email);
    const invite = await store.createInvitation({
      tokenHash: hashCredential(credential),
      method: input.method,
      email: input.email,
      name: input.name.trim() || fullName,
      role: input.role,
      studentIds: input.studentIds,
      expiresAt: new Date(Date.now() + (input.method === "email" ? INVITE_CODE_TTL_MS : INVITE_TTL_MS)).toISOString(),
      preview: {
        firstName: fullName.split(/\s+/)[0] || fullName,
        studentLine: linked.length ? linked.map((s) => s.fullName).join(", ") : "Not enrolled yet",
        accountFor: `${fullName} · ${input.role === "guardian" ? "parent" : "student"}`,
        lessons: linked[0]?.styleLine ?? "",
        format: linked[0]?.format ?? "In person",
      },
    });
    let emailed = false;
    if (inviteUrl) {
      try {
        await auth.sendPortalInvite(input.email, inviteUrl);
        emailed = true;
      } catch (e) {
        await store.revokeInvitation(invite.id).catch(() => undefined);
        if (e instanceof ApiError) throw e;
        throw new ApiError(503, "invite_email_failed", "The invitation email wasn't sent. Please try again.");
      }
    }
    await audit(req, "invitation.create", invite.id, { method: input.method, emailed });
    // The plain credential is returned once and never stored. The email itself is sent by Supabase, not GoHighLevel.
    return {
      id: invite.id,
      name: invite.name,
      email: invite.email,
      studentName: invite.preview.studentLine,
      status: input.method === "code" ? "code_issued" : "pending",
      method: input.method,
      sentAt: new Date().toISOString(),
      expiresAt: invite.expiresAt,
      accountId: null,
      ...(input.method === "code" ? { credential } : {}),
      emailed,
      inviteUrl,
    };
  };

  teacher.post("/invitations", wrap(async (req) => {
    const input = parse(inviteSchema, req.body);
    return issueInvite(req, {
      email: input.email,
      name: input.name ?? "",
      method: input.method ?? "email",
      role: input.role ?? "student",
      studentIds: input.studentIds ?? [],
    });
  }));
  teacher.post("/invitations/:id/resend", wrap(async (req) => {
    const { store } = needStore();
    const existing = await store.getInvitation(parse(uuid, req.params.id));
    if (!existing || existing.status === "revoked") throw notFound("That invitation wasn't found.");
    if (existing.status !== "pending") throw new ApiError(409, "invitation_closed", "That invitation is no longer pending.");
    return issueInvite(req, { email: existing.email, name: existing.name, method: existing.method, role: existing.role, studentIds: existing.studentIds });
  }));
  teacher.post("/invitations/:id/revoke", wrap(async (req) => {
    const id = parse(uuid, req.params.id);
    await needStore().store.revokeInvitation(id);
    await audit(req, "invitation.revoke", id);
    return { ok: true };
  }));

  teacher.post("/accounts/:id/password-reset", wrap(async (req) => {
    limiter.hit(`reset:${actorOf(req).accountId}`, 20, 60 * 60000);
    const { store, auth } = needStore();
    const id = parse(uuid, req.params.id);
    const account = await store.getAccount(id);
    if (!account) throw notFound();
    await auth.sendPasswordReset(account.email);
    await audit(req, "account.password_reset", id);
    return { ok: true };
  }));
  teacher.post("/accounts/:id/suspend", wrap(async (req) => {
    const { store, auth } = needStore();
    const id = parse(uuid, req.params.id);
    if (id === actorOf(req).accountId) throw new ApiError(400, "invalid_input", "You can't suspend your own account.");
    const account = await store.setAccountStatus(id, "suspended");
    await auth.setBanned(account.userId, true);
    await audit(req, "account.suspend", id);
    return { ok: true };
  }));
  teacher.post("/accounts/:id/restore", wrap(async (req) => {
    const { store, auth } = needStore();
    const id = parse(uuid, req.params.id);
    const account = await store.setAccountStatus(id, "active");
    await auth.setBanned(account.userId, false);
    await audit(req, "account.restore", id);
    return { ok: true };
  }));

  teacher.get("/settings", wrap(async () => ({ integrations: { supabase: !!deps.store, storage: !!deps.store }, cardSaving: !!config.stripe, referralMail: !!config.smtp })));

  app.use("/api/teacher", teacher);

  app.use("/api", (_req, _res, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}

function publicStudent(s: StudentRecord) {
  // Internal ids stay on the server. The browser never needs them and never gets to supply them.
  const { ghlContactId: _c, billingContactId: _b, teacherAccountId: _t, payerId: _p, ...rest } = s;
  return rest;
}

export { isOutstanding, OUTSTANDING_BALANCE_MESSAGE };
