import { parseNewStudent, createStudent, enrollInvitedStudent } from "./services/students.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { OUTSTANDING_BALANCE_MESSAGE, type DashboardResponse, type InvitationPreview, type MePending, type MeResponse, type TeacherStudentRow } from "../shared/portal-types.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { ApiError, errorHandler, forbidden, notConfigured, notFound, parse, uuid, wrap } from "./http.js";
import { memoryRateLimiter, type RateLimiter } from "./rateLimit.js";
import { assertCanViewStudent, assertSessionAllowed, assertTeacher, canBookFor, canPayFor, type Actor } from "./auth/policy.js";
import { createStripeCheckout, type CheckoutClient } from "./integrations/stripeCheckout.js";
import { createGoogleCalendar, type GoogleBusyClient } from "./integrations/googleCalendar.js";
import { createMailer, type Mailer } from "./mail/mailer.js";
import { invoicesWithReports, buyPackage, createManualInvoice, getStudentBilling, isOutstanding, issueDraft, markInvoicePaid, markPaidSchema, newInvoiceSchema, packageSchema, paymentSchema, recordPartPayment, toInvoiceDTO, voidInvoice, amountDueCents } from "./services/billing.js";
import { assertCanBookNew, bookLessons, cancelLesson, LESSON_STEP_MINUTES, lessonSlots, portalBookingSchema, releaseExpiredHolds, rescheduleLesson, rescheduleSchema, splitLessons, teacherLessonSchema, toLessonDTO, weeksFor } from "./services/lessons.js";
import { applyReferralCode, ensureReferralCode, referralPanel } from "./services/referrals.js";
import { opsSummary } from "./services/ops.js";
import { confirmReport, confirmSchema, rejectReport, reportPayment, reportSchema, teacherReportList, zelleDetails } from "./services/paymentReports.js";
import { bookingDate, BOOKING_TIMEZONE, startOfBookingDate } from "./services/availability.js";
import type { PortalContext } from "./services/context.js";
import { paymentInstructions } from "./services/notify.js";
import { LESSON_MINUTES } from "../shared/pricing.js";
import { isEmailOtp } from "../shared/email-otp.js";
import { assertPortalInviteEmail, hashCredential, INVITE_CODE_TTL_MS, INVITE_TTL_MS, inviteeFullName, newEnrollmentCode, newInviteToken, portalInvitePage } from "./services/invitations.js";
import { createSupabaseAuthAdmin, createSupabaseStore } from "./store/supabaseStore.js";
import type { AuthAdmin, PortalStore, StudentRecord } from "./store/types.js";

export interface Deps {
  config: ServerConfig;
  store: PortalStore | null;
  auth: AuthAdmin | null;
  limiter: RateLimiter;
  mailer: Mailer;
  /** Google Calendar free/busy (read-only). Null when not configured: open times then fail closed. */
  google: GoogleBusyClient | null;
  /** Stripe Checkout in test mode. Null unless CARD_PAYMENTS_ENABLED=true with test keys. */
  checkout: CheckoutClient | null;
  /** The clock, replaceable in tests. */
  now?: () => number;
}

