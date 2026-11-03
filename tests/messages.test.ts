import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { STUDENT_A, STUDENT_B, buildDeps, fakeGhl } from "./helpers";

const parent = { role: "guardian" as const, links: [{ studentId: STUDENT_A, canBook: true, canPay: true }] };
const thread = {
  id: "th1",
  studentId: STUDENT_A,
  studentName: "Test Student",
  subject: "portal-test: Practice check-in",
  createdAt: "2026-11-02T00:00:00.000Z",
  messages: [{ id: "m1", body: "Hello from the portal", createdAt: "2026-11-02T00:00:00.000Z", authorName: "Test Student", authorRole: "student" as const }],
};

describe("in-portal messages", () => {
  it("lets a student read only their own thread and does not email or text", async () => {
    const listMessageThreads = vi.fn(async (studentId: string | null) => (studentId === STUDENT_A ? [thread] : []));
    const addMessage = vi.fn(async () => thread);
    const sendInvoice = vi.fn(async () => ({}));
    const sendPortalInvite = vi.fn(async () => null);
    const deps = buildDeps(
      { parent, t: { role: "teacher", aal: "aal2" } },
      fakeGhl({ sendInvoice }),
      { listMessageThreads, addMessage },
    );
    deps.auth!.sendPortalInvite = sendPortalInvite;
    const app = createApp(deps);

    const own = await request(app).get(`/api/messages?studentId=${STUDENT_A}`).set("Authorization", "Bearer parent");
    expect(own.status).toBe(200);
    expect(own.body.threads).toHaveLength(1);
    expect(listMessageThreads).toHaveBeenCalledWith(STUDENT_A);

    const other = await request(app).get(`/api/messages?studentId=${STUDENT_B}`).set("Authorization", "Bearer parent");
    expect(other.status).toBe(403);

    const posted = await request(app).post("/api/messages").set("Authorization", "Bearer parent").send({ studentId: STUDENT_A, subject: "portal-test: Practice check-in", body: "Hello from the portal" });
    expect(posted.status).toBe(200);
    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({ studentId: STUDENT_A, body: "Hello from the portal" }));
    expect(sendPortalInvite).not.toHaveBeenCalled();
    expect(sendInvoice).not.toHaveBeenCalled();

    const blocked = await request(app).post("/api/messages").set("Authorization", "Bearer parent").send({ studentId: STUDENT_B, body: "Not yours" });
    expect(blocked.status).toBe(403);

    const all = await request(app).get("/api/teacher/messages").set("Authorization", "Bearer t");
    expect(all.status).toBe(200);
    expect(listMessageThreads).toHaveBeenCalledWith(null);
  });
});
