// Read-only summary for the Grok bot (GET /api/ops/summary). No automations: it only reports.
// Names are first names only, and no emails, phone numbers or payment references are included.
import type { PortalStore } from "../store/types.js";
import { amountDueCents } from "./billing.js";
import { bookingDate, startOfBookingDate } from "./availability.js";

export async function opsSummary(store: PortalStore, nowMs: number) {
  const today = bookingDate(nowMs);
  const dayStart = startOfBookingDate(today);
  const dayEnd = dayStart + 86400000;
  const since = new Date(nowMs - 86400000).toISOString();
  const [students, todays, holds, newBookings, invoices, referrals] = await Promise.all([
    store.listStudents(),
    store.listLessons({ from: new Date(dayStart).toISOString(), to: new Date(dayEnd).toISOString(), statuses: ["scheduled", "pending_payment", "completed"] }),
    store.listLessons({ statuses: ["pending_payment"] }),
    store.listLessons({ createdFrom: since }),
    store.listInvoices({ includeDrafts: false }),
    store.listReferrals({}),
  ]);
  const first = new Map(students.map((s) => [s.id, s.firstName]));
  const who = (id: string) => first.get(id) ?? "Student";
  const unpaid = invoices.filter((i) => (i.status === "sent" || i.status === "partially_paid") && amountDueCents(i) > 0);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    date: today,
    todaysLessons: todays.map((l) => ({ id: l.id, student: who(l.studentId), startsAt: l.startsAt, endsAt: l.endsAt, location: l.locationKind === "zoom" ? "Zoom" : "In person", status: l.status })),
    unpaidInvoices: {
      count: unpaid.length,
      totalDue: unpaid.reduce((s, i) => s + amountDueCents(i), 0) / 100,
      items: unpaid.map((i) => ({ id: i.id, number: i.number, student: who(i.studentId), amountDue: amountDueCents(i) / 100, dueDate: i.dueDate, kind: i.kind, method: i.paymentMethodChoice })),
    },
    pendingSessionHolds: holds.map((l) => ({ id: l.id, student: who(l.studentId), startsAt: l.startsAt, holdExpiresAt: l.holdExpiresAt })),
    pendingReferrals: referrals.filter((r) => r.status === "pending").map((r) => ({ id: r.id, referrer: who(r.referrerStudentId), referred: who(r.referredStudentId), since: r.createdAt })),
    newBookings: newBookings.filter((l) => l.status === "scheduled" || l.status === "pending_payment").map((l) => ({ id: l.id, student: who(l.studentId), startsAt: l.startsAt, status: l.status, bookedAt: l.createdAt })),
  };
}