export function defaultDeps(): Deps {
  const config = loadConfig();
  return {
    config,
    store: config.supabase ? createSupabaseStore(config.supabase.url, config.supabase.serviceRoleKey, config.videoBucket) : null,
    auth: config.supabase ? createSupabaseAuthAdmin(config.supabase.url, config.supabase.serviceRoleKey, config.appUrl) : null,
    limiter: memoryRateLimiter(),
    mailer: createMailer({ smtp: config.smtp, safeMode: config.safeMode, allowlist: config.safeModeEmailAllowlist }),
    google: config.google ? createGoogleCalendar(config.google) : null,
    checkout: config.features.cardPayments && config.stripe ? createStripeCheckout(config.stripe) : null,
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
  lessonId: uuid.nullable().optional(),
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
  const now = () => (deps.now ?? Date.now)();
  const ctx = (): PortalContext => ({ store: needStore().store, mailer: deps.mailer, google: deps.google, appUrl: config.appUrl, now });

  // Stripe (test mode) needs the exact signed bytes, so its webhook is registered before the JSON parser.
  // Each event is handled once; marking an already-paid invoice paid again changes nothing.
  app.post("/api/webhooks/stripe", express.raw({ type: "*/*", limit: "1mb" }), wrap(async (req) => {
    if (!config.features.cardPayments || !deps.checkout || !config.stripeWebhookSecret) throw notFound();
    const signature = req.header("stripe-signature") ?? "";
    let event: ReturnType<CheckoutClient["verifyEvent"]>;
    try {
      event = deps.checkout.verifyEvent(req.body as Buffer, signature, config.stripeWebhookSecret);
    } catch {
      throw new ApiError(400, "invalid_signature", "Signature check failed.");
    }
    if (event.type !== "checkout.session.completed") return { received: true };
    const session = event.data.object as { id?: string; payment_status?: string; metadata?: Record<string, string>; client_reference_id?: string; livemode?: boolean };
    if (session.livemode) throw new ApiError(400, "live_mode", "Live events are not accepted.");
    const invoiceId = session.metadata?.invoice_id ?? session.client_reference_id ?? null;
    if (!invoiceId || session.payment_status !== "paid") return { received: true };
    const { store } = needStore();
    if (!(await store.claimStripeEvent(event.id, event.type, invoiceId))) return { received: true, duplicate: true };
    await markInvoicePaid(ctx(), invoiceId, { method: "card", reference: session.id ?? "", note: "Stripe Checkout (test mode)", actorAccountId: null });
    return { received: true };
  }));

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

  // ---- public: the booking page widget's open times ---------------------------------------------------------
  // The studio's weekly lesson hours minus Google Calendar busy times minus booked or held lessons.
  app.get("/api/booking/availability", wrap(async (req) => {
    limiter.hit(`booking-availability:${clientKey(req)}`, 60, 60000);
    const q = parse(z.object({ from: dateOnly, to: dateOnly }), req.query);
    const fromMs = startOfBookingDate(q.from), toMs = startOfBookingDate(q.to) + 86400000;
    if (!(toMs > fromMs) || toMs - fromMs > 31 * 86400000) throw new ApiError(400, "invalid_input", "That date range isn't valid.");
    const { store } = needStore();
    const teacherId = await store.studioTeacherAccountId();
    if (!teacherId) throw new ApiError(503, "availability_unavailable", "Open times can't be checked right now. Please try again shortly.");
    await releaseExpiredHolds(ctx());
    const days = await lessonSlots(ctx(), teacherId, q.from, q.to, { durationMinutes: config.bookingSlotMinutes, stepMinutes: config.bookingSlotMinutes });
    return { timezone: BOOKING_TIMEZONE, slotMinutes: config.bookingSlotMinutes, days };
  }));

  // ---- ops: read-only summary for the Grok bot, bearer token only ---------------------------------------------
  app.get("/api/ops/summary", wrap(async (req) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!config.opsApiToken || !safeEqual(token, config.opsApiToken)) throw new ApiError(401, "unauthenticated", "A valid ops token is required.");
    limiter.hit(`ops:${clientKey(req)}`, 60, 60000);
    await releaseExpiredHolds(ctx());
    return opsSummary(needStore().store, now());
  }));

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
      return studentIds;
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

  /** A referral code typed at sign-up. It never blocks the sign-up; a bad code is reported back instead. */
  const referralAtSignup = async (studentIds: string[], code: string | undefined) => {
    if (!code?.trim() || studentIds.length !== 1) return null;
    try {
      await applyReferralCode(needStore().store, studentIds[0], code);
      return "applied" as const;
    } catch {
      return "invalid" as const;
    }
  };
  const referralField = z.string().trim().max(40).optional();

  app.post("/api/invitations/redeem", wrap(async (req) => {
    limiter.hit(`invite-redeem:${clientKey(req)}`, 10, 15 * 60000);
    const { credential, password: pw, referralCode } = parse(z.object({ credential: z.string().trim().min(8).max(200), password, referralCode: referralField }), req.body);
    const { store } = needStore();
    const invite = await findLiveInvite(credential);
    const studentIds = await completeInvitation(invite, { password: pw });
    await store.audit(null, "invitation.redeemed", invite.id);
    return { email: invite.email, referral: await referralAtSignup(studentIds, referralCode) };
  }));

  app.post("/api/invitations/verify-code", wrap(async (req) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email().max(200), code: z.string().trim(), referralCode: referralField }), req.body);
    limiter.hit(`invite-code:${clientKey(req)}:${body.email}`, 8, 15 * 60000);
    if (!isEmailOtp(body.code)) throw new ApiError(400, "invalid_code", "Enter the code from the email.");
    const { store, auth } = needStore();
    const invite = await store.findPendingInvitationByEmail(body.email);
    if (!invite) throw new ApiError(404, "invalid_invitation", "That code isn't valid or has already been used.");
    if (new Date(invite.expiresAt).getTime() < Date.now()) throw new ApiError(410, "invitation_expired", "This code has expired. Ask Zane to send a new one.");
    const session = await auth.verifyEmailOtp(body.email, body.code);
    if (!session) throw new ApiError(401, "invalid_code", "That code isn't valid or has expired.");
    const studentIds = await completeInvitation(invite, { userId: session.userId });
    await store.audit(null, "invitation.redeemed", invite.id);
    return { accessToken: session.accessToken, refreshToken: session.refreshToken, email: invite.email, referral: await referralAtSignup(studentIds, body.referralCode) };
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
  const policyFor = async (student: StudentRecord) => {
    const { store } = needStore();
    const teacherId = student.teacherAccountId ?? (await store.studioTeacherAccountId());
    if (!teacherId) return null;
    const s = await store.getSettings(teacherId);
    return { zelleRecipient: s.zelleRecipient, holdWindowMinutes: s.holdWindowMinutes, rescheduleNoticeHours: s.rescheduleNoticeHours, cancelNoticeHours: s.cancelNoticeHours };
  };

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
      policy: null,
      referrals: null,
      lessonsAvailable: false,
      canBook: false,
      canPay: false,
      readOnly: isTeacher,
    };
    if (!student) return empty;
    if (isTeacher) await audit(req, "teacher.preview_student", student.id);
    await releaseExpiredHolds(ctx()).catch((e) => console.error("[api] hold release failed", e instanceof Error ? e.message : ""));
    const [notes, videos, assignments] = await Promise.all([
      store.listNotes(student.id, { publishedOnly: true }),
      store.listAssignedVideos(student.id),
      store.listAssignments(student.id),
    ]);
    let upcoming: DashboardResponse["upcoming"] = [];
    let history: DashboardResponse["history"] = [];
    let billing: DashboardResponse["billing"] = null;
    let lessonsAvailable = false;
    let credits = 0;
    let policy: DashboardResponse["policy"] = null;
    let referrals: DashboardResponse["referrals"] = null;
    // One failed read mustn't take the rest down with it. A null section shows as "unavailable".
    const soft = (what: string) => (e: unknown) => console.error(`[api] ${what} unavailable`, e instanceof Error ? e.message : "");
    await Promise.all([
      store.listLessons({ studentIds: [student.id] }).then((lessons) => {
        ({ upcoming, history } = splitLessons(lessons, now()));
        lessonsAvailable = true;
      }).catch(soft("lessons")),
      getStudentBilling(store, student.id, config.features.cardPayments).then((b) => { billing = b; }).catch(soft("billing")),
      store.creditBalances([student.id]).then((c) => { credits = c[student.id] ?? 0; }).catch(soft("credits")),
      // The Zelle recipient isn't secret, but only payers (and the teacher) for this student receive it.
      policyFor(student).then((p) => { policy = p && !(isTeacher || canPayFor(actor, student.id)) ? { ...p, zelleRecipient: "" } : p; }).catch(soft("policy")),
      referralPanel(store, student.id).then((r) => { referrals = r; }).catch(soft("referrals")),
    ]);
    const body: DashboardResponse = {
      ...empty,
      student: publicStudent(student),
      upcoming,
      history,
      notes,
      videos,
      assignments,
      packageLessons: credits,
      policy,
      referrals,
      // Invoices can include the payer's details, so only payers and the teacher receive them.
      billing: isTeacher || canPayFor(actor, student.id) ? billing : null,
      lessonsAvailable,
      canBook: canBookFor(actor, student.id),
      canPay: canPayFor(actor, student.id),
    };
    return body;
  }));

  app.get("/api/lessons/slots", authenticate(), wrap(async (req) => {
    const q = parse(z.object({ studentId: uuid, from: dateOnly, to: dateOnly }), req.query);
    const student = await loadStudent(req, q.studentId);
    const fromMs = startOfBookingDate(q.from), toMs = startOfBookingDate(q.to);
    if (!(toMs >= fromMs) || toMs - fromMs > 31 * 86400000) throw new ApiError(400, "invalid_input", "That date range isn't valid.");
    const { store } = needStore();
    const teacherId = student.teacherAccountId ?? (await store.studioTeacherAccountId());
    if (!teacherId) throw new ApiError(503, "no_teacher", "No teacher is set up for lessons yet.");
    await releaseExpiredHolds(ctx());
    return { timezone: BOOKING_TIMEZONE, slotMinutes: LESSON_MINUTES, stepMinutes: LESSON_STEP_MINUTES, days: await lessonSlots(ctx(), teacherId, q.from, q.to) };
  }));

  app.post("/api/lessons", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    limiter.hit(`book:${actor.accountId}`, 20, 60 * 60000);
    const input = parse(portalBookingSchema, req.body);
    const student = await loadStudent(req, input.studentId);
    if (!canBookFor(actor, input.studentId)) throw forbidden("This account can't book lessons for this student.");
    await releaseExpiredHolds(ctx());
    await assertCanBookNew(ctx(), student.id);
    const result = await bookLessons(ctx(), { student, startTime: input.startTime, location: input.location, weeks: weeksFor(input), actorAccountId: actor.accountId, source: "portal" });
    await audit(req, "lesson.book", student.id, { count: result.lessons.length, seriesId: result.seriesId });
    return result;
  }));

  const loadFamilyLesson = async (req: Request, lessonId: string) => {
    const lesson = await needStore().store.getLesson(lessonId);
    if (!lesson) throw notFound("That lesson wasn't found.");
    const student = await loadStudent(req, lesson.studentId);
    const actor = actorOf(req);
    if (actor.role !== "teacher" && !canBookFor(actor, lesson.studentId)) throw forbidden("This account can't change lessons for this student.");
    return { lesson, student };
  };

  app.post("/api/lessons/:lessonId/reschedule", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    if (actor.role === "teacher") throw forbidden("Use the teacher calendar to move lessons.");
    limiter.hit(`book:${actor.accountId}`, 20, 60 * 60000);
    const input = parse(rescheduleSchema, req.body);
    const { lesson, student } = await loadFamilyLesson(req, parse(uuid, req.params.lessonId));
    await releaseExpiredHolds(ctx());
    const moved = await rescheduleLesson(ctx(), { lessonId: lesson.id, startTime: input.startTime, location: input.location, actorAccountId: actor.accountId, byTeacher: false, student });
    await audit(req, "lesson.reschedule", moved.id, { from: lesson.id });
    return { lesson: moved };
  }));

  app.post("/api/lessons/:lessonId/cancel", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    if (actor.role === "teacher") throw forbidden("Use the teacher calendar to cancel lessons.");
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    const { lesson, student } = await loadFamilyLesson(req, parse(uuid, req.params.lessonId));
    const result = await cancelLesson(ctx(), { lessonId: lesson.id, reason: reason || null, actorAccountId: actor.accountId, byTeacher: false, student });
    await audit(req, "lesson.cancel", lesson.id, { late: result.late });
    return result;
  }));

  /** A family's own invoice. Teachers use the teacher routes. */
  const loadPayableInvoice = async (req: Request) => {
    const actor = actorOf(req);
    const invoice = await needStore().store.getInvoice(parse(uuid, req.params.invoiceId));
    if (!invoice || actor.role === "teacher" || !canPayFor(actor, invoice.studentId) || invoice.status === "draft") throw forbidden();
    return invoice;
  };

  // Zelle and cash are paid offline. This returns the instructions; the teacher marks the invoice paid.
  app.get("/api/invoices/:invoiceId/instructions", authenticate(), wrap(async (req) => {
    const invoice = await loadPayableInvoice(req);
    const student = await needStore().store.getStudent(invoice.studentId);
    const policy = student ? await policyFor(student) : null;
    return { invoice: toInvoiceDTO(invoice), instructions: paymentInstructions(invoice, { zelleRecipient: policy?.zelleRecipient ?? "" }), zelleRecipient: policy?.zelleRecipient ?? "", cardPayments: config.features.cardPayments };
  }));
  // Pay with Zelle: details for a payer linked to this invoice. A blank teacher recipient hides Zelle.
  app.get("/api/invoices/:invoiceId/zelle", authenticate(), wrap(async (req) => {
    const invoice = await loadPayableInvoice(req);
    const student = await needStore().store.getStudent(invoice.studentId);
    if (!student) throw notFound();
    return zelleDetails(needStore().store, invoice, student);
  }));

  // "I've sent it": a pending report. It never marks the invoice paid; the teacher confirms it.
  app.post("/api/invoices/:invoiceId/payment-reports", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    limiter.hit(`report:${actor.accountId}`, 10, 60 * 60000);
    const input = parse(reportSchema, req.body ?? {});
    const invoice = await loadPayableInvoice(req);
    const report = await reportPayment(needStore().store, invoice, input, actor.accountId);
    await audit(req, "payment.reported", invoice.id, { reportId: report.id, method: report.method });
    return { report };
  }));

  // Kept for the existing Pay Now button: it now answers with the offline instructions.
  app.post("/api/invoices/:invoiceId/send-payment-link", authenticate(), wrap(async (req) => {
    const invoice = await loadPayableInvoice(req);
    if (!isOutstanding(toInvoiceDTO(invoice))) throw new ApiError(409, "invoice_not_payable", "This invoice has nothing left to pay.");
    const student = await needStore().store.getStudent(invoice.studentId);
    const policy = student ? await policyFor(student) : null;
    return { sent: false, suppressed: false, offline: true, invoiceId: invoice.id, amountDue: amountDueCents(invoice) / 100, instructions: paymentInstructions(invoice, { zelleRecipient: policy?.zelleRecipient ?? "" }) };
  }));

  // Card payments (Stripe test mode). Hidden and refused unless CARD_PAYMENTS_ENABLED=true.
  app.post("/api/invoices/:invoiceId/checkout", authenticate(), wrap(async (req) => {
    if (!config.features.cardPayments || !deps.checkout) throw new ApiError(404, "card_payments_off", "Card payments aren't available.");
    const actor = actorOf(req);
    limiter.hit(`pay:${actor.accountId}`, 10, 15 * 60000);
    const invoice = await loadPayableInvoice(req);
    const due = amountDueCents(invoice);
    if (!isOutstanding(toInvoiceDTO(invoice)) || due <= 0) throw new ApiError(409, "invoice_not_payable", "This invoice has nothing left to pay.");
    const base = config.appUrl.replace(/\/$/, "");
    const session = await deps.checkout.createSession({
      invoiceId: invoice.id, invoiceNumber: invoice.number, amountCents: due, label: invoice.kind === "package" ? "4-lesson package" : invoice.kind === "session" ? "60-min lesson" : invoice.title || "Invoice",
      successUrl: `${base}/portal?paid=${invoice.id}`, cancelUrl: `${base}/portal`,
    });
    await needStore().store.setInvoiceStripeSession(invoice.id, session.id);
    return { url: session.url };
  }));

  app.post("/api/packages/purchase", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    limiter.hit(`pay:${actor.accountId}`, 10, 15 * 60000);
    const input = parse(packageSchema, req.body);
    if (actor.role === "teacher" || !canPayFor(actor, input.studentId)) throw forbidden();
    const student = await loadStudent(req, input.studentId);
    const { invoice, existing } = await buyPackage(ctx(), student, input.method, actor.accountId, config.features.cardPayments);
    const policy = await policyFor(student);
    if (!existing) await audit(req, "package.invoice", invoice.id, { method: input.method });
    return { invoice: toInvoiceDTO(invoice), existing, instructions: paymentInstructions(invoice, { zelleRecipient: policy?.zelleRecipient ?? "" }), creditsAdded: invoice.status === "paid" ? invoice.packageLessons : 0 };
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

  app.get("/api/referrals", authenticate(), wrap(async (req) => {
    const studentId = parse(uuid, req.query.studentId);
    await loadStudent(req, studentId);
    return referralPanel(needStore().store, studentId);
  }));

  app.post("/api/referrals/apply", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    const input = parse(z.object({ studentId: uuid, code: z.string().trim().min(4).max(40) }), req.body);
    if (actor.role !== "teacher" && !canPayFor(actor, input.studentId)) throw forbidden();
    await loadStudent(req, input.studentId);
    const referral = await applyReferralCode(needStore().store, input.studentId, input.code);
    await audit(req, "referral.apply", input.studentId, { referralId: referral.id });
    return { ok: true, discountCents: referral.discountCents };
  }));

  // ---- teacher ---------------------------------------------------------------------------------------------
  const teacher = express.Router();
  teacher.use(authenticate(), requireTeacher);

  teacher.get("/students", wrap(async (req) => {
    const { store } = needStore();
    const students = await teacherStudents(req);
    const ids = students.map((s) => s.id);
    const [counts, accounts, credits, lessons] = await Promise.all([
      store.studentCounts(),
      store.studentAccounts(),
      store.creditBalances(ids),
      store.listLessons({ studentIds: ids, from: new Date(now()).toISOString(), statuses: ["scheduled", "pending_payment"] }),
    ]);
    const nextByStudent: Record<string, string> = {};
    for (const l of lessons) nextByStudent[l.studentId] ??= new Date(l.startsAt).toISOString();
    const rows: TeacherStudentRow[] = students.map((s) => ({
      ...publicStudent(s),
      email: s.email,
      nextLesson: nextByStudent[s.id] ?? null,
      noteCount: counts[s.id]?.notes ?? 0,
      videoCount: counts[s.id]?.videos ?? 0,
      assignmentCount: counts[s.id]?.assignments ?? 0,
      packageLessons: credits[s.id] ?? 0,
      accountId: accounts[s.id]?.accountId ?? null,
      portalStatus: accounts[s.id]?.status ?? "none",
      transferPending: false,
    }));
    return { students: rows };
  }));

  teacher.post("/students", wrap(async (req) => {
    const input = parseNewStudent(req.body);
    const referralCode = parse(z.string().trim().max(40).optional(), (req.body as any)?.referralCode || undefined);
    const { store } = needStore();
    const { student, guardian } = await createStudent(store, input, actorOf(req).accountId);
    await ensureReferralCode(store, student.id);
    let referral: "applied" | "invalid" | null = null;
    if (referralCode) {
      try { await applyReferralCode(store, student.id, referralCode); referral = "applied"; } catch { referral = "invalid"; }
    }
    await audit(req, "student.create", student.id, { guardian, referral });
    return { student: { id: student.id, fullName: student.fullName }, guardian, referral };
  }));
  teacher.get("/students/:id", wrap(async (req) => {
    const student = await loadStudent(req, parse(uuid, req.params.id));
    const { store } = needStore();
    await releaseExpiredHolds(ctx());
    const [notes, videos, assignments, credits] = await Promise.all([
      store.listNotes(student.id, { publishedOnly: false }),
      store.listAssignedVideos(student.id),
      store.listAssignments(student.id),
      store.creditBalances([student.id]),
    ]);
    const [lessons, billing, referrals] = await Promise.all([
      store.listLessons({ studentIds: [student.id] }).then((rows) => rows.map(toLessonDTO)).catch(() => null),
      getStudentBilling(store, student.id).catch(() => null),
      referralPanel(store, student.id).catch(() => null),
    ]);
    return { student: publicStudent(student), notes, videos, assignments, lessons, billing, packageLessons: credits[student.id] ?? 0, referrals };
  }));

  teacher.get("/overview", wrap(async (req) => {
    const { store } = needStore();
    const [students, recentNotes, recentVideos, invitations] = await Promise.all([teacherStudents(req), store.recentNotes(3), store.recentAssignedVideos(3), store.listInvitations()]);
    return { studentCount: students.length, adultCount: students.filter((s) => !s.isMinor).length, recentNotes, recentVideos, invitations };
  }));

  teacher.get("/calendar", wrap(async (req) => {
    const q = parse(z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }), req.query);
    if (q.to <= q.from || q.to - q.from > 31 * 86400000) throw new ApiError(400, "invalid_input", "That date range isn't valid.");
    await releaseExpiredHolds(ctx());
    const students = await teacherStudents(req);
    const byId = new Map(students.map((s) => [s.id, s]));
    const lessons = await needStore().store.listLessons({ studentIds: [...byId.keys()], from: new Date(q.from).toISOString(), to: new Date(q.to).toISOString() });
    return {
      events: lessons.filter((l) => l.status === "scheduled" || l.status === "pending_payment" || l.status === "completed").map((l) => {
        const dto = toLessonDTO(l);
        return {
          id: l.id,
          startTime: dto.startTime,
          endTime: dto.endTime,
          title: `Lesson: ${byId.get(l.studentId)?.fullName ?? ""}`,
          address: l.location,
          status: dto.status,
          holdExpiresAt: l.holdExpiresAt,
          studentId: l.studentId,
          studentName: byId.get(l.studentId)?.fullName ?? "",
        };
      }),
    };
  }));

  teacher.post("/lessons", wrap(async (req) => {
    const input = parse(teacherLessonSchema.extend({ repeatWeekly: z.boolean().optional(), weeks: z.number().int().min(2).max(12).optional() }), req.body);
    const student = await loadStudent(req, input.studentId);
    const result = await bookLessons(ctx(), { student, startTime: input.startTime, location: input.location, weeks: weeksFor(input), actorAccountId: actorOf(req).accountId, source: "teacher" });
    await audit(req, "lesson.create", student.id, { count: result.lessons.length });
    return { lesson: result.lessons[0], lessons: result.lessons, invoiceIds: result.invoiceIds };
  }));
  const loadTeacherLesson = async (req: Request) => {
    const lesson = await needStore().store.getLesson(parse(uuid, req.params.id));
    if (!lesson) throw notFound("That lesson wasn't found.");
    const student = await loadStudent(req, lesson.studentId);
    return { lesson, student };
  };
  teacher.post("/lessons/:id/reschedule", wrap(async (req) => {
    const input = parse(rescheduleSchema, req.body);
    const { lesson: current, student } = await loadTeacherLesson(req);
    const lesson = await rescheduleLesson(ctx(), { lessonId: current.id, startTime: input.startTime, location: input.location, actorAccountId: actorOf(req).accountId, byTeacher: true, student });
    await audit(req, "lesson.reschedule", lesson.id, { from: current.id });
    return { lesson };
  }));
  teacher.post("/lessons/:id/cancel", wrap(async (req) => {
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    const { lesson: current, student } = await loadTeacherLesson(req);
    const result = await cancelLesson(ctx(), { lessonId: current.id, reason: reason || null, actorAccountId: actorOf(req).accountId, byTeacher: true, student });
    await audit(req, "lesson.cancel", current.id);
    return result;
  }));

  // Weekly lesson hours, hold window, notice windows and the Zelle recipient.
  const hoursSchema = z.array(z.object({ weekday: z.number().int().min(0).max(6), startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440) })
    .refine((h) => h.endMinute - h.startMinute >= LESSON_MINUTES, "A block must fit at least one 60-minute lesson.")).max(50);
  teacher.get("/studio", wrap(async (req) => {
    const { store } = needStore();
    const id = actorOf(req).accountId;
    const [settings, hours] = await Promise.all([store.getSettings(id), store.listLessonHours(id)]);
    return { settings, hours };
  }));
  teacher.put("/studio", wrap(async (req) => {
    const input = parse(z.object({
      holdWindowMinutes: z.number().int().min(15).max(10080).optional(),
      rescheduleNoticeHours: z.number().int().min(0).max(336).optional(),
      cancelNoticeHours: z.number().int().min(0).max(336).optional(),
      zelleRecipient: z.string().trim().max(200).optional(),
      // An optional QR image, inline as a data URL (served only to payers linked to an invoice).
      zelleQrDataUrl: z.string().max(300000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).nullable().optional(),
      hours: hoursSchema.optional(),
    }), req.body);
    const { store } = needStore();
    const id = actorOf(req).accountId;
    const { hours, ...settingsPatch } = input;
    if (hours) {
      const sorted = [...hours].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].weekday === sorted[i - 1].weekday && sorted[i].startMinute < sorted[i - 1].endMinute) throw new ApiError(400, "invalid_input", "Lesson hours on the same day can't overlap.");
      }
    }
    const settings = await store.saveSettings(id, settingsPatch);
    const saved = hours ? await store.replaceLessonHours(id, hours) : await store.listLessonHours(id);
    await audit(req, "studio.update", id, { hours: hours?.length ?? null });
    return { settings, hours: saved };
  }));

  teacher.get("/referrals", wrap(async (req) => {
    const { store } = needStore();
    const students = await teacherStudents(req);
    const name = new Map(students.map((s) => [s.id, s.fullName]));
    const [referrals, credits] = await Promise.all([store.listReferrals({}), store.listReferralCredits(students.map((s) => s.id))]);
    const mine = referrals.filter((r) => name.has(r.referrerStudentId) || name.has(r.referredStudentId));
    return {
      referrals: mine.map((r) => ({ id: r.id, referrer: name.get(r.referrerStudentId) ?? "", referred: name.get(r.referredStudentId) ?? "", code: r.code, status: r.status, createdAt: r.createdAt, completedAt: r.completedAt })),
      credits: credits.map((c) => ({ student: name.get(c.studentId) ?? "", amount: c.amountCents / 100, used: !!c.usedInvoiceId, createdAt: c.createdAt })),
    };
  }));

  teacher.get("/invoices", wrap(async (req) => {
    await releaseExpiredHolds(ctx());
    const students = await teacherStudents(req);
    const invoices = await needStore().store.listInvoices({ studentIds: students.map((s) => s.id), includeDrafts: true });
    return { invoices: await invoicesWithReports(needStore().store, invoices), total: invoices.length };
  }));
  teacher.post("/invoices", wrap(async (req) => {
    const input = parse(newInvoiceSchema, req.body);
    const student = await loadStudent(req, input.studentId);
    const invoice = await createManualInvoice(ctx(), student, input, actorOf(req).accountId);
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
    const result = await recordPartPayment(ctx(), invoice.id, input, actorOf(req).accountId);
    await audit(req, "invoice.payment_recorded", invoice.id, { paymentId: result.payment?.id ?? null });
    return result;
  }));
  // Zelle or cash received offline: records the payment, marks the invoice paid, adds package credits or
  // confirms the held session. Repeating it changes nothing.
  teacher.post("/invoices/:id/mark-paid", wrap(async (req) => {
    const input = parse(markPaidSchema, req.body ?? {});
    const invoice = await loadTeacherInvoice(req);
    const result = await markInvoicePaid(ctx(), invoice.id, { method: input.method, paidAt: input.paidAt, reference: input.reference, note: "Marked paid by the teacher", actorAccountId: actorOf(req).accountId });
    if (!result.alreadyPaid) await audit(req, "invoice.mark-paid", invoice.id, { method: input.method });
    return { ok: true, suppressed: false, ...result };
  }));
  // Reported payments (Zelle today): Confirm records the payment; Not received keeps the invoice unpaid.
  teacher.get("/payment-reports", wrap(async (req) => {
    const status = parse(z.enum(["pending", "all"]).default("pending"), req.query.status);
    return { reports: await teacherReportList(needStore().store, await teacherStudents(req), status === "all" ? undefined : "pending") };
  }));
  const loadTeacherReport = async (req: Request) => {
    const report = await needStore().store.getPaymentReport(parse(uuid, req.params.id));
    if (!report) throw notFound("That report wasn't found.");
    await loadStudent(req, report.studentId);
    return report;
  };
  teacher.post("/payment-reports/:id/confirm", wrap(async (req) => {
    const input = parse(confirmSchema, req.body ?? {});
    const report = await loadTeacherReport(req);
    const result = await confirmReport(ctx(), report, input, actorOf(req).accountId);
    await audit(req, "payment.report_confirmed", report.invoiceId, { reportId: report.id, paymentId: result.payment?.id ?? null });
    return result;
  }));
  teacher.post("/payment-reports/:id/not-received", wrap(async (req) => {
    const report = await loadTeacherReport(req);
    const result = await rejectReport(needStore().store, report, actorOf(req).accountId);
    await audit(req, "payment.report_not_received", report.invoiceId, { reportId: report.id });
    return result;
  }));

  teacher.post("/invoices/:id/send", wrap(async (req) => {
    const invoice = await loadTeacherInvoice(req);
    const updated = await issueDraft(ctx(), invoice.id);
    await audit(req, "invoice.send", invoice.id);
    return { ok: true, suppressed: false, invoice: updated };
  }));
  teacher.post("/invoices/:id/void", wrap(async (req) => {
    const invoice = await loadTeacherInvoice(req);
    const updated = await voidInvoice(ctx(), invoice.id);
    await audit(req, "invoice.void", invoice.id);
    return { ok: true, suppressed: false, invoice: updated };
  }));
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
  // The invite page on the deployment the teacher is using, so a Preview's emails point at that Preview.
  // The browser's Origin is used only when it names this same host; otherwise APP_URL.
  const inviteOrigin = (req: Request) => {
    const origin = req.header("origin");
    try {
      if (origin && new URL(origin).host === req.get("host")) return new URL(origin).origin;
    } catch { /* fall back to APP_URL */ }
    return config.appUrl;
  };
  const issueInvite = async (req: Request, input: { email: string; name: string; method: "email" | "code"; role: "guardian" | "student"; studentIds: string[] }) => {
    const { store, auth } = needStore();
    if (input.method === "email") assertPortalInviteEmail(config.safeMode, input.email, config.safeModeEmailAllowlist);
    const linked = input.studentIds.length ? await store.getStudents(input.studentIds) : [];
    if (input.studentIds.length && linked.length !== input.studentIds.length) throw notFound("That student wasn't found.");
    // A minor's invitation always goes to the guardian, and a guardian invitation needs the child it's for.
    const role = linked.some((s) => s.isMinor) ? "guardian" : input.role;
    if (role === "guardian" && !linked.length) throw new ApiError(400, "invalid_input", "Choose the student this parent or guardian is for.");
    const credential = input.method === "code" ? newEnrollmentCode() : newInviteToken();
    const inviteUrl = input.method === "email" ? portalInvitePage(inviteOrigin(req)) : undefined;
    const fullName = inviteeFullName(input.name, input.email);
    // The email goes first. If Supabase refuses it, for example inside its resend cooldown, the code that
    // was already sent stays valid because its invitation hasn't been touched.
    let emailed = false;
    if (inviteUrl) {
      try {
        await auth.sendPortalInvite(input.email, inviteUrl);
        emailed = true;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(503, "invite_email_failed", "The invitation email wasn't sent. Please try again.");
      }
    }
    const invite = await store.createInvitation({
      tokenHash: hashCredential(credential),
      method: input.method,
      email: input.email,
      name: input.name.trim() || fullName,
      role,
      studentIds: input.studentIds,
      expiresAt: new Date(Date.now() + (input.method === "email" ? INVITE_CODE_TTL_MS : INVITE_TTL_MS)).toISOString(),
      preview: {
        firstName: fullName.split(/\s+/)[0] || fullName,
        studentLine: linked.length ? linked.map((s) => s.fullName).join(", ") : "Not enrolled yet",
        accountFor: `${fullName} · ${role === "guardian" ? "parent" : "student"}`,
        lessons: linked[0]?.styleLine ?? "",
        format: linked[0]?.format ?? "In person",
      },
    });
    // Only now does the new invitation replace older pending ones for this email, including a resent row.
    await store.revokePendingForEmail(input.email, invite.id);
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

  teacher.get("/settings", wrap(async () => ({
    integrations: { supabase: !!deps.store, storage: !!deps.store, googleCalendar: !!deps.google, email: !!config.smtp },
    cardPayments: config.features.cardPayments,
    safeMode: config.safeMode,
  })));

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

/** Constant-time comparison for the ops token. */
function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
