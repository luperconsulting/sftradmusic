// Transactional email, to the student or payer only. Failures are logged and never undo the action.
import { formatMoney } from "../../shared/pricing.js";
import type { InvoiceRecord, LessonRecord, StudentRecord, StudioSettings } from "../store/types.js";
import { recipientFor, type PortalContext } from "./context.js";
import { BOOKING_TIMEZONE } from "./availability.js";

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: BOOKING_TIMEZONE, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
const portal = (ctx: PortalContext) => `${ctx.appUrl.replace(/\/$/, "")}/portal`;

async function safeSend(ctx: PortalContext, email: Parameters<PortalContext["mailer"]["send"]>[0] | null) {
  if (!email || !email.to) return;
  try {
    await ctx.mailer.send(email);
  } catch {
    console.error(`[mail] "${email.subject}" failed`);
  }
}

/** Zelle or cash instructions. The Zelle recipient comes from the teacher's settings. */
export function paymentInstructions(inv: Pick<InvoiceRecord, "number" | "totalCents" | "amountPaidCents" | "paymentMethodChoice">, settings: Pick<StudioSettings, "zelleRecipient">) {
  const due = formatMoney(Math.max(inv.totalCents - inv.amountPaidCents, 0));
  if (inv.paymentMethodChoice === "cash") return [`Pay ${due} in cash at your next lesson, before it starts.`, `Invoice #${inv.number}.`];
  if (inv.paymentMethodChoice === "card") return [`Pay ${due} by card from the portal.`, `Invoice #${inv.number}.`];
  const to = settings.zelleRecipient.trim() || "the Zelle recipient shown in your portal";
  return [`Send ${due} by Zelle to ${to}.`, `Put "Invoice #${inv.number}" in the memo.`];
}

export function invoiceIssuedEmail(ctx: PortalContext, inv: InvoiceRecord, student: StudentRecord, settings: StudioSettings) {
  const to = inv.payerEmail ?? recipientFor(student);
  if (!to) return null;
  return {
    to,
    subject: `Invoice #${inv.number} from SF Trad Music`,
    heading: `Invoice #${inv.number}: ${formatMoney(inv.totalCents - inv.amountPaidCents)} awaiting payment`,
    lines: [`For ${student.fullName}: ${inv.lines.map((l) => `${l.label} (${formatMoney(l.amountCents)})`).join(", ")}.`, "Your teacher marks the invoice paid once the payment arrives."],
    callout: paymentInstructions(inv, settings),
    cta: { label: "Open the portal", url: portal(ctx) },
  };
}

export function paymentReceivedEmail(ctx: PortalContext, inv: InvoiceRecord, student: StudentRecord) {
  const to = inv.payerEmail ?? recipientFor(student);
  if (!to) return null;
  const extra = inv.kind === "package" ? ["4 lesson credits were added. Each booked lesson uses one."] : inv.kind === "session" ? ["Your lesson is confirmed."] : [];
  return {
    to,
    subject: `Payment received for invoice #${inv.number}`,
    heading: "Payment received. Thank you!",
    lines: [`We recorded ${formatMoney(inv.amountPaidCents)} for invoice #${inv.number} (${student.fullName}).`, ...extra],
    cta: { label: "Open the portal", url: portal(ctx) },
  };
}

export function lessonEmail(ctx: PortalContext, kind: "booked" | "rescheduled" | "cancelled", student: StudentRecord, lessons: LessonRecord[], extra: string[] = []) {
  const to = recipientFor(student);
  if (!to || !lessons.length) return null;
  const subject = { booked: "Lesson booked", rescheduled: "Lesson moved", cancelled: "Lesson cancelled" }[kind];
  const list = lessons.slice(0, 12).map((l) => `${when(l.startsAt)} · ${l.locationKind === "zoom" ? "Zoom" : "Music City SF, Room 4, 1353 Bush St"}${l.status === "pending_payment" ? " · awaiting payment" : ""}`);
  return {
    to,
    subject: `${subject}: ${student.fullName}`,
    heading: `${subject} for ${student.fullName}`,
    lines: [...list, ...extra],
    cta: { label: "Open the portal", url: portal(ctx) },
  };
}

export const notify = {
  invoiceIssued: (ctx: PortalContext, inv: InvoiceRecord, student: StudentRecord, settings: StudioSettings) => safeSend(ctx, invoiceIssuedEmail(ctx, inv, student, settings)),
  paymentReceived: (ctx: PortalContext, inv: InvoiceRecord, student: StudentRecord) => safeSend(ctx, paymentReceivedEmail(ctx, inv, student)),
  lesson: (ctx: PortalContext, kind: "booked" | "rescheduled" | "cancelled", student: StudentRecord, lessons: LessonRecord[], extra?: string[]) => safeSend(ctx, lessonEmail(ctx, kind, student, lessons, extra)),
};
