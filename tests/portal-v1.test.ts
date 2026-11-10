// Portal v1 rules end to end through the API, on the in-memory Supabase stand-in.
// Fixtures: Arzo Luper (adult, STUDENT_A) and Arzo Luper Jr (child, STUDENT_B), luperdev@gmail.com addresses only.
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "../server/app";
import { loadConfig } from "../server/config";
import { createMailer } from "../server/mail/mailer";
import { buildDeps, captureMail, fakeGoogle, fixtureTables, PAYER_A, STUDENT_A, STUDENT_B } from "./helpers";
import { lessonRow, TEACHER_ACCOUNT, type CoreTables } from "./memoryStore";

// Monday 16 Nov 2026, 9:00 AM in Los Angeles (PST, UTC-8).
const T0 = Date.parse("2026-11-16T17:00:00Z");
const HOUR = 3600000;
const la = (date: string, time: string) => new Date(`${date}T${time}:00-08:00`).toISOString();
const WED_10 = la("2026-11-18", "10:00");
const WED_11 = la("2026-11-18", "11:00");

const arzo = { role: "student" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] };
const guardian = { role: "guardian" as const, links: [{ studentId: STUDENT_B, canBook: true, canPay: true }] };
const users = { arzo, guardian, teach: { role: "teacher" as const } };

function setup(opts: { seed?: (t: CoreTables) => void; busy?: { start: number; end: number }[]; extra?: Partial<Deps>; config?: Partial<Deps["config"]> } = {}) {
  const tables = fixtureTables();
  for (const s of tables.students) s.teacherAccountId = TEACHER_ACCOUNT;
  // Lesson hours every day 10:00-18:00.
  tables.hours[TEACHER_ACCOUNT] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 600, endMinute: 1080 }));
  tables.settings[TEACHER_ACCOUNT] = { teacherAccountId: TEACHER_ACCOUNT, holdWindowMinutes: 1440, rescheduleNoticeHours: 24, cancelNoticeHours: 24, zelleRecipient: "luperdev+zelle@gmail.com", timezone: "America/Los_Angeles" };
  opts.seed?.(tables);
  const clock = { now: T0 };
  const mail = captureMail();
  const google = fakeGoogle(opts.busy ?? []);
  const deps = buildDeps(users, {}, tables, { mailer: mail.mailer, google: google.client, now: () => clock.now, ...opts.extra });
  Object.assign(deps.config, opts.config ?? {});
  const app = createApp(deps);
  const as = (who: string) => ({
    get: (p: string) => request(app).get(p).set("Authorization", `Bearer ${who}`),
    post: (p: string, b: object = {}) => request(app).post(p).set("Authorization", `Bearer ${who}`).send(b),
    put: (p: string, b: object = {}) => request(app).put(p).set("Authorization", `Bearer ${who}`).send(b),
  });
  const credits = (id = STUDENT_A) => tables.ledger.filter((r) => r.studentId === id).reduce((s, r) => s + r.delta, 0);
  return { app, tables, clock, mail, google, deps, as, credits };
}

const book = (env: ReturnType<typeof setup>, body: object = {}, who = "arzo") =>
  env.as(who).post("/api/lessons", { studentId: STUDENT_A, startTime: WED_10, location: "Music City SF", ...body });

