// Lessons and bookings in Supabase. Lessons are 60 minutes. Open times are the teacher's weekly hours minus
// Google Calendar busy times minus live lessons. A lesson is paid by a package credit, or it is held as
// "pending payment" with its own $100 invoice until the teacher marks that invoice paid. Unpaid holds are
// released after the teacher's hold window or at the lesson start, whichever is first.
import { z } from "zod";
import type { LessonDTO } from "../../shared/portal-types.js";
import { LESSON_MINUTES, OUTSTANDING_MESSAGE_HOLD, SERIES_WEEKS_DEFAULT, SERIES_WEEKS_MAX } from "../../shared/pricing.js";
import { OUTSTANDING_BALANCE_MESSAGE } from "../../shared/portal-types.js";
import { ApiError, forbidden, notFound } from "../http.js";
import { availabilityUnavailable } from "../integrations/googleCalendar.js";
import type { LessonRecord, StudentRecord } from "../store/types.js";
import { bookingDate, fitsLessonHours, isLive, openSlots } from "./availability.js";
import { amountDueCents, sessionInvoice, voidInvoice } from "./billing.js";
import { teacherFor, type PortalContext } from "./context.js";
import { notify } from "./notify.js";

/** Lesson starts are offered every half hour inside the weekly hours. */
export const LESSON_STEP_MINUTES = 30;
export const LOCATIONS = { "Music City SF": "Music City SF, Room 4, 1353 Bush St", Zoom: "Zoom" } as const;
const HOUR = 3600000;
const DAY = 24 * HOUR;

export function toLessonDTO(l: LessonRecord): LessonDTO {
  const isZoom = l.locationKind === "zoom";
  return {
    id: l.id,
    studentId: l.studentId,
    startTime: new Date(l.startsAt).toISOString(),
    endTime: new Date(l.endsAt).toISOString(),
    // The UI's existing wording: a scheduled lesson shows as confirmed.
    status: l.status === "scheduled" ? "confirmed" : l.status === "no_show" ? "noshow" : l.status,
    isZoom,
    locationLabel: isZoom ? "Zoom" : "Music City SF",
    locationSub: isZoom ? "Link opens 5 minutes before" : "Room 4, 1353 Bush St",
    rescheduledFromId: l.rescheduledFromId,
    holdExpiresAt: l.holdExpiresAt,
    invoiceId: l.invoiceId,
    lateCancel: l.lateCancel,
  };
}

/** Upcoming: confirmed or held lessons from now on, soonest first. History: past lessons, newest first. */
export function splitLessons(lessons: LessonRecord[], now = Date.now()) {
  const dtos = [...lessons].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map(toLessonDTO);
  return {
    upcoming: dtos.filter((l) => new Date(l.startTime).getTime() >= now && (l.status === "confirmed" || l.status === "pending_payment")),
    history: dtos.filter((l) => new Date(l.startTime).getTime() < now && l.status !== "rescheduled" && l.status !== "released" && l.status !== "pending_payment").reverse(),
  };
}

/**
 * Releases every held lesson whose hold ran out and voids its unpaid invoice. Called before anything reads or
 * books lessons, so holds release on time without a scheduler.
 */
export async function releaseExpiredHolds(ctx: PortalContext) {
  const expired = await ctx.store.listExpiredHolds(new Date(ctx.now()).toISOString());
  for (const lesson of expired) {
    await ctx.store.closeLesson(lesson.id, { status: "released", byAccountId: null, reason: "Payment not received in time" });
    if (lesson.invoiceId) {
      const invoice = await ctx.store.getInvoice(lesson.invoiceId);
      const others = (await ctx.store.listLessonsByInvoice(lesson.invoiceId)).filter((l) => l.id !== lesson.id && isLive(l));
      if (invoice && invoice.amountPaidCents === 0 && invoice.status === "sent" && others.length === 0) await voidInvoice(ctx, invoice.id, { releaseLessons: false });
    }
  }
  return expired.length;
}

/** An unpaid balance or an unpaid session hold blocks new bookings. */
export async function assertCanBookNew(ctx: PortalContext, studentId: string) {
  const invoices = await ctx.store.listInvoices({ studentIds: [studentId], includeDrafts: false });
  const holds = await ctx.store.listLessons({ studentIds: [studentId], statuses: ["pending_payment"] });
  if (holds.length) throw new ApiError(402, "unpaid_hold", OUTSTANDING_MESSAGE_HOLD);
  if (invoices.some((i) => (i.status === "sent" || i.status === "partially_paid") && amountDueCents(i) > 0)) {
    throw new ApiError(402, "outstanding_balance", OUTSTANDING_BALANCE_MESSAGE);
  }
}

