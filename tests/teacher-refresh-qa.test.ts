// QA #8/#9: a published note shows up right away and in the Students counts; a held (pending payment) lesson
// counts as upcoming on /teacher/students. Fixtures: Adultqa (Arzo Luper test data), luperdev addresses.
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import type { NoteDTO } from "../shared/portal-types";
import { buildDeps, captureMail, fakeGoogle, fixtureTables, STUDENT_A } from "./helpers";
import { TEACHER_ACCOUNT } from "./memoryStore";

const T0 = Date.parse("2026-11-16T17:00:00Z");

function setup() {
  const tables = fixtureTables();
  for (const s of tables.students) s.teacherAccountId = TEACHER_ACCOUNT;
  tables.hours[TEACHER_ACCOUNT] = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 480, endMinute: 1020 }));
  const notes: NoteDTO[] = [];
  let n = 0;
  const users = { adultqa: { role: "student" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] }, teach: { role: "teacher" as const } };
  const app = createApp(buildDeps(users, {
    saveNote: async (id, input) => {
      const row: NoteDTO = { ...(id ? notes.find((x) => x.id === id)! : { id: `0eca786b-0000-4000-8000-${String(++n).padStart(12, "0")}`, status: "draft" as const, publishedAt: null }), ...input };
      notes.splice(0, notes.length, ...notes.filter((x) => x.id !== row.id), row);
      return row;
    },
    publishNote: async (id) => { const row = notes.find((x) => x.id === id)!; row.status = "published"; row.publishedAt = new Date(T0).toISOString(); return { ...row }; },
    listNotes: async (studentId, { publishedOnly }) => notes.filter((x) => x.studentId === studentId && (!publishedOnly || x.status === "published")),
    studentCounts: async () => {
      const out: Record<string, { notes: number; videos: number; assignments: number }> = {};
      for (const x of notes) (out[x.studentId] ??= { notes: 0, videos: 0, assignments: 0 }).notes++;
      return out;
    },
  }, tables, { mailer: captureMail().mailer, google: fakeGoogle().client, now: () => T0 }));
  const as = (who: string) => ({
    get: (p: string) => request(app).get(p).set("Authorization", `Bearer ${who}`),
    post: (p: string, b: object = {}) => request(app).post(p).set("Authorization", `Bearer ${who}`).send(b),
  });
  return { as, tables };
}

const noteBody = { studentId: STUDENT_A, lessonDate: "2026-11-16", title: "Reel in D", summary: "Good lesson.", technique: "", practice: "Ten minutes a day.", goals: "", prep: "" };

describe("Students list counts", () => {
  it("counts a held (pending payment) lesson as upcoming and the published note", async () => {
    const env = setup();
    const before = (await env.as("teach").get("/api/teacher/students")).body.students.find((s: any) => s.id === STUDENT_A);
    expect(before).toMatchObject({ nextLesson: null, upcomingCount: 0, noteCount: 0 });

    const booked = await env.as("adultqa").post("/api/lessons", { studentId: STUDENT_A, startTime: "2026-12-05T10:00:00-08:00", location: "Music City SF" });
    expect(booked.body.lessons[0].status).toBe("pending_payment");
    const created = await env.as("teach").post("/api/teacher/notes", noteBody);
    await env.as("teach").post(`/api/teacher/notes/${created.body.id}/publish`);

    const row = (await env.as("teach").get("/api/teacher/students")).body.students.find((s: any) => s.id === STUDENT_A);
    expect(row).toMatchObject({ nextLesson: "2026-12-05T18:00:00.000Z", nextLessonStatus: "pending_payment", upcomingCount: 1, noteCount: 1 });
  });

  it("the Students screen labels a held next lesson and re-reads the roster when it opens or the tab regains focus", () => {
    const vm = readFileSync("src/portal/vm/useTeacherVM.ts", "utf8");
    expect(vm).toContain(`s.nextLessonStatus === "pending_payment" ? " · pending payment" : ""`);
    expect(vm).toMatch(/if \(screen === "students" \|\| screen === "overview"\) void refreshRoster\(\);/);
    expect(vm).toContain(`document.addEventListener("visibilitychange", onVisible)`);
  });
});

describe("publishing a note", () => {
  it("returns the published note, which the profile and the student's portal list right away", async () => {
    const env = setup();
    const created = await env.as("teach").post("/api/teacher/notes", noteBody);
    expect(created.status).toBe(200);
    const published = await env.as("teach").post(`/api/teacher/notes/${created.body.id}/publish`);
    expect(published.body).toMatchObject({ id: created.body.id, status: "published", publishedAt: expect.any(String), title: "Reel in D" });
    const profile = await env.as("teach").get(`/api/teacher/students/${STUDENT_A}`);
    expect(profile.body.notes).toEqual([expect.objectContaining({ id: created.body.id, status: "published" })]);
    const dash = await env.as("adultqa").get("/api/portal/dashboard");
    expect(dash.body.notes).toEqual([expect.objectContaining({ id: created.body.id })]);
  });

  it("the editor shows an inline result, puts the note in the list at once, and refreshes profile and counts", () => {
    const vm = readFileSync("src/portal/vm/useTeacherVM.ts", "utf8");
    expect(vm).toContain("setNoteNotice({ kind: \"ok\", text: `Published. ${who} can see this note now.` });");
    expect(vm).toMatch(/const showNoteInList = \(saved: NoteDTO\) => \{[\s\S]*?setProfile\([\s\S]*?void loadProfile\(saved\.studentId\);[\s\S]*?void refreshRoster\(\);/);
    expect(readFileSync("src/portal/views/teacher/NotesEditorView.tsx", "utf8")).toContain("v.noteNotice.text");
  });
});