describe("booking 60-minute lessons", () => {
  it("lists open 60-minute slots from lesson hours, every half hour, minus Google busy and booked lessons", async () => {
    const env = setup({ busy: [{ start: Date.parse(la("2026-11-18", "12:00")), end: Date.parse(la("2026-11-18", "12:30")) }], seed: (t) => { t.lessons.push(lessonRow(STUDENT_B, WED_10)); } });
    const res = await env.as("arzo").get(`/api/lessons/slots?studentId=${STUDENT_A}&from=2026-11-18&to=2026-11-18`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slotMinutes: 60, stepMinutes: 30 });
    const times = res.body.days["2026-11-18"].map((iso: string) => new Date(Date.parse(iso) - 8 * HOUR).toISOString().slice(11, 16));
    // 10:00 and 10:30 overlap the booked lesson; 11:30 and 12:00 overlap the busy block; 12:30 starts as it ends.
    expect(times).toEqual(["11:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00"]);
  });

  it("books a lesson with a credit as confirmed and uses exactly one credit", async () => {
    const env = setup({ seed: (t) => { t.ledger.push({ studentId: STUDENT_A, delta: 4, reason: "package_paid", invoiceId: "x", lessonId: null }); } });
    const res = await book(env);
    expect(res.status).toBe(200);
    expect(res.body.lessons).toHaveLength(1);
    expect(res.body.lessons[0]).toMatchObject({ status: "confirmed", startTime: WED_10 });
    expect(new Date(res.body.lessons[0].endTime).getTime() - new Date(WED_10).getTime()).toBe(HOUR);
    expect(env.credits()).toBe(3);
    expect(env.tables.invoices).toHaveLength(0);
    expect(env.mail.sent.map((m) => [m.to, m.subject])).toEqual([["luperdev@gmail.com", "Lesson booked: Arzo Luper"]]);
  });

  it("refuses a time outside lesson hours or off the half-hour grid", async () => {
    const env = setup();
    expect((await book(env, { startTime: la("2026-11-18", "08:00") })).status).toBe(409);
    expect((await book(env, { startTime: la("2026-11-18", "10:15") })).status).toBe(409);
    expect((await book(env, { startTime: la("2026-11-18", "17:30") })).status).toBe(409);
  });

  it("excludes Google Calendar busy times on the server", async () => {
    const env = setup({ busy: [{ start: Date.parse(la("2026-11-18", "10:30")), end: Date.parse(la("2026-11-18", "10:45")) }] });
    const res = await book(env);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("slot_unavailable");
    expect(env.tables.lessons).toHaveLength(0);
  });

  it("fails closed when Google Calendar isn't available", async () => {
    const env = setup({ extra: { google: null } });
    expect((await book(env)).body.error.code).toBe("availability_unavailable");
    expect(env.tables.lessons).toHaveLength(0);
  });

  it("prevents double booking on the server and in the database constraint", async () => {
    const env = setup({ seed: (t) => { t.lessons.push(lessonRow(STUDENT_B, la("2026-11-18", "10:30"))); } });
    const res = await book(env);
    expect(res.status).toBe(409);
    // Even if a request skipped the server check, the exclusion constraint (mirrored by the stand-in) refuses it.
    await expect(env.deps.store!.createLesson({ studentId: STUDENT_A, teacherAccountId: TEACHER_ACCOUNT, startsAt: WED_10, endsAt: WED_11, locationKind: "in_person", location: "", zoomUrl: null, createdByAccountId: "arzo", source: "portal" })).rejects.toMatchObject({ status: 409 });
    const sql = readFileSync("supabase/migrations/0006_portal_v1.sql", "utf8");
    expect(sql).toMatch(/add constraint lessons_no_overlap exclude using gist \(\s*teacher_account_id with =,\s*tstzrange\(starts_at, ends_at, '\[\)'\) with &&\s*\) where \(status in \('scheduled', 'pending_payment'\)\)/);
    expect(sql).toContain("add constraint lessons_sixty_minutes check (ends_at = starts_at + interval '60 minutes')");
  });

  it("books the same slot weekly as a series; each lesson uses a credit or gets its own $100 invoice", async () => {
    const env = setup({ seed: (t) => { t.ledger.push({ studentId: STUDENT_A, delta: 2, reason: "package_paid", invoiceId: "x", lessonId: null }); } });
    const res = await book(env, { repeatWeekly: true, weeks: 4 });
    expect(res.status).toBe(200);
    expect(res.body.lessons.map((l: any) => l.startTime)).toEqual([0, 1, 2, 3].map((w) => new Date(Date.parse(WED_10) + w * 7 * 24 * HOUR).toISOString()));
    expect(res.body.lessons.map((l: any) => l.status)).toEqual(["confirmed", "confirmed", "pending_payment", "pending_payment"]);
    expect(env.credits()).toBe(0);
    expect(env.tables.invoices.map((i) => [i.kind, i.totalCents])).toEqual([["session", 10000], ["session", 10000]]);
    expect(new Set(env.tables.lessons.map((l) => l.seriesId)).size).toBe(1);
  });

  it("books nothing in a series if any week isn't open", async () => {
    const env = setup({ seed: (t) => { t.lessons.push(lessonRow(STUDENT_B, new Date(Date.parse(WED_10) + 14 * 24 * HOUR).toISOString())); } });
    expect((await book(env, { repeatWeekly: true, weeks: 4 })).status).toBe(409);
    expect(env.tables.lessons.filter((l) => l.studentId === STUDENT_A)).toHaveLength(0);
  });
});