async function busyBetween(ctx: PortalContext, fromMs: number, toMs: number) {
  if (!ctx.google) throw availabilityUnavailable();
  return ctx.google.busy(fromMs, toMs);
}

/** Open 60-minute lesson starts for a teacher between two dates (inclusive). */
export async function lessonSlots(ctx: PortalContext, teacherAccountId: string, fromDate: string, toDate: string, opts: { durationMinutes?: number; stepMinutes?: number } = {}) {
  const duration = opts.durationMinutes ?? LESSON_MINUTES;
  const hours = await ctx.store.listLessonHours(teacherAccountId);
  if (!hours.length) return {};
  const fromMs = new Date(`${fromDate}T00:00:00Z`).getTime() - DAY;
  const toMs = new Date(`${toDate}T23:59:59Z`).getTime() + DAY;
  const [busy, lessons] = await Promise.all([
    busyBetween(ctx, fromMs, toMs),
    ctx.store.listLessons({ teacherAccountId, from: new Date(fromMs - DAY).toISOString(), to: new Date(toMs).toISOString() }),
  ]);
  return openSlots({ hours, fromDate, toDate, busy, lessons, durationMinutes: duration, stepMinutes: opts.stepMinutes ?? LESSON_STEP_MINUTES, now: ctx.now() });
}

/** Server-side check that each start is an open slot right now. Throws 409 naming the first one that isn't. */
async function assertSlotsOpen(ctx: PortalContext, teacherAccountId: string, starts: number[], ignoreLessonId?: string) {
  const hours = await ctx.store.listLessonHours(teacherAccountId);
  const first = Math.min(...starts), last = Math.max(...starts) + LESSON_MINUTES * 60000;
  const [busy, lessons] = await Promise.all([
    busyBetween(ctx, first, last),
    ctx.store.listLessons({ teacherAccountId, from: new Date(first - DAY).toISOString(), to: new Date(last).toISOString() }),
  ]);
  const live = lessons.filter((l) => isLive(l) && l.id !== ignoreLessonId);
  for (const start of starts) {
    const end = start + LESSON_MINUTES * 60000;
    const label = bookingDate(start);
    if (!(start > ctx.now())) throw new ApiError(409, "slot_unavailable", "That time has passed. Please choose another.");
    if (!fitsLessonHours(hours, start, LESSON_MINUTES, LESSON_STEP_MINUTES)) throw new ApiError(409, "slot_unavailable", `${label} isn't inside lesson hours. Please choose another time.`);
    if (busy.some((b) => b.start < end && start < b.end)) throw new ApiError(409, "slot_unavailable", `${label} at that time is busy. Please choose another time.`);
    if (live.some((l) => Date.parse(l.startsAt) < end && start < Date.parse(l.endsAt))) throw new ApiError(409, "slot_unavailable", `${label} at that time was just taken. Please choose another time.`);
  }
}

export const portalBookingSchema = z.object({
  studentId: z.string().uuid(),
  startTime: z.string().datetime({ offset: true }),
  location: z.enum(["Music City SF", "Zoom"]),
  repeatWeekly: z.boolean().optional(),
  weeks: z.number().int().min(2).max(SERIES_WEEKS_MAX).optional(),
});

/**
 * Books one lesson, or the same slot weekly as a series. Every occurrence is checked first; if one isn't open,
 * nothing is booked. Each lesson uses a credit if one is left, otherwise it is held with its own $100 invoice.
 */
