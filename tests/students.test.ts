import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { studentFormMessages } from "../shared/student-form";
import { createApp } from "../server/app";
import { createGhlClient } from "../server/integrations/ghl";
import { buildDeps, fakeGhl } from "./helpers";

/** Existing studio contact. Tests reuse this id and must not call GoHighLevel. */
const ARZO = { fullName: "Arzo Luper", email: "luperdev@gmail.com", ghlContactId: "RQgd4luPVk9r2srPBlHr" };

const users = { teach: { role: "teacher" as const }, parent: { role: "guardian" as const, links: [] } };
const child = { fullName: "Rowan Sample", ageCategory: "child", guardianName: "Pat Sample", guardianEmail: "PAT@example.com", ghlContactId: "c1", billingContactId: "c2" };

function setup(ghl = fakeGhl()) {
  const rows: any[] = [];
  const createStudent = vi.fn(async (i: any) => {
    if (rows.some((r) => r.ghlContactId === i.ghlContactId)) return null;
    const row = { ...i, id: `33333333-3333-4333-8333-33333333333${rows.length}`, firstName: i.fullName.split(" ")[0], styleLine: "", format: i.format ?? "In person", studentSince: null };
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

const newChild = { fullName: "Rowan Sample", ageCategory: "child", guardianName: "Pat Sample", guardianEmail: "pat@example.com" };
const newAdult = { fullName: "Ada Sample", ageCategory: "adult", email: "ada@example.com" };
const contact = (id: string, email: string | null = null) => ({ id, name: id, email });

describe("enrolling without an existing contact", () => {
  it("creates one contact for an adult, who pays their own invoices", async () => {
    const createContact = vi.fn(async (i: any) => ({ contact: contact("adult1", i.email), created: true }));
    const { post, createStudent } = setup(fakeGhl({ createContact }));
    const res = await post("/api/teacher/students", newAdult);
    expect(res.status).toBe(200);
    expect(res.body.contacts).toEqual({ student: "created", billing: "same" });
    expect(createContact).toHaveBeenCalledTimes(1);
    expect(createStudent.mock.calls[0][0]).toMatchObject({ ghlContactId: "adult1", billingContactId: "adult1", isMinor: false });
  });

  it("creates a student contact and a guardian billing contact for a child, saving both", async () => {
    const createContact = vi.fn(async (i: any) => ({ contact: contact(i.email ? "guardian1" : "child1", i.email), created: true }));
    const { post, createStudent } = setup(fakeGhl({ createContact }));
    const res = await post("/api/teacher/students", newChild);
    expect(res.status).toBe(200);
    expect(res.body.contacts).toEqual({ student: "created", billing: "created" });
    expect(createStudent.mock.calls[0][0]).toMatchObject({ ghlContactId: "child1", billingContactId: "guardian1", guardianEmail: "pat@example.com" });
  });

  it("reuses a guardian's contact, so siblings share one payer", async () => {
    const createContact = vi.fn(async (i: any) => ({ contact: contact(`child-${i.name}`), created: true }));
    const { post, createStudent } = setup(fakeGhl({ createContact, findContactByEmail: async (e) => (e === "pat@example.com" ? contact("guardian1", e) : null) }));
    expect((await post("/api/teacher/students", newChild)).body.contacts.billing).toBe("reused");
    expect((await post("/api/teacher/students", { ...newChild, fullName: "Skye Sample" })).status).toBe(200);
    expect(createContact).toHaveBeenCalledTimes(2);
    expect(createStudent.mock.calls.map((c: any) => c[0].billingContactId)).toEqual(["guardian1", "guardian1"]);
  });

  it("links an adult's existing contact instead of creating another", async () => {
    const createContact = vi.fn();
    const { post, createStudent } = setup(fakeGhl({ createContact, findContactByEmail: async () => contact("existing", "ada@example.com") }));
    const res = await post("/api/teacher/students", newAdult);
    expect(res.body.contacts.student).toBe("reused");
    expect(createContact).not.toHaveBeenCalled();
    expect(createStudent.mock.calls[0][0].ghlContactId).toBe("existing");
  });

  it("uses the match GoHighLevel names when it refuses a duplicate", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "duplicate", meta: { contactId: "matched" } }), { status: 400 }));
    const client = createGhlClient({ token: "t", locationId: "loc", lessonCalendarId: "cal", timezone: "UTC" } as any, fetchImpl as any);
    expect(await client.createContact({ name: "A B", email: "a@example.com" })).toMatchObject({ contact: { id: "matched" }, created: false });
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toMatch(/\/contacts\/$/);
    expect(JSON.parse(init.body)).toMatchObject({ locationId: "loc", firstName: "A", lastName: "B", email: "a@example.com" });
  });

  it("doesn't put a parent's email on the child's contact", async () => {
    const createContact = vi.fn(async (i: any) => ({ contact: contact(i.name, i.email), created: true }));
    const { post } = setup(fakeGhl({ createContact }));
    await post("/api/teacher/students", { ...newChild, email: "pat@example.com" });
    expect(createContact.mock.calls.find((c: any) => c[0].name === "Rowan Sample")![0].email).toBeNull();
  });

  it("refuses enrolling the same child or adult twice, creating nothing more", async () => {
    const createContact = vi.fn(async (i: any) => ({ contact: contact(`c-${i.name}`, i.email), created: true }));
    const { post } = setup(fakeGhl({ createContact }));
    await post("/api/teacher/students", newChild);
    await post("/api/teacher/students", newAdult);
    const before = createContact.mock.calls.length;
    for (const body of [newChild, { ...newChild, fullName: "rowan sample" }, newAdult]) {
      const res = await post("/api/teacher/students", body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("student_already_exists");
    }
    expect(createContact).toHaveBeenCalledTimes(before);
  });

  it("saves no student when a contact can't be created, and reuses the guardian on retry", async () => {
    const { ApiError } = await import("../server/http");
    let guardianMade = false;
    const createContact = vi.fn(async (i: any) => {
      if (i.email) { guardianMade = true; return { contact: contact("guardian1", i.email), created: true }; }
      if (createContact.mock.calls.length <= 2) throw new ApiError(503, "ghl_contact_permission", "No permission.");
      return { contact: contact("child1"), created: true };
    });
    const { post, createStudent } = setup(fakeGhl({ createContact, findContactByEmail: async (e) => (guardianMade ? contact("guardian1", e) : null) }));
    const res = await post("/api/teacher/students", newChild);
    expect(res.status).toBe(503);
    expect(createStudent).not.toHaveBeenCalled();
    expect((await post("/api/teacher/students", newChild)).status).toBe(200);
    expect(createContact.mock.calls.filter((c: any) => c[0].email)).toHaveLength(1);
  });

  it("contacts GoHighLevel not at all when the database isn't ready", async () => {
    const { ApiError } = await import("../server/http");
    const createContact = vi.fn();
    const findContactByEmail = vi.fn();
    const app = createApp(buildDeps(users, fakeGhl({ createContact, findContactByEmail }), { checkStudentSchema: async () => { throw new ApiError(503, "migration_required", "Update needed."); } } as any));
    const res = await request(app).post("/api/teacher/students").set("Authorization", "Bearer teach").send(newAdult);
    expect(res.status).toBe(503);
    expect(findContactByEmail).not.toHaveBeenCalled();
    expect(createContact).not.toHaveBeenCalled();
  });

  it("records contacts left behind if saving the student fails", async () => {
    const deleteContact = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const app = createApp(buildDeps(users, fakeGhl({ deleteContact, createContact: async () => ({ contact: contact("orphan"), created: true }) }), {
      audit, listStudents: async () => [], createStudent: async () => { throw new Error("db"); },
    } as any));
    const res = await request(app).post("/api/teacher/students").set("Authorization", "Bearer teach").send(newAdult);
    expect(res.status).toBe(500);
    expect(deleteContact).toHaveBeenCalledTimes(1);
    expect(deleteContact).toHaveBeenCalledWith("orphan");
    expect(audit).toHaveBeenCalledWith("teach", "student.create_failed", "", { createdContactIds: ["orphan"] });
  });
});

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
    ["blank contact", { ...child, ghlContactId: "" }],
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

  it("reuses Arzo Luper's contact, stores the format, and does not create another", async () => {
    const createContact = vi.fn();
    const deleteContact = vi.fn();
    const findContactByEmail = vi.fn(async (email: string) => (email === ARZO.email ? { id: ARZO.ghlContactId, name: ARZO.fullName, email } : null));
    const { post, createStudent } = setup(fakeGhl({ createContact, deleteContact, findContactByEmail }));
    const res = await post("/api/teacher/students", { fullName: ARZO.fullName, ageCategory: "adult", email: "LuperDev@gmail.com", format: "Zoom" });
    expect(res.status).toBe(200);
    expect(res.body.contacts).toEqual({ student: "reused", billing: "same" });
    expect(findContactByEmail).toHaveBeenCalledWith(ARZO.email);
    expect(createContact).not.toHaveBeenCalled();
    expect(deleteContact).not.toHaveBeenCalled();
    expect(createStudent.mock.calls[0][0]).toMatchObject({ fullName: ARZO.fullName, email: ARZO.email, format: "Zoom", ghlContactId: ARZO.ghlContactId, billingContactId: ARZO.ghlContactId, isMinor: false });
  });

  it("returns a clear error when that email is already enrolled", async () => {
    const createContact = vi.fn(async () => ({ contact: contact("new"), created: true }));
    const { post } = setup(fakeGhl({ createContact, findContactByEmail: async () => ({ id: ARZO.ghlContactId, name: ARZO.fullName, email: ARZO.email }) }));
    expect((await post("/api/teacher/students", { fullName: ARZO.fullName, ageCategory: "adult", email: ARZO.email })).status).toBe(200);
    const again = await post("/api/teacher/students", { fullName: "Someone Else", ageCategory: "adult", email: "LuperDev@gmail.com", format: "In person" });
    expect(again.status).toBe(409);
    expect(again.body.error).toEqual({ code: "student_already_exists", message: studentFormMessages.duplicateEmail });
    expect(createContact).not.toHaveBeenCalled();
  });

  it("deletes only the contact this request created when the student row fails", async () => {
    const deleteContact = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const app = createApp(buildDeps(users, fakeGhl({
      deleteContact,
      findContactByEmail: async (email) => (email === ARZO.email ? { id: ARZO.ghlContactId, name: ARZO.fullName, email } : null),
      createContact: async (i) => ({ contact: contact("new-minor", i.email), created: true }),
    }), { audit, listStudents: async () => [], createStudent: async () => { throw new Error("db"); } } as any));
    const res = await request(app).post("/api/teacher/students").set("Authorization", "Bearer teach").send({
      fullName: "Minor Example", ageCategory: "child", guardianName: ARZO.fullName, guardianEmail: ARZO.email, format: "In person",
    });
    expect(res.status).toBe(500);
    expect(deleteContact).toHaveBeenCalledTimes(1);
    expect(deleteContact).toHaveBeenCalledWith("new-minor");
    expect(deleteContact).not.toHaveBeenCalledWith(ARZO.ghlContactId);
    expect(audit).toHaveBeenCalledWith("teach", "student.create_failed", "", { createdContactIds: ["new-minor"] });
  });

  it("still records the new contact if removing it fails", async () => {
    const audit = vi.fn(async () => undefined);
    const app = createApp(buildDeps(users, fakeGhl({
      deleteContact: async () => { throw new Error("ghl down"); },
      createContact: async () => ({ contact: contact("orphan"), created: true }),
    }), { audit, listStudents: async () => [], createStudent: async () => { throw new Error("db"); } } as any));
    const res = await request(app).post("/api/teacher/students").set("Authorization", "Bearer teach").send(newAdult);
    expect(res.status).toBe(500);
    expect(audit).toHaveBeenCalledWith("teach", "student.create_failed", "", { createdContactIds: ["orphan"] });
  });

  it("names the invalid field instead of a generic error", async () => {
    const { post, createStudent } = setup();
    const res = await post("/api/teacher/students", { fullName: "Ada Sample", ageCategory: "adult", email: "not-an-email", format: "Zoom" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(studentFormMessages.emailInvalid);
    const format = await post("/api/teacher/students", { ...newAdult, format: "Remote" });
    expect(format.body.error.message).toBe(studentFormMessages.format);
    const guardian = await post("/api/teacher/students", { ...newChild, guardianEmail: "parent-at-example" });
    expect(guardian.body.error.message).toBe(studentFormMessages.guardianEmailInvalid);
    expect(createStudent).not.toHaveBeenCalled();
  });

  it("requires a teacher with two-factor, and refuses a suspended teacher", async () => {
    const body = { fullName: ARZO.fullName, ageCategory: "adult", email: ARZO.email, ghlContactId: ARZO.ghlContactId };
    const send = (who: Record<string, unknown>, token?: string) => {
      const req = request(createApp(buildDeps(token ? { u: who as any } : {}))).post("/api/teacher/students").send(body);
      return token ? req.set("Authorization", `Bearer ${token}`) : req;
    };
    expect((await send({})).status).toBe(401);
    expect((await send({ role: "guardian", links: [] }, "u")).status).toBe(403);
    expect((await send({ role: "student", links: [] }, "u")).status).toBe(403);
    expect((await send({ role: "teacher", aal: "aal1" }, "u")).body.error.code).toBe("mfa_required");
    expect((await send({ role: "teacher", mfa: false, aal: "aal2" }, "u")).body.error.code).toBe("mfa_required");
    expect((await send({ role: "teacher", status: "suspended" }, "u")).body.error.code).toBe("account_suspended");
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
