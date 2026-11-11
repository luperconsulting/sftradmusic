// QA round on the student home (Adultqa): referrals on sign-up with a session, booked lessons and invoices
// on the dashboard, the booking date window, and no writes to Google Calendar. luperdev@gmail.com fixtures only.
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { createGoogleCalendar, FREEBUSY_SCOPE } from "../server/integrations/googleCalendar";
import { bookingMonthRange, dateGrid } from "../src/portal/vm/common";
import { buildDeps, captureMail, fakeGoogle, fixtureTables, STUDENT_A, STUDENT_B } from "./helpers";
import { TEACHER_ACCOUNT } from "./memoryStore";

const T0 = Date.parse("2026-11-16T17:00:00Z"); // Mon 16 Nov 2026, 9:00 AM Los Angeles
const la = (date: string, time: string) => new Date(`${date}T${time}:00-08:00`).toISOString();
const users = {
  arzo: { role: "student" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] },
  guardian: { role: "guardian" as const, links: [{ studentId: STUDENT_B, canBook: true, canPay: true }] },
  teach: { role: "teacher" as const },
};

function setup() {
  const tables = fixtureTables();
  for (const s of tables.students) s.teacherAccountId = TEACHER_ACCOUNT;
  // QA's hours: Monday to Saturday, 8:00 to 17:00.
  tables.hours[TEACHER_ACCOUNT] = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 480, endMinute: 1020 }));
  const google = fakeGoogle([]);
  const app = createApp(buildDeps(users, {}, tables, { mailer: captureMail().mailer, google: google.client, now: () => T0 }));
  const as = (who: string) => ({
    get: (p: string) => request(app).get(p).set("Authorization", `Bearer ${who}`),
    post: (p: string, b: object = {}) => request(app).post(p).set("Authorization", `Bearer ${who}`).send(b),
  });
  return { tables, as, google };
}

describe("booking date window", () => {
  it("returns Sat Nov 28 and Mon Nov 30 from the server for Mon-Sat hours (they aren't busy or missing)", async () => {
    const env = setup();
    const res = await env.as("arzo").get(`/api/lessons/slots?studentId=${STUDENT_A}&from=2026-11-16&to=2026-11-30`);
    const dates = Object.keys(res.body.days);
    expect(dates).toContain("2026-11-28");
    expect(dates).toContain("2026-11-30");
    expect(dates).not.toContain("2026-11-22"); // Sunday
    expect(dates).toHaveLength(13);
  });

  it("the picker shows every open date in the month; it used to stop at 16 and drop late-month dates", () => {
    const november = ["02", "03", "04", "05", "06", "07", "09", "10", "11", "12", "13", "14", "16", "17", "18", "19", "20", "21", "23", "24", "25", "26", "27", "28", "30"].map((d) => `2026-11-${d}`);
    const grid = dateGrid(november);
    expect(grid.filter(Boolean)).toEqual(november);
    expect(grid.length % 8).toBe(0);
    expect(dateGrid(["2026-12-01"])).toHaveLength(16);
  });

  it("counts the month and today in Los Angeles time, so an evening on Nov 30 still offers Nov 30", () => {
    const eveningNov30 = new Date("2026-12-01T04:00:00Z"); // 8 PM PST on Nov 30
    expect(bookingMonthRange(0, eveningNov30)).toMatchObject({ from: "2026-11-30", to: "2026-11-30" });
    expect(bookingMonthRange(1, eveningNov30)).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
    expect(bookingMonthRange(0, new Date("2026-11-10T20:00:00Z"))).toMatchObject({ from: "2026-11-10", to: "2026-11-30" });
  });
});