export async function bookLessons(ctx: PortalContext, input: {
  student: StudentRecord;
  startTime: string;
  location: keyof typeof LOCATIONS;
  weeks: number;
  actorAccountId: string;
  source: "portal" | "teacher";
}) {
  const { store } = ctx;
  const teacherAccountId = await teacherFor(store, input.student);
  if (!teacherAccountId) throw new ApiError(503, "no_teacher", "No teacher is set up for lessons yet.");
  const first = Date.parse(input.startTime);
  const starts = Array.from({ length: input.weeks }, (_, i) => first + i * 7 * DAY);
  if (input.source === "portal") await assertSlotsOpen(ctx, teacherAccountId, starts);
  else await assertNoOverlap(ctx, teacherAccountId, starts);
  const settings = await store.getSettings(teacherAccountId);
  let credits = (await store.creditBalances([input.student.id]))[input.student.id] ?? 0;
  const seriesId = input.weeks > 1 ? await store.createSeries({ studentId: input.student.id, teacherAccountId, createdByAccountId: input.actorAccountId }) : null;
  const zoom = input.location === "Zoom";
  const booked: LessonRecord[] = [];
  const invoices: string[] = [];
  for (const start of starts) {
    const startsAt = new Date(start).toISOString();
    const base = {
      studentId: input.student.id, teacherAccountId, startsAt, endsAt: new Date(start + LESSON_MINUTES * 60000).toISOString(),
      locationKind: zoom ? "zoom" as const : "in_person" as const, location: LOCATIONS[input.location], zoomUrl: null,
      createdByAccountId: input.actorAccountId, source: input.source, seriesId,
    };
    if (credits > 0) {
      const lesson = await store.createLesson({ ...base, status: "scheduled" });
      await store.addCredit({ studentId: input.student.id, delta: -1, reason: "lesson_booked", lessonId: lesson.id, byAccountId: input.actorAccountId });
      credits--;
      booked.push(lesson);
      continue;
    }
    // No credit: a $100 invoice. A family's booking is held until it's paid; a teacher's booking is confirmed.
    const hold = input.source === "portal" ? new Date(Math.min(ctx.now() + settings.holdWindowMinutes * 60000, start)).toISOString() : null;
    const lesson = await store.createLesson({ ...base, status: hold ? "pending_payment" : "scheduled", holdExpiresAt: hold });
    const invoice = await sessionInvoice(ctx, input.student, lesson.id, `60-min lesson · ${bookingDate(start)}`, input.actorAccountId);
    invoices.push(invoice.id);
    // A $0 invoice (covered by referral credit) was settled at once, which already confirmed nothing yet linked.
    const linked = await store.updateLesson(lesson.id, { invoiceId: invoice.id, ...(invoice.status === "paid" && hold ? { status: "scheduled", holdExpiresAt: null } : {}) });
    booked.push(linked);
  }
  const held = booked.filter((l) => l.status === "pending_payment");
  await notify.lesson(ctx, "booked", input.student, booked, held.length
    ? [`${held.length === 1 ? "This lesson is" : `${held.length} lessons are`} held until payment arrives. Unpaid holds are released ${settings.holdWindowMinutes >= 60 ? `${Math.round(settings.holdWindowMinutes / 60)} hours` : `${settings.holdWindowMinutes} minutes`} after booking, or when the lesson starts.`]
    : []);
  return { lessons: booked.map(toLessonDTO), invoiceIds: invoices, seriesId };
}

async function assertNoOverlap(ctx: PortalContext, teacherAccountId: string, starts: number[], ignoreLessonId?: string) {
  const first = Math.min(...starts), last = Math.max(...starts) + LESSON_MINUTES * 60000;
  const lessons = await ctx.store.listLessons({ teacherAccountId, from: new Date(first - DAY).toISOString(), to: new Date(last).toISOString() });
  for (const start of starts) {
    const end = start + LESSON_MINUTES * 60000;
    if (lessons.some((l) => l.id !== ignoreLessonId && isLive(l) && Date.parse(l.startsAt) < end && start < Date.parse(l.endsAt))) {
      throw new ApiError(409, "slot_unavailable", "Another lesson is already booked at that time.");
    }
  }
}

async function liveLesson(ctx: PortalContext, lessonId: string) {
  const lesson = await ctx.store.getLesson(lessonId);
  if (!lesson) throw notFound("That lesson wasn't found.");
  if (!isLive(lesson)) throw new ApiError(409, "lesson_closed", "That lesson is no longer scheduled.");
  return lesson;
}

export const rescheduleSchema = z.object({
  startTime: z.string().datetime({ offset: true }),
  location: z.enum(["Music City SF", "Zoom"]).optional(),
});

/**
 * Moves a lesson to another open 60-minute slot. The old lesson becomes "rescheduled" and the new one points back
 * to it, keeping its credit or invoice. Families must respect the teacher's notice window.
 */