describe("reschedule and cancel", () => {
  const withCreditLesson = (t: CoreTables) => {
    t.ledger.push({ studentId: STUDENT_A, delta: 4, reason: "package_paid", invoiceId: "x", lessonId: null });
  };

  it("moves a lesson to another open slot and keeps the old-to-new link", async () => {
    const env = setup({ seed: withCreditLesson });
    const lesson = (await book(env)).body.lessons[0];
    const res = await env.as("arzo").post(`/api/lessons/${lesson.id}/reschedule`, { startTime: la("2026-11-18", "10:30") });
    expect(res.status).toBe(200);
    expect(res.body.lesson).toMatchObject({ rescheduledFromId: lesson.id, status: "confirmed", startTime: la("2026-11-18", "10:30") });
    expect(env.tables.lessons.find((l) => l.id === lesson.id)?.status).toBe("rescheduled");
    expect(env.credits()).toBe(3);
  });

  it("refuses a family reschedule inside the teacher's notice window, which the teacher can change", async () => {
    const env = setup({ seed: withCreditLesson });
    const lesson = (await book(env)).body.lessons[0];
    env.clock.now = Date.parse(WED_10) - 20 * HOUR;
    const closed = await env.as("arzo").post(`/api/lessons/${lesson.id}/reschedule`, { startTime: la("2026-11-18", "14:00") });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("reschedule_closed");
    await env.as("teach").put("/api/teacher/studio", { rescheduleNoticeHours: 12 });
    expect((await env.as("arzo").post(`/api/lessons/${lesson.id}/reschedule`, { startTime: la("2026-11-18", "14:00") })).status).toBe(200);
  });

  it("returns the credit when cancelled with enough notice", async () => {
    const env = setup({ seed: withCreditLesson });
    const lesson = (await book(env)).body.lessons[0];
    const res = await env.as("arzo").post(`/api/lessons/${lesson.id}/cancel`, {});
    expect(res.body).toMatchObject({ late: false, refund: "credit" });
    expect(env.credits()).toBe(4);
  });

  it("keeps the credit used on a late cancel", async () => {
    const env = setup({ seed: withCreditLesson });
    const lesson = (await book(env)).body.lessons[0];
    env.clock.now = Date.parse(WED_10) - 2 * HOUR;
    const res = await env.as("arzo").post(`/api/lessons/${lesson.id}/cancel`, {});
    expect(res.body).toMatchObject({ late: true, refund: "none" });
    expect(env.tables.lessons.find((l) => l.id === lesson.id)).toMatchObject({ status: "cancelled", lateCancel: true });
    expect(env.credits()).toBe(3);
  });

  it("keeps a held session's $100 owed on a late cancel, and voids it on an early one", async () => {
    const early = setup();
    const a = (await book(early)).body.lessons[0];
    expect((await early.as("arzo").post(`/api/lessons/${a.id}/cancel`, {})).body.refund).toBe("invoice_voided");
    expect(early.tables.invoices[0].status).toBe("void");

    const late = setup({ config: {} });
    late.tables.settings[TEACHER_ACCOUNT].cancelNoticeHours = 72;
    const b = (await book(late)).body.lessons[0];
    expect((await late.as("arzo").post(`/api/lessons/${b.id}/cancel`, {})).body).toMatchObject({ late: true, refund: "none" });
    expect(late.tables.invoices[0].status).toBe("sent");
  });

  it("only lets the family change their own lessons", async () => {
    const env = setup({ seed: withCreditLesson });
    const lesson = (await book(env)).body.lessons[0];
    expect((await env.as("guardian").post(`/api/lessons/${lesson.id}/cancel`, {})).status).toBe(403);
  });
});

