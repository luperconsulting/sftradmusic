import { parseNewStudent, resolveStudentContacts } from "./services/students.js";
import { studentFormMessages } from "../shared/student-form.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OUTSTANDING_BALANCE_MESSAGE, type BillingDTO, type LessonDTO, type DashboardResponse, type InvitationPreview, type MeResponse, type TeacherStudentRow } from "../shared/portal-types.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { ApiError, errorHandler, forbidden, notConfigured, notFound, parse, uuid, wrap } from "./http.js";
import { memoryRateLimiter, type RateLimiter } from "./rateLimit.js";
import { assertCanViewStudent, assertSessionAllowed, assertTeacher, canBookFor, canPayFor, type Actor } from "./auth/policy.js";
import { createGhlClient, toInvoiceDTO, toLessonDTO, type GhlClient } from "./integrations/ghl.js";
import { getBilling, isOutstanding, sendInvoicePaymentLink } from "./services/billing.js";
import { bookingSchema, createLessonBooking, rescheduleLesson } from "./services/booking.js";
import { assertPortalInviteEmail, hashCredential, INVITE_TTL_MS, newEnrollmentCode, newInviteToken, portalInviteRedirect } from "./services/invitations.js";
import { verifyWebhookSignature } from "./webhooks.js";
import { createSupabaseAuthAdmin, createSupabaseStore } from "./store/supabaseStore.js";
import type { AuthAdmin, PortalStore, StudentRecord } from "./store/types.js";

export interface Deps {
  config: ServerConfig;
  store: PortalStore | null;
  auth: AuthAdmin | null;
  ghl: GhlClient | null;
  limiter: RateLimiter;
}