export async function rescheduleLesson(ctx: PortalContext, input: { lessonId: string; startTime: string; location?: keyof typeof LOCATIONS; actorAccountId: string; byTeacher: boolean; student: StudentRecord }) {
  const { store } = ctx;
  const current = await liveLesson(ctx, input.lessonId);
  if (current.studentId !== input.student.id) throw forbidden();
  const teacherAccountId = current.teacherAccountId ?? (await teacherFor(store, input.student));
  if (!teacherAccountId) throw new ApiError(503, "no_teacher", "No teacher is set up for lessons yet.");
  const start = Date.parse(input.startTime);
  if (!input.byTeacher) {
    const settings = await store.getSettings(teacherAccountId);
    if (Date.parse(current.startsAt) <= ctx.now()) throw new ApiError(409, "lesson_past", "That lesson has already started. Book a new one instead.");
    if (Date.parse(current.startsAt) - ctx.now() < settings.rescheduleNoticeHours * HOUR) {
      throw new ApiError(409, "reschedule_closed", `Reschedules close ${settings.rescheduleNoticeHours} hours before a lesson. Please contact Zane.`);
    }
    await assertSlotsOpen(ctx, teacherAccountId, [start], current.id);
  } else {
    await assertNoOverlap(ctx, teacherAccountId, [start], current.id);
  }
  const zoom = input.location ? input.location === "Zoom" : current.locationKind === "zoom";
  // Close the old lesson first so the exclusion constraint allows a move that overlaps its own old time.
  await store.closeLesson(current.id, { status: "rescheduled", byAccountId: input.actorAccountId, reason: null });
  try {
    const hold = current.status === "pending_payment" ? new Date(Math.min(Date.parse(current.holdExpiresAt!), start)).toISOString() : null;
    const next = await store.createLesson({
      studentId: current.studentId, teacherAccountId, startsAt: new Date(start).toISOString(), endsAt: new Date(start + LESSON_MINUTES * 60000).toISOString(),
      locationKind: zoom ? "zoom" : "in_person", location: input.location ? LOCATIONS[input.location] : current.location, zoomUrl: zoom ? current.zoomUrl : null,
      createdByAccountId: input.actorAccountId, source: input.byTeacher ? "teacher" : "portal", rescheduledFromId: current.id,
      status: hold ? "pending_payment" : "scheduled", holdExpiresAt: hold, invoiceId: current.invoiceId, seriesId: current.seriesId,
    });
    await notify.lesson(ctx, "rescheduled", input.student, [next]);
    return toLessonDTO(next);
  } catch (e) {
    await store.updateLesson(current.id, { status: current.status as "scheduled" | "pending_payment", holdExpiresAt: current.holdExpiresAt });
    throw e;
  }
}

/**
 * Cancels a lesson. With enough notice (or by the teacher) a used credit comes back and an unpaid session invoice
 * is voided; a paid session becomes a credit. A late family cancel keeps the credit used or the charge owed.
 */
export async function cancelLesson(ctx: PortalContext, input: { lessonId: string; reason: string | null; actorAccountId: string; byTeacher: boolean; student: StudentRecord }) {
  const { store } = ctx;
  const current = await liveLesson(ctx, input.lessonId);
  if (current.studentId !== input.student.id) throw forbidden();
  const teacherAccountId = current.teacherAccountId ?? (await teacherFor(store, input.student));
  const settings = teacherAccountId ? await store.getSettings(teacherAccountId) : null;
  const late = !input.byTeacher && !!settings && Date.parse(current.startsAt) - ctx.now() < settings.cancelNoticeHours * HOUR;
  const closed = await store.closeLesson(current.id, { status: "cancelled", byAccountId: input.actorAccountId, reason: input.reason, lateCancel: late });
  let refund: "credit" | "invoice_voided" | "none" = "none";
  if (!late) {
    if (!current.invoiceId) {
      if (await store.addCredit({ studentId: current.studentId, delta: 1, reason: "lesson_refund", lessonId: current.id, byAccountId: input.actorAccountId })) refund = "credit";
    } else {
      const invoice = await store.getInvoice(current.invoiceId);
      if (invoice?.status === "paid") {
        if (await store.addCredit({ studentId: current.studentId, delta: 1, reason: "lesson_refund", lessonId: current.id, byAccountId: input.actorAccountId })) refund = "credit";
      } else if (invoice && invoice.amountPaidCents === 0 && invoice.status !== "void") {
        await voidInvoice(ctx, invoice.id, { releaseLessons: false });
        refund = "invoice_voided";
      }
    }
  }
  await notify.lesson(ctx, "cancelled", input.student, [closed], late
    ? [`This was inside the ${settings?.cancelNoticeHours ?? 24}-hour notice window, so the lesson is still charged.`]
    : refund === "credit" ? ["A lesson credit was returned to your account."] : []);
  return { lesson: toLessonDTO(closed), late, refund };
}

export const teacherLessonSchema = z.object({
  studentId: z.string().uuid(),
  startTime: z.string().datetime({ offset: true }),
  location: z.enum(["Music City SF", "Zoom"]),
});

export const weeksFor = (input: { repeatWeekly?: boolean; weeks?: number }) => (input.repeatWeekly ? input.weeks ?? SERIES_WEEKS_DEFAULT : 1);