describe("single sessions and holds", () => {
  it("creates a $100 invoice and holds the slot as pending payment, confirmed once marked paid", async () => {
    const env = setup();
    const res = await book(env);
    const lesson = res.body.lessons[0];
    expect(lesson.status).toBe("pending_payment");
    expect(lesson.holdExpiresAt).toBe(new Date(T0 + 24 * HOUR).toISOString());
    const [invoice] = env.tables.invoices;
    expect(invoice).toMatchObject({ kind: "session", totalCents: 10000, status: "sent", paymentMethodChoice: "zelle" });
    expect(env.mail.sent.map((m) => m.subject)).toEqual(["Invoice #1001 from SF Trad Music", "Lesson booked: Arzo Luper"]);
    expect(env.mail.sent[0].callout?.join(" ")).toContain("luperdev+zelle@gmail.com");

    const paid = await env.as("teach").post(`/api/teacher/invoices/${invoice.id}/mark-paid`, { method: "zelle", paidAt: "2026-11-16", reference: "ZL-123" });
    expect(paid.status).toBe(200);
    expect(env.tables.lessons[0]).toMatchObject({ status: "scheduled", holdExpiresAt: null });
    expect(env.tables.payments[0]).toMatchObject({ amountCents: 10000, method: "zelle", reference: "ZL-123" });
    expect(env.mail.sent.at(-1)?.subject).toBe(`Payment received for invoice #${invoice.number}`);
  });

  it("releases an unpaid hold after the teacher's window and voids its invoice", async () => {
    const env = setup();
    env.tables.settings[TEACHER_ACCOUNT].holdWindowMinutes = 120;
    await book(env);
    env.clock.now = T0 + 121 * 60000;
    const dash = await env.as("arzo").get("/api/portal/dashboard");
    expect(dash.body.upcoming).toEqual([]);
    expect(env.tables.lessons[0].status).toBe("released");
    expect(env.tables.invoices[0].status).toBe("void");
    // The slot is free again.
    expect((await env.as("arzo").get(`/api/lessons/slots?studentId=${STUDENT_A}&from=2026-11-18&to=2026-11-18`)).body.days["2026-11-18"][0]).toBe(WED_10);
  });

  it("releases a hold before the lesson starts when that comes first", async () => {
    const env = setup();
    const soon = la("2026-11-16", "11:00"); // 2 hours away, hold window 24h
    const lesson = (await book(env, { startTime: soon })).body.lessons[0];
    expect(lesson.holdExpiresAt).toBe(soon);
    env.clock.now = Date.parse(soon);
    await env.as("arzo").get("/api/portal/dashboard");
    expect(env.tables.lessons[0].status).toBe("released");
  });

  it("blocks new bookings while a session hold or any balance is unpaid", async () => {
    const env = setup();
    await book(env);
    const blocked = await book(env, { startTime: la("2026-11-19", "10:00") });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe("unpaid_hold");
    const other = setup({ seed: (t) => { t.invoices.push({ ...(t.invoices[0] ?? {}), id: "11111111-0000-4000-8000-000000000001", number: 1, studentId: STUDENT_A, payerId: PAYER_A, payerName: "", payerEmail: null, title: "Old", currency: "USD", totalCents: 5000, amountPaidCents: 0, status: "sent", issueDate: "2026-11-01", dueDate: "2026-11-01", createdAt: "", lines: [], kind: "manual", paymentMethodChoice: "cash", packageLessons: 0 }); } });
    const owed = await book(other);
    expect(owed.status).toBe(402);
    expect(owed.body.error.code).toBe("outstanding_balance");
  });
});

describe("4-lesson package", () => {
  it("costs $380 by Zelle and $375 in cash, and adds 4 credits only after it is marked paid", async () => {
    const zelle = setup();
    const z = await zelle.as("arzo").post("/api/packages/purchase", { studentId: STUDENT_A, method: "zelle" });
    expect(z.status).toBe(200);
    expect(z.body.invoice).toMatchObject({ total: 380, status: "sent", kind: "package", paymentMethod: "zelle" });
    expect(z.body.instructions.join(" ")).toContain("Send $380 by Zelle to luperdev+zelle@gmail.com");
    expect(zelle.credits()).toBe(0);

    const cash = setup();
    const c = await cash.as("arzo").post("/api/packages/purchase", { studentId: STUDENT_A, method: "cash" });
    expect(c.body.invoice).toMatchObject({ total: 375, paymentMethod: "cash" });
    expect(c.body.instructions[0]).toContain("$375 in cash");

    const id = z.body.invoice.id;
    expect((await zelle.as("teach").post(`/api/teacher/invoices/${id}/mark-paid`, { method: "zelle", reference: "Z1" })).body.invoice.status).toBe("paid");
    expect(zelle.credits()).toBe(4);
    // Marking it paid again adds nothing.
    expect((await zelle.as("teach").post(`/api/teacher/invoices/${id}/mark-paid`, { method: "zelle" })).body.alreadyPaid).toBe(true);
    expect(zelle.credits()).toBe(4);
    expect(zelle.tables.payments).toHaveLength(1);
  });

  it("uses one credit per booked lesson and shows credits left", async () => {
    const env = setup();
    const id = (await env.as("arzo").post("/api/packages/purchase", { studentId: STUDENT_A, method: "cash" })).body.invoice.id;
    await env.as("teach").post(`/api/teacher/invoices/${id}/mark-paid`, { method: "cash" });
    await book(env);
    await book(env, { startTime: la("2026-11-19", "10:00") });
    expect((await env.as("arzo").get("/api/portal/dashboard")).body.packageLessons).toBe(2);
    expect((await env.as("teach").get("/api/teacher/students")).body.students.find((s: any) => s.id === STUDENT_A).packageLessons).toBe(2);
  });

  it("returns the open package invoice instead of creating a second one, and only a payer can request it", async () => {
    const env = setup();
    const first = await env.as("arzo").post("/api/packages/purchase", { studentId: STUDENT_A, method: "zelle" });
    const again = await env.as("arzo").post("/api/packages/purchase", { studentId: STUDENT_A, method: "zelle" });
    expect(again.body).toMatchObject({ existing: true, invoice: { id: first.body.invoice.id } });
    expect((await env.as("guardian").post("/api/packages/purchase", { studentId: STUDENT_A, method: "zelle" })).status).toBe(403);
    expect((await env.as("arzo").post("/api/packages/purchase", { studentId: STUDENT_A, method: "venmo" })).status).toBe(400);
  });
});

