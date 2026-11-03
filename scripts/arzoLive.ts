import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ARZO_EMAIL, ARZO_GHL_CONTACT_ID, ARZO_STUDENT_ID } from "./arzoFixture.js";
import { buildArzoSeed, invoiceFixturePlan, PORTAL_TEST, seedGuard, videoSeedGuard, type ArzoSeed } from "./arzoSeed.js";

const GHL = "https://services.leadconnectorhq.com";

function client(env: Record<string, string | undefined>) {
  return createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
}

function isMissingRelation(error: { code?: string; message?: string }) {
  return error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache|could not find the table/i.test(error.message ?? "");
}

function isMissingColumn(error: { code?: string; message?: string }) {
  return error.code === "42703" || error.code === "PGRST204" || /column/i.test(error.message ?? "");
}

async function findArzo(env: Record<string, string | undefined>) {
  const db = client(env);
  const byId = await db.from("students").select("id,email,ghl_contact_id").eq("id", ARZO_STUDENT_ID).maybeSingle();
  const byEmail = await db.from("students").select("id,email,ghl_contact_id").eq("email", ARZO_EMAIL).maybeSingle();
  if (byId.error) throw new Error(byId.error.message);
  if (byEmail.error) throw new Error(byEmail.error.message);
  if (byId.data && byEmail.data && byId.data.id !== byEmail.data.id) {
    throw new Error("Refusing to continue: luperdev@gmail.com is not on Arzo's student id.");
  }
  const row = byId.data ?? byEmail.data;
  if (!row) return null;
  if (row.id !== ARZO_STUDENT_ID) throw new Error(`Refusing to continue: expected student ${ARZO_STUDENT_ID}.`);
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

async function deletePortalTestVideos(db: SupabaseClient, bucket: string) {
  const taggedVideos = await db.from("videos").select("id,storage_path").like("storage_path", "portal-test/arzo/%");
  if (taggedVideos.error) throw new Error(taggedVideos.error.message);
  const videoIds = (taggedVideos.data ?? []).map((v) => v.id);
  if (videoIds.length) await db.from("video_assignments").delete().in("video_id", videoIds);
  if (videoIds.length) await db.from("videos").delete().in("id", videoIds);
  const paths = [...new Set([
    ...(taggedVideos.data ?? []).map((v) => v.storage_path).filter(Boolean) as string[],
    ...buildArzoSeed().videos.map((v) => v.storagePath),
  ])];
  if (paths.length) {
    const removed = await db.storage.from(bucket).remove(paths);
    if (removed.error) throw new Error(removed.error.message);
  }
}

async function insertVideos(db: SupabaseClient, bucket: string, studentId: string, seed: ArzoSeed) {
  const videoRows: { title: string; category: string; description: string; source: "upload"; storage_path: string; duration_label: string }[] = [];
  for (const video of seed.videos) {
    const up = await db.storage.from(bucket).upload(video.storagePath, video.bytes, { upsert: true, contentType: "video/mp4" });
    if (up.error) throw new Error(up.error.message);
    videoRows.push({ title: video.title, category: video.category, description: video.description, source: "upload", storage_path: video.storagePath, duration_label: "0:01" });
  }
  const savedVideos = await db.from("videos").insert(videoRows).select("id,title");
  if (savedVideos.error) throw new Error(savedVideos.error.message);
  const rows = savedVideos.data ?? [];
  await db.from("video_assignments").insert(rows.map((v) => ({ video_id: v.id, student_id: studentId })));
  const technique = rows.find((v) => v.title === "portal-test: Technique");
  return technique?.id ?? null;
}

async function linkDailyScales(db: SupabaseClient, studentId: string, seed: ArzoSeed, techniqueId: string | null) {
  const item = seed.assignments[0];
  const existing = await db.from("practice_assignments").select("id").eq("title", item.title).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (!existing.data) {
    const created = await db.from("practice_assignments").insert({
      title: item.title,
      instructions: item.instructions,
      due_date: item.dueDate,
      lesson_date: item.lessonDate,
      video_id: techniqueId,
    }).select("id").single();
    if (created.error) throw new Error(created.error.message);
    const link = await db.from("practice_assignment_students").insert({ assignment_id: created.data.id, student_id: studentId });
    if (link.error) throw new Error(link.error.message);
    return;
  }
  const updated = await db.from("practice_assignments").update({ video_id: techniqueId }).eq("id", existing.data.id);
  if (updated.error) throw new Error(updated.error.message);
  const link = await db.from("practice_assignment_students").upsert({ assignment_id: existing.data.id, student_id: studentId });
  if (link.error) throw new Error(link.error.message);
}

async function deletePortalTestMessages(db: SupabaseClient, studentId: string) {
  const existing = await db.from("message_threads").select("id").eq("student_id", studentId).like("subject", `${PORTAL_TEST}:%`);
  if (existing.error) {
    if (isMissingRelation(existing.error)) return;
    throw new Error(existing.error.message);
  }
  const ids = (existing.data ?? []).map((row) => row.id);
  if (!ids.length) return;
  const messages = await db.from("messages").delete().in("thread_id", ids);
  if (messages.error && !isMissingRelation(messages.error)) throw new Error(messages.error.message);
  const threads = await db.from("message_threads").delete().in("id", ids);
  if (threads.error) throw new Error(threads.error.message);
}

async function deleteInvoiceFixtures(db: SupabaseClient, studentId: string) {
  const existing = await db.from("invoices").delete().eq("student_id", studentId).like("title", `${PORTAL_TEST}:%`);
  if (existing.error && !isMissingRelation(existing.error) && !isMissingColumn(existing.error)) throw new Error(existing.error.message);
}

async function writeInvoiceFixtures(db: SupabaseClient, studentId: string, seed: ArzoSeed) {
  const probe = await db.from("invoices").select("id,student_id,title").limit(1);
  if (probe.error) {
    if (isMissingRelation(probe.error) || isMissingColumn(probe.error)) return false;
    throw new Error(probe.error.message);
  }
  const plan = invoiceFixturePlan(true);
  if (!plan.write) return false;
  await deleteInvoiceFixtures(db, studentId);
  const saved = await db.from("invoices").insert(plan.rows.map((row) => ({
    student_id: studentId,
    title: row.title,
    status: row.status,
    live_mode: false,
    total: row.total,
    amount_paid: row.amountPaid,
    amount_due: row.amountDue,
  })));
  if (saved.error) {
    if (isMissingColumn(saved.error)) return false;
    throw new Error(saved.error.message);
  }
  return true;
}

export async function runArzoSeed(env: Record<string, string | undefined>, mode: "seed" | "cleanup" | "videos") {
  const guard = mode === "videos" ? videoSeedGuard(env) : seedGuard(env);
  if (!guard.ok) return guard;
  const studentId = await findArzo(env);
  if (!studentId) {
    return { ok: false as const, missing: [] as string[], blocked: `No students row for ${ARZO_EMAIL} (${ARZO_STUDENT_ID}, contact ${ARZO_GHL_CONTACT_ID}). This script will not create a login or send email.` };
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
    const notesGone = await db.from("lesson_notes").delete().eq("student_id", studentId).like("title", `${PORTAL_TEST}:%`);
    if (notesGone.error) throw new Error(notesGone.error.message);
  }
  await deletePortalTestVideos(db, bucket);
  if (mode === "seed" || mode === "cleanup") {
    const taggedAssignments = await db.from("practice_assignments").select("id").like("title", `${PORTAL_TEST}:%`);
    if (taggedAssignments.error) throw new Error(taggedAssignments.error.message);
    const assignmentIds = (taggedAssignments.data ?? []).map((a) => a.id);
    if (assignmentIds.length) await db.from("practice_assignment_students").delete().in("assignment_id", assignmentIds).eq("student_id", studentId);
    if (assignmentIds.length) await db.from("practice_assignments").delete().in("id", assignmentIds);
    await deletePortalTestMessages(db, studentId);
    await deleteInvoiceFixtures(db, studentId);
  }
  if (mode === "cleanup") {
    const notesGone = await db.from("lesson_notes").delete().eq("student_id", studentId).like("title", `${PORTAL_TEST}:%`);
    if (notesGone.error) throw new Error(notesGone.error.message);
    await replaceLessons(env, seed, false);
    return { ok: true as const, studentId, wroteInvoices: false, wroteMessages: false, videos: 0 };
  }
  const techniqueId = await insertVideos(db, bucket, studentId, seed);
  if (mode === "videos") {
    await linkDailyScales(db, studentId, seed, techniqueId);
    return { ok: true as const, studentId, wroteInvoices: false, wroteMessages: false, videos: seed.videos.length };
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
  const savedAssignments = await db.from("practice_assignments").insert(seed.assignments.map((a) => ({
    title: a.title,
    instructions: a.instructions,
    due_date: a.dueDate,
    lesson_date: a.lessonDate,
    video_id: techniqueId,
  }))).select("id");
  if (savedAssignments.error) throw new Error(savedAssignments.error.message);
  await db.from("practice_assignment_students").insert((savedAssignments.data ?? []).map((a) => ({ assignment_id: a.id, student_id: studentId })));
  const wroteInvoices = await writeInvoiceFixtures(db, studentId, seed);
  await replaceLessons(env, seed, true);
  return { ok: true as const, studentId, wroteInvoices, wroteMessages: false, videos: seed.videos.length };
}
