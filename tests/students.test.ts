// Student creation in Supabase only. Fixtures: Arzo Luper and luperdev@gmail.com addresses.
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { studentFormMessages } from "../shared/student-form";
import { createApp } from "../server/app";
import { buildDeps } from "./helpers";
import { emptyTables, memoryCoreStore, TEACHER_ACCOUNT } from "./memoryStore";

const users = { teach: { role: "teacher" as const }, parent: { role: "guardian" as const, links: [] } };
const adult = { fullName: "Arzo Luper", ageCategory: "adult", email: "LuperDev@gmail.com", format: "Zoom" };
const child = { fullName: "Arzo Luper Jr", ageCategory: "child", guardianName: "Arzo Luper", guardianEmail: "LuperDev+Guardian@gmail.com" };

function setup() {
  const tables = emptyTables();
  const core = memoryCoreStore(tables);
  const createStudent = vi.fn(core.createStudent);
  const audit = vi.fn(async () => undefined);
  const deps = buildDeps(users, { createStudent, audit }, tables);
  const app = createApp(deps);
  const post = (path: string, body: any, who = "teach") => request(app).post(path).set("Authorization", `Bearer ${who}`).send(body);
  const get = (path: string, who = "teach") => request(app).get(path).set("Authorization", `Bearer ${who}`);
  return { post, get, createStudent, audit, tables };
}

describe("adult student creation", () => {
  it("creates the adult in Supabase as their own payer, owned by the teacher, with no GoHighLevel id", async () => {
    const { post, get, tables } = setup();
    const res = await post("/api/teacher/students", adult);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ student: { fullName: "Arzo Luper" }, guardian: null });
    const [student] = tables.students;
    expect(student).toMatchObject({ fullName: "Arzo Luper", email: "luperdev@gmail.com", isMinor: false, format: "Zoom", teacherAccountId: TEACHER_ACCOUNT, ghlContactId: null, billingContactId: null });
    expect(tables.payers).toEqual([expect.objectContaining({ id: student.payerId, fullName: "Arzo Luper", email: "luperdev@gmail.com", guardianId: null })]);
    expect(tables.guardians).toEqual([]);
    const list = await get("/api/teacher/students");
    expect(list.body.students).toHaveLength(1);
    expect(list.body.students[0]).not.toHaveProperty("payerId");
    expect(list.body.students[0]).not.toHaveProperty("ghlContactId");
  });

  it("ignores contact ids an old client still sends", async () => {
    const { post, createStudent } = setup();
    expect((await post("/api/teacher/students", { ...adult, ghlContactId: "Nk2ovYQlqpRZJT3fwJzR", billingContactId: "x" })).status).toBe(200);
    expect(createStudent.mock.calls[0][0]).not.toHaveProperty("ghlContactId");
    expect(createStudent.mock.calls[0][0]).not.toHaveProperty("billingContactId");
  });
});

describe("child + guardian creation", () => {
  it("creates the child, the guardian, the link between them and a guardian payer", async () => {
    const { post, tables } = setup();
    const res = await post("/api/teacher/students", child);
    expect(res.status).toBe(200);
    expect(res.body.guardian).toBe("created");
    const [student] = tables.students;
    expect(student).toMatchObject({ isMinor: true, guardianName: "Arzo Luper", guardianEmail: "luperdev+guardian@gmail.com", email: null });
    expect(tables.guardians).toEqual([expect.objectContaining({ fullName: "Arzo Luper", email: "luperdev+guardian@gmail.com" })]);
    expect(tables.studentGuardians).toEqual([{ studentId: student.id, guardianId: tables.guardians[0].id }]);
    expect(tables.payers.find((p) => p.id === student.payerId)?.guardianId).toBe(tables.guardians[0].id);
  });

  it("reuses the guardian for a sibling, so both share one payer", async () => {
    const { post, tables } = setup();
    await post("/api/teacher/students", child);
    const sibling = await post("/api/teacher/students", { ...child, fullName: "Arzo Luper III" });
    expect(sibling.status).toBe(200);
    expect(sibling.body.guardian).toBe("reused");
    expect(tables.guardians).toHaveLength(1);
    expect(tables.payers).toHaveLength(1);
    expect(new Set(tables.students.map((s) => s.payerId)).size).toBe(1);
  });

  it("lets a child use the guardian's email as their own", async () => {
    const { post } = setup();
    await post("/api/teacher/students", { ...child, email: "luperdev+guardian@gmail.com" });
    expect((await post("/api/teacher/students", { ...child, fullName: "Arzo Luper III", email: "luperdev+guardian@gmail.com" })).status).toBe(200);
  });
});

describe("duplicate student prevention", () => {
  it("refuses a second student with the same email, checked against Supabase", async () => {
    const { post, createStudent } = setup();
    await post("/api/teacher/students", adult);
    const res = await post("/api/teacher/students", { ...adult, fullName: "Someone Else" });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: "student_already_exists", message: studentFormMessages.duplicateEmail });
    expect(createStudent).toHaveBeenCalledTimes(1);
  });

  it("refuses the same child under the same guardian, whatever the spacing or case", async () => {
    const { post, tables } = setup();
    await post("/api/teacher/students", child);
    const res = await post("/api/teacher/students", { ...child, fullName: "  arzo   luper jr ", guardianEmail: "LUPERDEV+GUARDIAN@gmail.com" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(studentFormMessages.duplicateStudent);
    expect(tables.students).toHaveLength(1);
    expect(tables.guardians).toHaveLength(1);
  });

  it("allows the same child name under a different guardian", async () => {
    const { post } = setup();
    await post("/api/teacher/students", child);
    expect((await post("/api/teacher/students", { ...child, guardianEmail: "luperdev+other@gmail.com" })).status).toBe(200);
  });
});

describe("validation and access", () => {
  it.each([
    ["child without a guardian", { ...child, guardianName: "" }],
    ["child without a guardian email", { ...child, guardianEmail: "" }],
    ["adult without an email", { fullName: "Arzo Luper", ageCategory: "adult" }],
    ["no name", { ...child, fullName: " " }],
  ])("rejects a %s", async (_n, body) => {
    const { post, createStudent } = setup();
    expect((await post("/api/teacher/students", body)).status).toBe(400);
    expect(createStudent).not.toHaveBeenCalled();
  });

  it("is teacher-only, and the GoHighLevel contact search is gone", async () => {
    const { post, get } = setup();
    expect((await post("/api/teacher/students", child, "parent")).status).toBe(403);
    expect((await get("/api/teacher/ghl/contacts")).status).toBe(404);
  });

  it("creates a student and can invite the guardian straight away", async () => {
    const { post, get } = setup();
    const created = await post("/api/teacher/students", child);
    const row = (await get("/api/teacher/students")).body.students.find((s: any) => s.id === created.body.student.id);
    const invite = await post("/api/teacher/invitations", { method: "code", role: "guardian", email: row.guardianEmail, name: row.guardianName, studentIds: [row.id] });
    expect(invite.status).toBe(200);
    expect(invite.body.credential).toMatch(/^SFTM-/);
  });
});