describe("booked lessons and invoices on the student home", () => {
  it("returns the held lesson with its hold time and invoice, and the unpaid invoice in billing history", async () => {
    const env = setup();
    const booked = await env.as("arzo").post("/api/lessons", { studentId: STUDENT_A, startTime: la("2026-12-05", "10:00"), location: "Music City SF" });
    expect(booked.status).toBe(200);
    const dash = (await env.as("arzo").get("/api/portal/dashboard")).body;
    expect(dash.upcoming).toEqual([expect.objectContaining({ status: "pending_payment", holdExpiresAt: new Date(T0 + 24 * 3600000).toISOString(), invoiceId: expect.any(String), locationLabel: "Music City SF" })]);
    const inv = dash.billing.history.find((i: any) => i.id === dash.upcoming[0].invoiceId);
    expect(inv).toMatchObject({ kind: "session", total: 100, amountDue: 100, status: "sent", paymentMethod: "zelle" });
    expect(dash.billing.outstanding).toBe(100);
    expect(dash.packageLessons).toBe(0);
    expect(dash.referrals.code).toMatch(/^SFTM-[A-Z0-9]{8}$/);
  });

  it("the dashboard is the full view for an enrolled student, even with no notes, videos or past lessons", () => {
    const vm = readFileSync("src/portal/vm/useStudentVM.ts", "utf8");
    expect(vm).toContain("const empty = !loading && !!data && !student;");
    expect(vm).toContain("normal: !loading && !!data && !!student");
    const view = readFileSync("src/portal/views/student/StudentDashboardView.tsx", "utf8");
    expect(view).toContain("<UpcomingLessonsSection v={v} />");
    expect(view).toContain("<ReferralSection v={v} />");
  });
});

describe("referral code at sign-up with a single session", () => {
  it("takes $15 off the first lesson, and gives the referrer $25 once when that lesson is paid", async () => {
    const env = setup();
    const code = (await env.as("arzo").get(`/api/referrals?studentId=${STUDENT_A}`)).body.code;
    expect((await env.as("guardian").post("/api/referrals/apply", { studentId: STUDENT_B, code })).status).toBe(200);

    const booked = await env.as("guardian").post("/api/lessons", { studentId: STUDENT_B, startTime: la("2026-12-05", "10:00"), location: "Zoom" });
    const first = env.tables.invoices.find((i) => i.studentId === STUDENT_B)!;
    expect(first.totalCents).toBe(8500);
    expect(first.lines.map((l) => l.label)).toEqual(["60-min lesson · 2026-12-05", "Referral discount"]);
    expect((await env.as("arzo").get(`/api/referrals?studentId=${STUDENT_A}`)).body).toMatchObject({ pending: [{ name: "Arzo" }], completed: [] });

    await env.as("teach").post(`/api/teacher/invoices/${first.id}/mark-paid`, { method: "zelle" });
    await env.as("teach").post(`/api/teacher/invoices/${first.id}/mark-paid`, { method: "zelle" });
    expect(env.tables.lessons.find((l) => l.id === booked.body.lessons[0].id)?.status).toBe("scheduled");
    expect(env.tables.referralCredits).toEqual([expect.objectContaining({ studentId: STUDENT_A, amountCents: 2500 })]);
    expect((await env.as("arzo").get(`/api/referrals?studentId=${STUDENT_A}`)).body).toMatchObject({ pending: [], completed: [{ name: "Arzo" }], creditsAvailableCents: 2500 });

    // The referrer's next lesson invoice is $100 - $25.
    await env.as("arzo").post("/api/lessons", { studentId: STUDENT_A, startTime: la("2026-12-07", "10:00"), location: "Zoom" });
    expect(env.tables.invoices.find((i) => i.studentId === STUDENT_A)!.totalCents).toBe(7500);
  });

  it("the invite page sends the typed referral code with the email code", () => {
    const vm = readFileSync("src/portal/vm/useAuthVM.ts", "utf8");
    expect(vm).toMatch(/"\/invitations\/verify-code", \{ method: "POST", body: \{ email: address, code: otp, \.\.\.\(referralCode \? \{ referralCode \} : \{\}\) \} \}/);
    expect(readFileSync("src/portal/views/auth/InviteView.tsx", "utf8")).toContain("Referral code");
  });
});

describe("Google Calendar is read-only", () => {
  it("booking only reads free/busy; the client has no way to create events", async () => {
    const env = setup();
    await env.as("arzo").post("/api/lessons", { studentId: STUDENT_A, startTime: la("2026-12-05", "10:00"), location: "Zoom" });
    expect(env.google.state.calls).toBeGreaterThan(0);
    const client = createGoogleCalendar({ projectNumber: "1", poolId: "p", providerId: "v", serviceAccountEmail: "sa@example.iam.gserviceaccount.com", calendarIds: ["c"] }, async () => "t", (async () => new Response("{}")) as any);
    expect(Object.keys(client)).toEqual(["busy"]);
    expect(FREEBUSY_SCOPE).toBe("https://www.googleapis.com/auth/calendar.freebusy");
    const src = readFileSync("server/integrations/googleCalendar.ts", "utf8");
    expect(src).not.toMatch(/calendar\/v3\/calendars\/[^"]*\/events|events\.insert|method: "(PUT|PATCH|DELETE)"/);
  });
});
