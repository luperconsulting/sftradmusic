// Lessons and bookings, read from and written to Supabase. No calendar service is called and nobody is notified.
import { z } from "zod";
import type { LessonDTO } from "../../shared/portal-types.js";
import { ApiError, notFound } from "../http.js";
import type { LessonRecord, PortalStore, StudentRecord } from "../store/types.js";

export const LESSON_MINUTES = 60;
export const LOCATIONS = { "Music City SF": "Music City SF, Room 4, 1353 Bush St", Zoom: "Zoom" } as const;

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
  };
}

/** Upcoming: scheduled lessons from now on, soonest first. History: everything already started, newest first. */
export function splitLessons(lessons: LessonRecord[], now = Date.now()) {
  const dtos = [...lessons].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map(toLessonDTO);
  return {
    upcoming: dtos.filter((l) => new Date(l.startTime).getTime() >= now && l.status === "confirmed"),
    history: dtos.filter((l) => new Date(l.startTime).getTime() < now && l.status !== "rescheduled").reverse(),
  };
}

export const teacherLessonSchema = z.object({
  studentId: z.string().uuid(),
  startTime: z.string().datetime({ offset: true }),
  minutes: z.number().int().min(15).max(240).default(LESSON_MINUTES),
  location: z.enum(["Music City SF", "Zoom"]),
  zoomUrl: z.string().url().refine((u) => u.startsWith("https://"), "unsupported").nullable().optional(),
});

const overlaps = (a: { startsAt: string; endsAt: string }, startMs: number, endMs: number) =>
  new Date(a.startsAt).getTime() < endMs && new Date(a.endsAt).getTime() > startMs;

async function assertTeacherFree(store: PortalStore, teacherAccountId: string | null, startMs: number, endMs: number, ignoreId?: string) {
  if (!teacherAccountId) return;
  const day = 86400000;
  const nearby = await store.listLessons({ teacherAccountId, from: new Date(startMs - day).toISOString(), to: new Date(endMs + day).toISOString() });
  if (nearby.some((l) => l.id !== ignoreId && l.status === "scheduled" && overlaps(l, startMs, endMs))) {
    throw new ApiError(409, "slot_unavailable", "Another lesson is already booked at that time.");
  }
}

function lessonTimes(input: { startTime: string; minutes: number }) {
  const startMs = new Date(input.startTime).getTime();
  return { startMs, endMs: startMs + input.minutes * 60000 };
}

/** The teacher books a lesson for one of their students. */
export async function createTeacherLesson(store: PortalStore, student: StudentRecord, input: z.infer<typeof teacherLessonSchema>, actorAccountId: string) {
  const { startMs, endMs } = lessonTimes(input);
  const teacherAccountId = student.teacherAccountId ?? actorAccountId;
  await assertTeacherFree(store, teacherAccountId, startMs, endMs);
  const zoom = input.location === "Zoom";
  const lesson = await store.createLesson({
    studentId: student.id,
    teacherAccountId,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    locationKind: zoom ? "zoom" : "in_person",
    location: LOCATIONS[input.location],
    zoomUrl: zoom ? input.zoomUrl ?? null : null,
    createdByAccountId: actorAccountId,
    source: "teacher",
  });
  return toLessonDTO(lesson);
}

async function openLesson(store: PortalStore, lessonId: string) {
  const lesson = await store.getLesson(lessonId);
  if (!lesson) throw notFound("That lesson wasn't found.");
  if (lesson.status !== "scheduled") throw new ApiError(409, "lesson_closed", "That lesson is no longer scheduled.");
  return lesson;
}

/** Moves a lesson: the old one is marked rescheduled and a new one points back to it. */
export async function rescheduleTeacherLesson(store: PortalStore, lessonId: string, input: { startTime: string; minutes?: number; location?: keyof typeof LOCATIONS }, actorAccountId: string) {
  const current = await openLesson(store, lessonId);
  const minutes = input.minutes ?? Math.round((new Date(current.endsAt).getTime() - new Date(current.startsAt).getTime()) / 60000);
  const { startMs, endMs } = lessonTimes({ startTime: input.startTime, minutes });
  await assertTeacherFree(store, current.teacherAccountId, startMs, endMs, current.id);
  const zoom = input.location ? input.location === "Zoom" : current.locationKind === "zoom";
  const next = await store.createLesson({
    studentId: current.studentId,
    teacherAccountId: current.teacherAccountId,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    locationKind: zoom ? "zoom" : "in_person",
    location: input.location ? LOCATIONS[input.location] : current.location,
    zoomUrl: zoom ? current.zoomUrl : null,
    createdByAccountId: actorAccountId,
    source: "teacher",
    rescheduledFromId: current.id,
  });
  await store.closeLesson(current.id, { status: "rescheduled", byAccountId: actorAccountId, reason: null });
  return toLessonDTO(next);
}

export async function cancelLesson(store: PortalStore, lessonId: string, reason: string | null, actorAccountId: string) {
  await openLesson(store, lessonId);
  return toLessonDTO(await store.closeLesson(lessonId, { status: "cancelled", byAccountId: actorAccountId, reason }));
}