describe("referrals", () => {
  async function referredSetup() {
    const env = setup();
    // Arzo (STUDENT_A) refers the child (STUDENT_B).
    const panel = (await env.as("arzo").get(`/api/referrals?studentId=${STUDENT_A}`)).body;
    expect(panel.code).toMatch(/^SFTM-[A-Z0-9]{8}$/);
    expect((await env.as("guardian").post("/api/referrals/apply", { studentId: STUDENT_B, code: panel.code })).status).toBe(200);
    return { env, code: panel.code as string };
  }

  it("gives the new student $15 off their first invoice only", async () => {
    const { env } = await referredSetup();
    const first = (await env.as("guardian").post("/api/packages/purchase", { studentId: STUDENT_B, method: "zelle" })).body.invoice;
    expect(first.total).toBe(365);
    expect(first.lines).toEqual([{ label: "4-lesson package (Zelle)", amount: 380 }, { label: "Referral discount", amount: -15 }]);
    await env.as("teach").post(`/api/teacher/invoices/${first.id}/mark-paid`, { method: "zelle" });
    const second = (await env.as("teach").post("/api/teacher/invoices", { studentId: STUDENT_B, lines: [{ label: "Lesson", amount: 100 }] })).body.invoice;
    expect(second.total).toBe(100);
  });

  it("gives the referrer a $25 credit exactly once when that first invoice is paid, used on their next invoice once", async () => {
    const { env } = await referredSetup();
    const pending = (await env.as("arzo").get(`/api/referrals?studentId=${STUDENT_A}`)).body;
    expect(pending).toMatchObject({ totalReferred: 1, pending: [{ name: "Arzo" }], completed: [], creditsEarnedCents: 0 });

    const first = (await env.as("guardian").post("/api/packages/purchase", { studentId: STUDENT_B, method: "cash" })).body.invoice;
    await env.as("teach").post(`/api/teacher/invoices/${first.id}/mark-paid`, { method: "cash" });
    await env.as("teach").post(`/api/teacher/invoices/${first.id}/mark-paid`, { method: "cash" });
    expect(env.tables.referralCredits).toHaveLength(1);

    const done = (await env.as("arzo").get(`/api/referrals?studentId=${STUDENT_A}`)).body;
    expect(done).toMatchObject({ pending: [], completed: [{ name: "Arzo" }], creditsEarnedCents: 2500, creditsUsedCents: 0, creditsAvailableCents: 2500 });

    const next = (await env.as("arzo").post("/api/packages/purchase", { studentId: STUDENT_A, method: "zelle" })).body.invoice;
    expect(next.total).toBe(355);
    expect(next.lines.at(-1)).toEqual({ label: "Referral credit", amount: -25 });
    await env.as("teach").post(`/api/teacher/invoices/${next.id}/mark-paid`, { method: "zelle" });
    const after = (await env.as("teach").post("/api/teacher/invoices", { studentId: STUDENT_A, lines: [{ label: "Lesson", amount: 100 }] })).body.invoice;
    expect(after.total).toBe(100);
    expect((await env.as("arzo").get(`/api/referrals?studentId=${STUDENT_A}`)).body).toMatchObject({ creditsUsedCents: 2500, creditsAvailableCents: 0 });
  });

  it("puts the discount and credit back if their invoice is voided", async () => {
    const { env } = await referredSetup();
    const first = (await env.as("guardian").post("/api/packages/purchase", { studentId: STUDENT_B, method: "zelle" })).body.invoice;
    await env.as("teach").post(`/api/teacher/invoices/${first.id}/void`);
    const again = (await env.as("guardian").post("/api/packages/purchase", { studentId: STUDENT_B, method: "zelle" })).body.invoice;
    expect(again.total).toBe(365);
  });

  it("refuses your own code, a second code, or a code after the first invoice", async () => {
    const { env, code } = await referredSetup();
    expect((await env.as("arzo").post("/api/referrals/apply", { studentId: STUDENT_A, code })).status).toBe(400);
    expect((await env.as("guardian").post("/api/referrals/apply", { studentId: STUDENT_B, code })).status).toBe(409);
    expect((await env.as("guardian").post("/api/referrals/apply", { studentId: STUDENT_B, code: "SFTM-NOPE1234" })).status).toBe(404);
  });

  it("applies a code typed at sign-up and lists referrals for the teacher", async () => {
    const env = setup();
    const code = (await env.as("arzo").get(`/api/referrals?studentId=${STUDENT_A}`)).body.code;
    const created = await env.as("teach").post("/api/teacher/students", { fullName: "Arzo Luper III", ageCategory: "adult", email: "luperdev+three@gmail.com", referralCode: code });
    expect(created.body.referral).toBe("applied");
    const overview = (await env.as("teach").get("/api/teacher/referrals")).body;
    expect(overview.referrals).toEqual([expect.objectContaining({ referrer: "Arzo Luper", referred: "Arzo Luper III", status: "pending" })]);
  });
});

