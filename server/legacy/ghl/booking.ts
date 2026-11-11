// LEGACY. Kept for migrating old GoHighLevel records. The portal never imports this at runtime; see README.md.
import { z } from "zod";
import { OUTSTANDING_BALANCE_MESSAGE } from "../../../shared/portal-types.js";
import { ApiError, forbidden } from "../../http.js";
import type { GhlClient } from "./client.js";
import { canBookFor, type Actor } from "../../auth/policy.js";
import type { StudentRecord } from "../../store/types.js";
import { getBilling } from "./billing.js";

export const LESSON_MINUTES = 60;
const RESCHEDULE_CUTOFF_MS = 24 * 3600 * 1000;

export const LOCATIONS = { "Music City SF": "Music City SF, Room 4, 1353 Bush St", Zoom: "Zoom" } as const;
export const RECURRING_WEEKS = 8;

export const bookingSchema = z.object({
  studentId: z.string().uuid(),
  startTime: z.string().datetime({ offset: true }),
  location: z.enum(["Music City SF", "Zoom"]),
  repeatWeekly: z.boolean().optional(),
});

const instant = (iso: string) => new Date(iso).getTime();

async function assertSlotOpen(ghl: GhlClient, startTime: string) {
  const t = instant(startTime);
  if (!(t > Date.now())) throw new ApiError(409, "slot_unavailable", "That time has passed. Please choose another.");
  const days = await ghl.getFreeSlots(t - 86400000, t + 86400000);
  const open = Object.values(days).flat().some((s) => instant(s) === t);
  if (!open) throw new ApiError(409, "slot_unavailable", "That time was just taken. Please choose another.");
}

/**
 * The server-side booking gate. The balance is read live from GoHighLevel right before the appointment is
 * created. If it can't be read the call throws and nothing is booked.
 */
export async function createLessonBooking(
  ghl: GhlClient,
  actor: Actor,
  student: StudentRecord,
  input: { startTime: string; location: keyof typeof LOCATIONS },
) {
  if (!canBookFor(actor, student.id)) throw forbidden("This account can't book lessons for this student.");
  const billing = await getBilling(ghl, student.billingContactId!);
  if (billing.bookingBlocked) throw new ApiError(402, "outstanding_balance", OUTSTANDING_BALANCE_MESSAGE);
  await assertSlotOpen(ghl, input.startTime);
  const endTime = new Date(instant(input.startTime) + LESSON_MINUTES * 60000).toISOString();
  return ghl.createAppointment({
    contactId: student.ghlContactId!,
    startTime: input.startTime,
    endTime,
    title: `Lesson: ${student.fullName}`,
    address: LOCATIONS[input.location],
  });
}

/** Eight weekly lessons. The GoHighLevel client sets toNotify false while safe mode is on. */
export async function createWeeklyLessons(
  ghl: GhlClient,
  actor: Actor,
  student: StudentRecord,
  input: { startTime: string; location: keyof typeof LOCATIONS },
) {
  if (ghl.config.safeMode !== true) throw new ApiError(501, "feature_not_enabled", "Weekly lessons are only booked when safe mode is on, so nobody is notified.");
  if (!canBookFor(actor, student.id)) throw forbidden("This account can't book lessons for this student.");
  const billing = await getBilling(ghl, student.billingContactId!);
  if (billing.bookingBlocked) throw new ApiError(402, "outstanding_balance", OUTSTANDING_BALANCE_MESSAGE);
  await assertSlotOpen(ghl, input.startTime);
  const events: Awaited<ReturnType<GhlClient["createAppointment"]>>[] = [];
  for (let week = 0; week < RECURRING_WEEKS; week++) {
    const startMs = instant(input.startTime) + week * 7 * 86400000;
    const startTime = new Date(startMs).toISOString();
    const endTime = new Date(startMs + LESSON_MINUTES * 60000).toISOString();
    events.push(await ghl.createAppointment({
      contactId: student.ghlContactId!,
      startTime,
      endTime,
      title: `Lesson: ${student.fullName}`,
      address: LOCATIONS[input.location],
    }));
  }
  return events;
}

export async function rescheduleLesson(
  ghl: GhlClient,
  actor: Actor,
  student: StudentRecord,
  eventId: string,
  input: { startTime: string; location: keyof typeof LOCATIONS },
) {
  if (!canBookFor(actor, student.id)) throw forbidden("This account can't change lessons for this student.");
  const current = await ghl.getAppointment(eventId);
  // The appointment must belong to this student, on the lesson calendar. Client-supplied IDs prove nothing.
  if (current.contactId !== student.ghlContactId || current.calendarId !== ghl.config.lessonCalendarId) throw forbidden();
  if (!(instant(current.startTime) > Date.now())) {
    throw new ApiError(409, "lesson_past", "That lesson has already happened. Book a new one instead.");
  }
  if (instant(current.startTime) - Date.now() <= RESCHEDULE_CUTOFF_MS) {
    throw new ApiError(409, "reschedule_closed", "Reschedules close 24 hours before a lesson. Contact Zane if something urgent comes up.");
  }
  await assertSlotOpen(ghl, input.startTime);
  const endTime = new Date(instant(input.startTime) + LESSON_MINUTES * 60000).toISOString();
  return ghl.updateAppointment(eventId, { startTime: input.startTime, endTime, address: LOCATIONS[input.location] });
}
