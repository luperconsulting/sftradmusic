import { createClient } from "@supabase/supabase-js";
import { ARZO_EMAIL, ARZO_GHL_CONTACT_ID } from "./arzoFixture.js";
import { buildArzoSeed, PORTAL_TEST, seedGuard, type ArzoSeed } from "./arzoSeed.js";

const GHL = "https://services.leadconnectorhq.com";

function client(env: Record<string, string | undefined>) {
  return createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function findArzo(env: Record<string, string | undefined>) {
  const db = client(env);
  const byEmail = await db.from("students").select("id,email,ghl_contact_id").eq("email", ARZO_EMAIL).maybeSingle();
  const byContact = await db.from("students").select("id,email,ghl_contact_id").eq("ghl_contact_id", ARZO_GHL_CONTACT_ID).maybeSingle();
  if (byEmail.error) throw new Error(byEmail.error.message);
  if (byContact.error) throw new Error(byContact.error.message);
  const row = byEmail.data ?? byContact.data;
  if (!row) return null;
  if (row.email && row.email !== ARZO_EMAIL) throw new Error("Refusing to touch a student whose email is not luperdev@gmail.com.");
  if (row.ghl_contact_id && row.ghl_contact_id !== ARZO_GHL_CONTACT_ID) throw new Error("Refusing to change Arzo's GoHighLevel contact id.");
  return row.id as string;
}

async function ghl(env: Record<string, string | undefined>, path: string, init: RequestInit = {}) {
  const res = await fetch(GHL + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GHL_PRIVATE_INTEGRATION_TOKEN}`,
      Version: "2021-04-15",
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) throw new Error(`GoHighLevel ${init.method || "GET"} ${path.split("?")[0]} returned ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function replaceLessons(env: Record<string, string | undefined>, seed: ArzoSeed, create: boolean) {
  const from = Date.now() - 30 * 86400000;
  const to = Date.now() + 30 * 86400000;
  const q = new URLSearchParams({ locationId: env.GHL_LOCATION_ID!, calendarId: env.GHL_LESSON_CALENDAR_ID!, startTime: String(from), endTime: String(to) });
  const data = await ghl(env, `/calendars/events?${q}`);
  for (const event of data.events ?? []) {
    if (event.contactId !== ARZO_GHL_CONTACT_ID) continue;
    if (!String(event.title ?? "").startsWith(`${PORTAL_TEST}:`)) continue;
    await ghl(env, `/calendars/events/${encodeURIComponent(event.id)}`, { method: "DELETE" });
  }
  if (!create) return;
  for (const lesson of seed.lessons) {
    await ghl(env, "/calendars/events/appointments", {
      method: "POST",
      body: JSON.stringify({
        calendarId: env.GHL_LESSON_CALENDAR_ID,
        locationId: env.GHL_LOCATION_ID,
        contactId: ARZO_GHL_CONTACT_ID,
        startTime: lesson.start,
        endTime: lesson.end,
        title: lesson.title,
        address: lesson.address,
        appointmentStatus: "confirmed",
        toNotify: false,
      }),
    });
  }
}

export async function runArzoSeed(env: Record<string, string | undefined>, mode: "seed" | "cleanup") {
  const guard = seedGuard(env);
  if (!guard.ok) return guard;
  const studentId = await findArzo(env);
  if (!studentId) {
    return { ok: false as const, missing: [] as string[], blocked: `No students row for ${ARZO_EMAIL} (${ARZO_GHL_CONTACT_ID}). This script will not create a login or send email.` };
  }
  const db = client(env);
  const seed = buildArzoSeed();
  const bucket = env.SUPABASE_VIDEO_BUCKET || "lesson-videos";
  if (mode === "seed") {
    const profile = await db.from("students").update({
      full_name: seed.profile.fullName,
      first_name: seed.profile.firstName,
      email: seed.profile.email,
      is_minor: false,
      guardian_name: null,
      guardian_email: null,
      format: seed.profile.format,
      style_line: seed.profile.styleLine,
      student_since: seed.profile.studentSince,
    }).eq("id", studentId).eq("email", ARZO_EMAIL);
    if (profile.error) throw new Error(profile.error.message);
  }
  await db.from("lesson_notes").delete().eq("student_id", studentId).like("title", `${PORTAL_TEST}:%`);
  const taggedVideos = await db.from("videos").select("id,storage_path").like("storage_path", "portal-test/arzo/%");
  if (taggedVideos.error) throw new Error(taggedVideos.error.message);
  const videoIds = (taggedVideos.data ?? []).map((v) => v.id);
  if (videoIds.length) await db.from("video_assignments").delete().in("video_id", videoIds);
  if (videoIds.length) await db.from("videos").delete().in("id", videoIds);
  await db.storage.from(bucket).remove((taggedVideos.data ?? []).map((v) => v.storage_path).filter(Boolean) as string[]);
  const taggedAssignments = await db.from("practice_assignments").select("id").like("title", `${PORTAL_TEST}:%`);
  if (taggedAssignments.error) throw new Error(taggedAssignments.error.message);
  const assignmentIds = (taggedAssignments.data ?? []).map((a) => a.id);
  if (assignmentIds.length) await db.from("practice_assignment_students").delete().in("assignment_id", assignmentIds).eq("student_id", studentId);
  if (assignmentIds.length) await db.from("practice_assignments").delete().in("id", assignmentIds);
  if (mode === "cleanup") {
    await replaceLessons(env, seed, false);
    return { ok: true as const, studentId, wroteInvoices: false, wroteMessages: false };
  }
  const notes = await db.from("lesson_notes").insert(seed.notes.map((n) => ({
    student_id: studentId,
    lesson_date: n.lessonDate,
    title: n.title,
    summary: n.summary,
    technique: n.technique,
    practice: n.practice,
    goals: n.goals,
    prep: n.prep,
    status: n.status,
    published_at: n.status === "published" ? new Date().toISOString() : null,
  })));
  if (notes.error) throw new Error(notes.error.message);
  const videoRows: { title: string; category: string; description: string; source: "upload"; storage_path: string; duration_label: string }[] = [];
  for (const video of seed.videos) {
    const up = await db.storage.from(bucket).upload(video.storagePath, video.bytes, { upsert: true, contentType: "video/mp4" });
    if (up.error) throw new Error(up.error.message);
    videoRows.push({ title: video.title, category: video.category, description: video.description, source: "upload", storage_path: video.storagePath, duration_label: "0:01" });
  }
  const savedVideos = await db.from("videos").insert(videoRows).select("id,title");
  if (savedVideos.error) throw new Error(savedVideos.error.message);
  await db.from("video_assignments").insert((savedVideos.data ?? []).map((v) => ({ video_id: v.id, student_id: studentId })));
  const technique = (savedVideos.data ?? []).find((v) => v.title === "portal-test: Technique");
  const savedAssignments = await db.from("practice_assignments").insert(seed.assignments.map((a) => ({
    title: a.title,
    instructions: a.instructions,
    due_date: a.dueDate,
    lesson_date: a.lessonDate,
    video_id: technique?.id ?? null,
  }))).select("id");
  if (savedAssignments.error) throw new Error(savedAssignments.error.message);
  await db.from("practice_assignment_students").insert((savedAssignments.data ?? []).map((a) => ({ assignment_id: a.id, student_id: studentId })));
  await replaceLessons(env, seed, true);
  return { ok: true as const, studentId, wroteInvoices: false, wroteMessages: false };
}