describe("notes and videos stay with the right student", () => {
  it("never shows another family's student, and only published notes", async () => {
    const listNotes = vi.fn(async () => []);
    const env = setup({ extra: {} });
    env.deps.store!.listNotes = listNotes;
    expect((await env.as("guardian").get(`/api/portal/dashboard?studentId=${STUDENT_A}`)).status).toBe(403);
    await env.as("arzo").get("/api/portal/dashboard");
    expect(listNotes).toHaveBeenCalledWith(STUDENT_A, { publishedOnly: true });
  });

  it("plays a video through a signed URL only when it is assigned to one of the account's students", async () => {
    const env = setup();
    const store = env.deps.store!;
    store.isVideoAssignedToAny = async (_id, ids) => ids.includes(STUDENT_A);
    store.getVideo = async (id) => ({ id, title: "Reel", category: "Repertoire", description: "", durationLabel: "", source: "upload", externalUrl: null, storagePath: "a.mp4" });
    store.signedPlaybackUrl = async (p) => `https://project.supabase.co/storage/v1/object/sign/lesson-videos/${p}?token=short-lived`;
    const vid = "99999999-9999-4999-8999-999999999999";
    expect((await env.as("arzo").get(`/api/videos/${vid}/playback`)).body).toMatchObject({ kind: "file", url: expect.stringContaining("/object/sign/") });
    expect((await env.as("guardian").get(`/api/videos/${vid}/playback`)).status).toBe(403);
  });
});

