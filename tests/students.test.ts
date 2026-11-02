import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { createGhlClient } from "../server/integrations/ghl";
import { buildDeps, fakeGhl } from "./helpers";

const users = { teach: { role: "teacher" as const }, parent: { role: "guardian" as const, links: [] } };
const child = { fullName: "Rowan Sample", ageCategory: "child", guardianName: "Pat Sample", guardianEmail: "PAT@example.com", ghlContactId: "c1", billingContactId: "c2" };

function setup(ghl = fakeGhl()) {
  const rows: any[] = [];
  const createStudent = vi.fn(async (i: any) => {
    if (rows.some((r) => r.ghlContactId === i.ghlContactId)) return null;
    const row = { ...i, id: `33333333-3333-4333-8333-33333333333${rows.length}`, firstName: i.fullName.split(" ")[0], styleLine: "", format: "In person", studentSince: null };
    rows.push(row);
    return row;
  });
  const createInvitation = vi.fn(async (i: any) => ({ ...i, id: "inv", status: "pending" }));
  const app = createApp(buildDeps(users, ghl, {
    createStudent, createInvitation,
    listStudents: async () => rows,
    getStudents: async (ids: string[]) => rows.filter((r) => ids.includes(r.id)),
    studentCounts: async () => ({}),
    studentAccounts: async () => ({}),
  } as any));
  const post = (path: string, body: any, who = "teach") => request(app).post(path).set("Authorization", `Bearer ${who}`).send(body);
  const get = (path: string, who = "teach") => request(app).get(path).set("Authorization", `Bearer ${who}`);
  return { post, get, createStudent };
}

describe("adding students", () => {
  it("creates a student, lists them straight away, and can invite them", async () => {
    const { post, get } = setup();
    const created = await post("/api/teacher/students", child);
    expect(created.status).toBe(200);
    const list = await get("/api/teacher/students");
    const row = list.body.students.find((s: any) => s.id === created.body.student.id);
    expect(row).toMatchObject({ fullName: "Rowan Sample", isMinor: true, guardianEmail: "pat@example.com", ghlContactId: "c1", billingContactId: "c2" });
    const invite = await post("/api/teacher/invitations", { method: "code", role: "guardian", email: row.guardianEmail, name: row.guardianName, studentIds: [row.id] });
    expect(invite.status).toBe(200);
    expect(invite.body.credential).toMatch(/^SFTM-/);
  });

  it("bills an adult's own contact unless told otherwise and stores no guardian", async () => {
    const { post, createStudent } = setup();
    expect((await post("/api/teacher/students", { fullName: "Ada Sample", ageCategory: "adult", email: "ada@example.com", guardianName: "Nope", ghlContactId: "c9" })).status).toBe(200);
    expect(createStudent.mock.calls[0][0]).toMatchObject({ isMinor: false, billingContactId: "c9", guardianName: null, guardianEmail: null });
  });

  it.each([
    ["child without a guardian", { ...child, guardianName: "" }],
    ["child without a guardian email", { ...child, guardianEmail: "" }],
    ["adult without an email", { fullName: "A B", ageCategory: "adult", ghlContactId: "c1" }],
    ["no contact", { ...child, ghlContactId: "" }],
    ["no name", { ...child, fullName: " " }],
  ])("rejects a %s", async (_n, body) => {
    const { post, createStudent } = setup();
    expect((await post("/api/teacher/students", body)).status).toBe(400);
    expect(createStudent).not.toHaveBeenCalled();
  });

  it("refuses a contact GoHighLevel doesn't have", async () => {
    const { ApiError } = await import("../server/http");
    const { post, createStudent } = setup(fakeGhl({ getContact: async () => { throw new ApiError(404, "not_found", "Not found."); } }));
    const res = await post("/api/teacher/students", child);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("contact_not_found");
    expect(createStudent).not.toHaveBeenCalled();
  });

  it("refuses linking the same contact twice", async () => {
    const { post } = setup();
    await post("/api/teacher/students", child);
    const res = await post("/api/teacher/students", child);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("contact_already_linked");
  });

  it("marks contacts that are already linked when importing", async () => {
    const { post, get } = setup(fakeGhl({ searchContacts: async () => [{ id: "c1", name: "A", email: null }, { id: "c7", name: "B", email: "b@example.com" }] }));
    await post("/api/teacher/students", child);
    const res = await get("/api/teacher/ghl/contacts?query=a");
    expect(res.body.contacts.map((c: any) => c.studentName)).toEqual(["Rowan Sample", null]);
  });

  it("is teacher-only", async () => {
    const { post, get } = setup();
    expect((await post("/api/teacher/students", child, "parent")).status).toBe(403);
    expect((await get("/api/teacher/ghl/contacts", "parent")).status).toBe(403);
  });

  it("searches contacts in this location with GoHighLevel's documented call", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ contacts: [{ id: "c", firstName: "Ann", lastName: "Lee", email: "a@example.com" }] }), { status: 200 }));
    const client = createGhlClient({ token: "t", locationId: "loc", lessonCalendarId: "cal", timezone: "UTC" } as any, fetchImpl as any);
    expect(await client.searchContacts("ann")).toEqual([{ id: "c", name: "Ann Lee", email: "a@example.com" }]);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toContain("/contacts/search");
    expect(JSON.parse(init.body)).toMatchObject({ locationId: "loc", query: "ann" });
  });
});
