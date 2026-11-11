// QA #11: due and overdue are counted in America/Los_Angeles, and a session invoice is never due before its hold ends.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { daysOverdue, dueLabel, studioDate } from "../shared/dates";
import { buildDeps, captureMail, fakeGoogle, fixtureTables, STUDENT_A } from "./helpers";
import { TEACHER_ACCOUNT } from "./memoryStore";

const at = (iso: string) => Date.parse(iso);
const JUST_BEFORE_MIDNIGHT_PT = at("2026-11-11T07:59:30Z"); // Tue Nov 10, 11:59:30 PM PT
const QA_TIME = at("2026-11-11T00:06:00Z"); // Tue Nov 10, 4:06 PM PT (already Nov 11 in UTC)
const JUST_AFTER_MIDNIGHT_PT = at("2026-11-11T08:00:30Z"); // Wed Nov 11, 12:00:30 AM PT

describe("overdue days in Los Angeles", () => {
  it("an invoice due Nov 10 is 'Due today' all day Nov 10 Pacific, including just before midnight", () => {
    for (const now of [QA_TIME, JUST_BEFORE_MIDNIGHT_PT, at("2026-11-10T08:00:00Z")]) {
      expect(studioDate(now)).toBe("2026-11-10");
      expect(daysOverdue("2026-11-10", now)).toBe(0);
      expect(dueLabel("2026-11-10", now)).toBe("Due today");
    }
  });

  it("becomes 'Overdue · 1 day' only after midnight Pacific", () => {
    expect(dueLabel("2026-11-10", JUST_AFTER_MIDNIGHT_PT)).toBe("Overdue · 1 day");
    expect(dueLabel("2026-11-10", at("2026-11-13T09:00:00Z"))).toBe("Overdue · 3 days");
    expect(dueLabel("2026-11-11", JUST_BEFORE_MIDNIGHT_PT)).toBe("Due tomorrow");
    expect(dueLabel("2026-11-20", JUST_BEFORE_MIDNIGHT_PT)).toBe("Awaiting payment");
  });

  it("the student and teacher views use the Pacific count, not UTC date math", async () => {
    const { readFileSync } = await import("node:fs");
    const student = readFileSync("src/portal/vm/useStudentVM.ts", "utf8");
    expect(student).toContain("daysOverdue(firstOpen.dueDate)");
    expect(student).toContain("dueLabel(firstOpen.dueDate)");
    expect(student).not.toMatch(/Date\.now\(\) - new Date\(firstOpen\.dueDate\)/);
    expect(readFileSync("src/portal/vm/useTeacherVM.ts", "utf8")).toContain("daysOverdue(i.dueDate) > 0");
  });
});

describe("session invoice dates", () => {
  function setup(nowMs: number) {
    const tables = fixtureTables();
    for (const s of tables.students) s.teacherAccountId = TEACHER_ACCOUNT;
    tables.hours[TEACHER_ACCOUNT] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 }));
    const users = { adultqa: { role: "student" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] } };
    const app = createApp(buildDeps(users, {}, tables, { mailer: captureMail().mailer, google: fakeGoogle().client, now: () => nowMs }));
    const book = (startTime: string) => request(app).post("/api/lessons").set("Authorization", "Bearer adultqa").send({ studentId: STUDENT_A, startTime, location: "Zoom" });
    const dashboard = () => request(app).get("/api/portal/dashboard").set("Authorization", "Bearer adultqa");
    return { tables, book, dashboard };
  }

  it("is issued on the Pacific date and due on the day the hold ends (QA: booked 3:47 PM PT Nov 10, hold to Nov 11 3:47 PM)", async () => {
    const env = setup(at("2026-11-10T23:47:00Z"));
    expect((await env.book("2026-12-05T10:00:00-08:00")).status).toBe(200);
    const [inv] = env.tables.invoices;
    const [lesson] = env.tables.lessons;
    expect(lesson.holdExpiresAt).toBe("2026-11-11T23:47:00.000Z");
    expect(inv).toMatchObject({ kind: "session", issueDate: "2026-11-10", dueDate: "2026-11-11" });
    expect(inv.dueDate >= studioDate(Date.parse(lesson.holdExpiresAt!))).toBe(true);
  });

  it("booked just before midnight Pacific: dated Nov 10, due Nov 11 with the hold, and the home reads 'Due tomorrow'", async () => {
    const env = setup(JUST_BEFORE_MIDNIGHT_PT);
    await env.book("2026-12-05T10:00:00-08:00");
    expect(env.tables.invoices[0]).toMatchObject({ issueDate: "2026-11-10", dueDate: "2026-11-11" });
    const dash = (await env.dashboard()).body;
    expect(dueLabel(dash.billing.openInvoices[0].dueDate, JUST_BEFORE_MIDNIGHT_PT)).toBe("Due tomorrow");
  });

  it("a hold cut short by an early lesson start is due that day, never before the issue date", async () => {
    const env = setup(QA_TIME);
    await env.book("2026-11-10T19:00:00-08:00"); // 7 PM PT the same evening: the hold ends at the lesson start
    expect(env.tables.lessons[0].holdExpiresAt).toBe("2026-11-11T03:00:00.000Z");
    expect(env.tables.invoices[0]).toMatchObject({ issueDate: "2026-11-10", dueDate: "2026-11-10" });
  });
});