describe("teacher studio settings", () => {
  it("edits weekly lesson hours, hold window, notice windows and the Zelle recipient", async () => {
    const env = setup();
    const res = await env.as("teach").put("/api/teacher/studio", { holdWindowMinutes: 720, cancelNoticeHours: 48, zelleRecipient: "luperdev+pay@gmail.com", hours: [{ weekday: 3, startMinute: 900, endMinute: 1020 }] });
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ holdWindowMinutes: 720, cancelNoticeHours: 48, zelleRecipient: "luperdev+pay@gmail.com" });
    const slots = await env.as("arzo").get(`/api/lessons/slots?studentId=${STUDENT_A}&from=2026-11-16&to=2026-11-22`);
    expect(Object.keys(slots.body.days)).toEqual(["2026-11-18"]);
    expect((await env.as("teach").put("/api/teacher/studio", { hours: [{ weekday: 1, startMinute: 600, endMinute: 630 }] })).status).toBe(400);
    expect((await env.as("teach").put("/api/teacher/studio", { hours: [{ weekday: 1, startMinute: 600, endMinute: 720 }, { weekday: 1, startMinute: 660, endMinute: 780 }] })).status).toBe(400);
    expect((await env.as("arzo").put("/api/teacher/studio", { holdWindowMinutes: 60 })).status).toBe(403);
    expect((await env.as("arzo").get("/api/portal/dashboard")).body.policy).toMatchObject({ zelleRecipient: "luperdev+pay@gmail.com", cancelNoticeHours: 48 });
  });

  it("lets the teacher add, move and cancel lessons", async () => {
    const env = setup();
    const added = await env.as("teach").post("/api/teacher/lessons", { studentId: STUDENT_A, startTime: WED_10, location: "Zoom" });
    expect(added.status).toBe(200);
    expect(added.body.lesson.status).toBe("confirmed");
    const moved = await env.as("teach").post(`/api/teacher/lessons/${added.body.lesson.id}/reschedule`, { startTime: WED_11 });
    expect(moved.body.lesson.rescheduledFromId).toBe(added.body.lesson.id);
    expect((await env.as("teach").post(`/api/teacher/lessons/${moved.body.lesson.id}/cancel`, {})).body.late).toBe(false);
  });
});