export function defaultDeps(): Deps {
  const config = loadConfig();
  return {
    config,
    store: config.supabase ? createSupabaseStore(config.supabase.url, config.supabase.serviceRoleKey, config.videoBucket) : null,
    auth: config.supabase ? createSupabaseAuthAdmin(config.supabase.url, config.supabase.serviceRoleKey, config.appUrl) : null,
    ghl: config.ghl ? createGhlClient(config.ghl) : null,
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
const inviteSchema = z.object({
  method: z.enum(["email", "code"]),
  role: z.enum(["guardian", "student"]),
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(120),
  studentIds: z.array(uuid).min(1).max(10),
});

export function createApp(deps: Deps) {
  const { config, limiter } = deps;
  const app = express();
  app.disable("x-powered-by");

  const needStore = () => {
    if (!deps.store || !deps.auth) throw notConfigured("Sign-in");
    return { store: deps.store, auth: deps.auth };
  };
  const needGhl = () => {
    if (!deps.ghl) throw notConfigured("GoHighLevel");
    return deps.ghl;
  };
  const clientKey = (req: Request) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();

  // The webhook needs the exact bytes it was signed over, so it's registered before the JSON parser.
  app.post("/api/webhooks/ghl", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const signature = req.header("x-wh-signature");
    if (!verifyWebhookSignature(req.body as Buffer, signature, config.ghlWebhookPublicKey)) {
      res.status(401).json({ error: { code: "invalid_signature", message: "Signature check failed." } });
      return;
    }
    // Payment status is always re-read from GoHighLevel, so a verified event needs no state change here.
    res.json({ ok: true });
  });

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
      if (!account) throw forbidden("No portal account is linked to this sign-in.");
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
  const loadStudent = async (req: Request, studentId: string): Promise<StudentRecord> => {
    assertCanViewStudent(actorOf(req), studentId);
    const student = await needStore().store.getStudent(studentId);
    if (!student) throw notFound();
    return student;
  };

  app.get("/api/health", (_req, res) => {
    res.json({ supabase: !!deps.store, ghl: !!deps.ghl });
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

  app.post("/api/invitations/redeem", wrap(async (req) => {
    limiter.hit(`invite-redeem:${clientKey(req)}`, 10, 15 * 60000);
    const { credential, password: pw } = parse(z.object({ credential: z.string().trim().min(8).max(200), password }), req.body);
    const { store, auth } = needStore();
    const invite = await findLiveInvite(credential);
    if (!(await store.claimInvitation(invite.id))) throw new ApiError(404, "invalid_invitation", "That code isn't valid or has already been used.");
    let userId: string | null = null;
    try {
      userId = await auth.createUser(invite.email, pw, invite.preview.authUserId);
      await store.createAccountForInvitation(invite, userId);
    } catch (e) {
      // Undo the half-made login too. Otherwise a retry fails forever because the email is already taken.
      if (userId) await auth.deleteUser(userId).catch(() => console.error("[api] could not remove partial user"));
      await store.releaseInvitation(invite.id);
      throw e;
    }
    await store.audit(null, "invitation.redeemed", invite.id);
    return { email: invite.email };
  }));

  // ---- signed-in, any role ---------------------------------------------------------------------------------
  app.get("/api/me", authenticate(true), wrap(async (req) => {
    const actor = actorOf(req);
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
      lessonsAvailable: !!deps.ghl,
      canBook: false,
      canPay: false,
      readOnly: isTeacher,
    };
    if (!student) return empty;
    if (isTeacher) await audit(req, "teacher.preview_student", student.id);
    const [notes, videos, assignments] = await Promise.all([
      store.listNotes(student.id, { publishedOnly: true }),
      store.listAssignedVideos(student.id),
      store.listAssignments(student.id),
    ]);
    let upcoming: DashboardResponse["upcoming"] = [];
    let history: DashboardResponse["history"] = [];
    let billing: DashboardResponse["billing"] = null;
    let lessonsAvailable = false;
    if (deps.ghl) {
      const ghl = deps.ghl;
      // One failed read mustn't take notes and videos down with it. A null section shows as "unavailable".
      await Promise.all([
        ghl.getContactAppointments(student.ghlContactId).then((events) => {
          const now = Date.now();
          const lessons = events
            .filter((e) => e.calendarId === ghl.config.lessonCalendarId)
            .map((e) => toLessonDTO(e, student.id))
            .sort((a, b) => a.startTime.localeCompare(b.startTime));
          upcoming = lessons.filter((l) => new Date(l.startTime).getTime() >= now && l.status !== "cancelled");
          history = lessons.filter((l) => new Date(l.startTime).getTime() < now).reverse();
          lessonsAvailable = true;
        }).catch(() => undefined),
        getBilling(ghl, student.billingContactId).then((b) => { billing = b; }).catch(() => undefined),
      ]);
    }
    const body: DashboardResponse = {
      ...empty,
      student: publicStudent(student),
      upcoming,
      history,
      notes,
      videos,
      assignments,
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
    const ghl = needGhl();
    const fromMs = new Date(`${q.from}T00:00:00Z`).getTime();
    const toMs = new Date(`${q.to}T23:59:59Z`).getTime();
    if (!(toMs > fromMs) || toMs - fromMs > 31 * 86400000) throw new ApiError(400, "invalid_input", "That date range isn't valid.");
    return { timezone: ghl.config.timezone, days: await ghl.getFreeSlots(fromMs, toMs) };
  }));

  app.post("/api/lessons", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    limiter.hit(`book:${actor.accountId}`, 20, 60 * 60000);
    const input = parse(bookingSchema, req.body);
    const student = await loadStudent(req, input.studentId);
    const event = await createLessonBooking(needGhl(), actor, student, input);
    return { id: event.id, startTime: event.startTime ?? input.startTime };
  }));

  app.post("/api/lessons/:eventId/reschedule", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    limiter.hit(`book:${actor.accountId}`, 20, 60 * 60000);
    const input = parse(bookingSchema, req.body);
    const eventId = parse(z.string().min(1).max(100), req.params.eventId);
    const student = await loadStudent(req, input.studentId);
    const event = await rescheduleLesson(needGhl(), actor, student, eventId, input);
    return { id: event.id, startTime: event.startTime ?? input.startTime };
  }));

  app.post("/api/invoices/:invoiceId/send-payment-link", authenticate(), wrap(async (req) => {
    const actor = actorOf(req);
    limiter.hit(`pay:${actor.accountId}`, 5, 15 * 60000);
    const invoiceId = parse(z.string().min(1).max(100), req.params.invoiceId);
    const studentIds = actor.links.filter((l) => l.canPay).map((l) => l.studentId);
    const students = await needStore().store.getStudents(studentIds);
    const { store } = needStore();
    const result = await sendInvoicePaymentLink(needGhl(), students.map((s) => s.billingContactId), invoiceId, (id) => store.lastInvoiceLinkSentAt(id));
    await audit(req, "invoice.link_sent", result.invoiceId);
    return result;
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

  // Financial features exist in the UI only until their backend behavior is reviewed.
  for (const path of ["/api/packages/purchase", "/api/autopay", "/api/referrals/invite", "/api/referrals/apply"]) {
    app.post(path, authenticate(), () => {
      throw new ApiError(501, "feature_not_enabled", "This option isn't switched on yet.");
    });
  }

  // ---- teacher ---------------------------------------------------------------------------------------------
  const teacher = express.Router();
  teacher.use(authenticate(), requireTeacher);

  teacher.get("/students", wrap(async () => {
    const { store } = needStore();
    const [students, counts, accounts] = await Promise.all([store.listStudents(), store.studentCounts(), store.studentAccounts()]);
    let nextByContact: Record<string, string> = {};
    if (deps.ghl) {
      const now = Date.now();
      const events = await deps.ghl.listCalendarEvents(now, now + 45 * 86400000).catch(() => []);
      for (const e of [...events].sort((a, b) => a.startTime.localeCompare(b.startTime))) nextByContact[e.contactId] ??= e.startTime;
    }
    const rows: TeacherStudentRow[] = students.map((s) => ({
      ...publicStudent(s),
      email: s.email,
      ghlContactId: s.ghlContactId,
      billingContactId: s.billingContactId,
      nextLesson: nextByContact[s.ghlContactId] ?? null,
      noteCount: counts[s.id]?.notes ?? 0,
      videoCount: counts[s.id]?.videos ?? 0,
      assignmentCount: counts[s.id]?.assignments ?? 0,
      accountId: accounts[s.id]?.accountId ?? null,
      portalStatus: accounts[s.id]?.status ?? "none",
      transferPending: false,
    }));
    return { students: rows };
  }));

  teacher.get("/ghl/contacts", wrap(async (req) => {
    const query = parse(z.string().trim().max(120).default(""), req.query.query);
    const ghl = needGhl();
    const { store } = needStore();
    const [contacts, students] = await Promise.all([ghl.searchContacts(query), store.listStudents()]);
    const linked = new Map(students.map((s) => [s.ghlContactId, s.fullName]));
    return { contacts: contacts.map((c) => ({ ...c, studentName: linked.get(c.id) ?? null })) };
  }));
  teacher.post("/students", wrap(async (req) => {
    const input = parseNewStudent(req.body);
    const ghl = needGhl();
    const { store } = needStore();
    await store.checkStudentSchema();
    const roster = await store.listStudents();
    if (input.email && roster.some((s) => (s.email ?? "").toLowerCase() === input.email)) {
      throw new ApiError(409, "student_already_exists", studentFormMessages.duplicateEmail);
    }
    const details = {
      fullName: input.fullName,
      isMinor: input.isMinor,
      email: input.email,
      guardianName: input.guardianName,
      guardianEmail: input.guardianEmail,
      format: input.format,
    };
    let linked: { ghlContactId: string; billingContactId: string; createdContactIds: string[]; contacts?: Record<string, string> };
    if (input.ghlContactId) {
      linked = { ghlContactId: input.ghlContactId, billingContactId: input.billingContactId ?? input.ghlContactId, createdContactIds: [] };
      // Bookings and the balance check rely on these, so both must be real contacts.
      for (const id of new Set([linked.ghlContactId, linked.billingContactId])) {
        await ghl.getContact(id).catch((e) => {
          if (e instanceof ApiError && e.status === 404) throw new ApiError(400, "contact_not_found", "That GoHighLevel contact wasn't found.");
          throw e;
        });
      }
    } else {
      linked = await resolveStudentContacts(ghl, roster, details);
    }
    let student;
    try {
      student = await store.createStudent({ ...details, ghlContactId: linked.ghlContactId, billingContactId: linked.billingContactId });
    } catch (e) {
      // A failed insert must not leave contacts this request created. Reused contacts stay.
      if (linked.createdContactIds.length) {
        for (const id of linked.createdContactIds) {
          try {
            await ghl.deleteContact(id);
          } catch {
            console.error(`[ghl] could not remove contact ${id} after the student record failed to save`);
          }
        }
        await audit(req, "student.create_failed", "", { createdContactIds: linked.createdContactIds }).catch(() => undefined);
      }
      throw e;
    }
    if (!student) throw new ApiError(409, "contact_already_linked", "That GoHighLevel contact is already linked to a student.");
    await audit(req, "student.create", student.id);
    return { student: { id: student.id, fullName: student.fullName }, contacts: linked.contacts ?? null };
  }));
  teacher.get("/students/:id", wrap(async (req) => {
    const student = await loadStudent(req, parse(uuid, req.params.id));
    const { store } = needStore();
    const [notes, videos, assignments] = await Promise.all([
      store.listNotes(student.id, { publishedOnly: false }),
      store.listAssignedVideos(student.id),
      store.listAssignments(student.id),
    ]);
    let lessons: LessonDTO[] | null = null;
    let billing: BillingDTO | null = null;
    if (deps.ghl) {
      const ghl = deps.ghl;
      [lessons, billing] = await Promise.all([
        ghl.getContactAppointments(student.ghlContactId).then((ev) => ev.filter((e) => e.calendarId === ghl.config.lessonCalendarId).map((e) => toLessonDTO(e, student.id))).catch(() => null),
        getBilling(ghl, student.billingContactId).catch(() => null),
      ]);
    }
    return { student: publicStudent(student), notes, videos, assignments, lessons, billing };
  }));

  teacher.get("/overview", wrap(async () => {
    const { store } = needStore();
    const [students, recentNotes, recentVideos, invitations] = await Promise.all([store.listStudents(), store.recentNotes(3), store.recentAssignedVideos(3), store.listInvitations()]);
    return { studentCount: students.length, adultCount: students.filter((s) => !s.isMinor).length, recentNotes, recentVideos, invitations };
  }));

  teacher.get("/calendar", wrap(async (req) => {
    const q = parse(z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }), req.query);
    if (q.to <= q.from || q.to - q.from > 31 * 86400000) throw new ApiError(400, "invalid_input", "That date range isn't valid.");
    const ghl = needGhl();
    const [events, students] = await Promise.all([ghl.listCalendarEvents(q.from, q.to), needStore().store.listStudents()]);
    const byContact = new Map(students.map((s) => [s.ghlContactId, s]));
    return {
      events: events.map((e) => ({
        id: e.id,
        startTime: e.startTime,
        endTime: e.endTime,
        title: e.title ?? "",
        address: e.address ?? "",
        status: e.appointmentStatus ?? "",
        studentId: byContact.get(e.contactId)?.id ?? null,
        studentName: byContact.get(e.contactId)?.fullName ?? e.title ?? "",
      })),
    };
  }));

  teacher.get("/invoices", wrap(async () => {
    const ghl = needGhl();
    const page = await ghl.listInvoices({ limit: 100, offset: 0 });
    return { invoices: page.invoices.map(toInvoiceDTO), total: page.total };
  }));

  // Invoice actions change live GoHighLevel records, so they stay off. "Paid" is only ever what GoHighLevel reports.
  for (const action of ["send", "remind", "void", "mark-paid"]) {
    teacher.post(`/invoices/:id/${action}`, () => {
      throw new ApiError(501, "feature_not_enabled", "Manage this invoice in GoHighLevel for now.");
    });
  }

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
  teacher.post("/invitations", wrap(async (req) => {
    const input = parse(inviteSchema, req.body);
    const { store, auth } = needStore();
    const students = await store.getStudents(input.studentIds);
    if (students.length !== input.studentIds.length) throw notFound("That student wasn't found.");
    const credential = input.method === "code" ? newEnrollmentCode() : newInviteToken();
    const inviteUrl = input.method === "email" ? portalInviteRedirect(config.appUrl, credential) : undefined;
    if (input.method === "email") assertPortalInviteEmail(config.safeMode, input.email, config.safeModeEmailAllowlist);
    const first = students[0];
    const invite = await store.createInvitation({
      tokenHash: hashCredential(credential),
      method: input.method,
      email: input.email,
      name: input.name,
      role: input.role,
      studentIds: input.studentIds,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      preview: {
        firstName: input.name.split(/\s+/)[0],
        studentLine: students.map((s) => s.fullName).join(", "),
        accountFor: `${input.name} · ${input.role === "guardian" ? "parent" : "student"}`,
        lessons: first.styleLine,
        format: first.format,
      },
    });
    let emailed = false;
    if (inviteUrl) {
      try {
        const authUserId = await auth.sendPortalInvite(input.email, inviteUrl);
        if (authUserId) await store.attachInvitationAuthUser(invite.id, authUserId).catch(() => undefined);
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
      credential,
      emailed,
      inviteUrl,
    };
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

  teacher.get("/settings", wrap(async () => ({ integrations: { supabase: !!deps.store, ghl: !!deps.ghl, storage: !!deps.store } })));

  app.use("/api/teacher", teacher);

  app.use("/api", (_req, _res, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}

function publicStudent(s: StudentRecord) {
  // Contact IDs stay on the server. The browser never needs them and never gets to supply them.
  const { ghlContactId: _c, billingContactId: _b, ...rest } = s;
  return rest;
}

export { isOutstanding, OUTSTANDING_BALANCE_MESSAGE };