describe("card payments (Stripe test mode)", () => {
  it("are hidden and refused when CARD_PAYMENTS_ENABLED is off", async () => {
    const env = setup();
    expect((await env.as("arzo").get("/api/me")).body.features).toEqual({ cardPayments: false });
    expect((await env.as("arzo").post("/api/packages/purchase", { studentId: STUDENT_A, method: "card" })).body.error.code).toBe("card_payments_off");
    const inv = (await env.as("arzo").post("/api/packages/purchase", { studentId: STUDENT_A, method: "zelle" })).body.invoice;
    expect((await env.as("arzo").post(`/api/invoices/${inv.id}/checkout`)).status).toBe(404);
    expect((await request(env.app).post("/api/webhooks/stripe").send("{}")).status).toBe(404);
    expect(loadConfig({ STRIPE_SECRET_KEY: "sk_test_x", VITE_STRIPE_PUBLISHABLE_KEY: "pk_test_x" }).features.cardPayments).toBe(false);
    expect(loadConfig({ CARD_PAYMENTS_ENABLED: "true", STRIPE_SECRET_KEY: "sk_live_x", VITE_STRIPE_PUBLISHABLE_KEY: "pk_live_x" }).features.cardPayments).toBe(false);
    expect(loadConfig({ CARD_PAYMENTS_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_x", VITE_STRIPE_PUBLISHABLE_KEY: "pk_test_x" }).features.cardPayments).toBe(true);
  });

  it("checks out an invoice and marks it paid from a verified webhook, idempotently", async () => {
    const createSession = vi.fn(async (input: any) => ({ id: "cs_test_1", url: `https://checkout.stripe.com/c/pay/cs_test_1#${input.amountCents}` }));
    const event = (id: string, invoiceId: string) => ({ id, type: "checkout.session.completed", data: { object: { id: "cs_test_1", payment_status: "paid", livemode: false, metadata: { invoice_id: invoiceId } } } });
    let next: any = null;
    const verifyEvent = vi.fn((_raw: Buffer, sig: string) => { if (sig !== "t=1,v1=good") throw new Error("bad signature"); return next; });
    const env = setup({ extra: { checkout: { createSession, verifyEvent } }, config: { features: { cardPayments: true }, stripeWebhookSecret: "whsec_test_only" } });
    const inv = (await env.as("arzo").post("/api/packages/purchase", { studentId: STUDENT_A, method: "card" })).body.invoice;
    expect(inv.total).toBe(380);
    const co = await env.as("arzo").post(`/api/invoices/${inv.id}/checkout`);
    expect(co.body.url).toContain("checkout.stripe.com");
    expect(createSession.mock.calls[0][0]).toMatchObject({ invoiceId: inv.id, amountCents: 38000 });

    const hook = (sig: string) => request(env.app).post("/api/webhooks/stripe").set("stripe-signature", sig).set("content-type", "application/json").send(JSON.stringify({}));
    next = event("evt_1", inv.id);
    expect((await hook("t=1,v1=bad")).status).toBe(400);
    expect(env.credits()).toBe(0);
    expect((await hook("t=1,v1=good")).status).toBe(200);
    expect((await hook("t=1,v1=good")).body.duplicate).toBe(true);
    next = event("evt_2", inv.id);
    expect((await hook("t=1,v1=good")).status).toBe(200);
    expect(env.credits()).toBe(4);
    expect(env.tables.payments).toEqual([expect.objectContaining({ method: "card", amountCents: 38000 })]);
  });
});

describe("SAFE_MODE email allowlist", () => {
  it("emails only allowlisted addresses in safe mode and everyone otherwise", async () => {
    const deliver = vi.fn(async () => undefined);
    const safe = createMailer({ smtp: { user: "zane@sftradmusic.com", pass: "test-only" }, safeMode: true, allowlist: ["luperdev@gmail.com"], deliver });
    expect((await safe.send({ to: "LuperDev@gmail.com", subject: "s", heading: "h", lines: [] })).emailed).toBe(true);
    expect((await safe.send({ to: "luperdev+other@gmail.com", subject: "s", heading: "h", lines: [] })).reason).toBe("safe_mode");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((deliver.mock.calls[0] as any)[0]).toMatchObject({ from: "SF Trad Music <zane@sftradmusic.com>", to: "luperdev@gmail.com" });
    expect((deliver.mock.calls[0] as any)[0].html).toContain("SF TRAD MUSIC");
    const open = createMailer({ smtp: null, safeMode: false, allowlist: [], deliver });
    expect((await open.send({ to: "luperdev+other@gmail.com", subject: "s", heading: "h", lines: [] })).emailed).toBe(true);
    expect((await createMailer({ smtp: null, safeMode: false, allowlist: [] }).send({ to: "luperdev@gmail.com", subject: "s", heading: "h", lines: [] })).reason).toBe("not_configured");
  });

  it("sends lesson and invoice email to the payer only: the guardian for a child", async () => {
    const env = setup();
    await env.as("guardian").post("/api/lessons", { studentId: STUDENT_B, startTime: WED_10, location: "Zoom" });
    expect(new Set(env.mail.sent.map((m) => m.to))).toEqual(new Set(["luperdev+guardian@gmail.com"]));
  });
});

describe("ops summary for the Grok bot", () => {
  const TOKEN = "ops-test-token-not-a-secret-0123456789";
  it("requires the bearer token and returns read-only counts", async () => {
    const env = setup({ config: { opsApiToken: TOKEN }, seed: (t) => { t.lessons.push(lessonRow(STUDENT_A, la("2026-11-16", "15:00"))); } });
    expect((await request(env.app).get("/api/ops/summary")).status).toBe(401);
    expect((await request(env.app).get("/api/ops/summary").set("Authorization", "Bearer wrong")).status).toBe(401);
    await book(env, { startTime: la("2026-11-17", "10:00") });
    // The database stamps created_at with now(); the stand-in uses the wall clock, so align it with the test clock.
    for (const l of env.tables.lessons) if (l.studentId === STUDENT_A && l.status === "pending_payment") l.createdAt = new Date(T0).toISOString();
    const res = await request(env.app).get("/api/ops/summary").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.todaysLessons).toHaveLength(1);
    expect(res.body.pendingSessionHolds).toHaveLength(1);
    expect(res.body.unpaidInvoices).toMatchObject({ count: 1, totalDue: 100 });
    expect(res.body.newBookings).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("luperdev");
    expect((await request(env.app).post("/api/ops/summary").set("Authorization", `Bearer ${TOKEN}`)).status).toBe(404);
  });

  it("is off when no token is configured", async () => {
    const env = setup();
    expect((await request(env.app).get("/api/ops/summary").set("Authorization", "Bearer anything")).status).toBe(401);
    expect(loadConfig({ OPS_API_TOKEN: "short" }).opsApiToken).toBeNull();
  });
});

describe("migrations", () => {
  it("enable RLS on every table they create and never grant anon access", () => {
    for (const file of ["0005_core_data.sql", "0006_portal_v1.sql"]) {
      const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
      const tables = [...sql.matchAll(/create table public\.(\w+)/g)].map((m) => m[1]);
      expect(tables.length).toBeGreaterThan(0);
      for (const t of tables) expect(sql, `${file}: ${t}`).toContain(`alter table public.${t} enable row level security`);
      expect(sql).not.toMatch(/grant [^;]* to anon/);
      expect(sql).toMatch(/NOT APPLIED/);
    }
  });
});
