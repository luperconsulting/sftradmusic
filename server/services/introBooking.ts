// Booking a free intro call from the public widget: checks the time is still open, puts it on the booking
// Google Calendar, then emails the client a confirmation with a calendar invite and emails the studio a notice.
import { ApiError } from "../http.js";
import type { CalendarEventInput } from "../integrations/googleCalendar.js";

export const LEVELS: Record<string, string> = { new: "Brand new", some: "Some playing", exp: "Experienced" };

export interface IntroRequest {
  start: string;
  name: string;
  email: string;
  phone: string;
  level: string;
  notes: string;
  timeZone: string;
  /** Hidden form field. People never fill it in; bots do. */
  website: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const invalid = (message = "Some of the details provided aren't valid.") => new ApiError(400, "invalid_input", message);

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export function parseIntroRequest(body: unknown, fallbackZone: string): IntroRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (k: string, max: number) => {
    const v = b[k];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") throw invalid();
    const t = v.trim();
    if (t.length > max) throw invalid();
    return t;
  };
  const req: IntroRequest = {
    start: str("start", 40),
    name: str("name", 100),
    email: str("email", 254).toLowerCase(),
    phone: str("phone", 40),
    level: str("level", 10),
    notes: str("notes", 2000),
    timeZone: str("timeZone", 64),
    website: str("website", 200),
  };
  if (!req.name) throw invalid("Please tell me your name.");
  if (!EMAIL.test(req.email)) throw invalid("A valid email is needed for the confirmation.");
  if (!Number.isFinite(Date.parse(req.start))) throw invalid("That time isn't valid.");
  if (req.phone && !/^[0-9+().\-\s]{7,40}$/.test(req.phone)) throw invalid("That phone number doesn't look right.");
  if (!LEVELS[req.level]) req.level = "";
  if (!req.timeZone || !validZone(req.timeZone)) req.timeZone = fallbackZone;
  // Headers and calendar text are built from these, so line breaks are stripped from single-line fields.
  req.name = req.name.replace(/[\r\n]+/g, " ");
  req.phone = req.phone.replace(/[\r\n]+/g, " ");
  return req;
}

/** The event id for a start time: the same slot always maps to the same id, so Google refuses a double booking. */
export const introEventId = (startMs: number) => `intro${startMs.toString(32)}`;

const when = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(new Date(ms));

export interface IntroContext {
  calendarId: string;
  hostZone: string;
  slotMinutes: number;
  meetingDetails: string;
  /** Prefixed to the calendar title and the studio notice outside production, e.g. "[Preview] ". */
  label: string;
}

export function introEvent(req: IntroRequest, startMs: number, ctx: IntroContext): CalendarEventInput {
  return {
    id: introEventId(startMs),
    calendarId: ctx.calendarId,
    summary: `${ctx.label}Intro call: ${req.name}`,
    description: [
      `Free ${ctx.slotMinutes}-minute intro call booked on the website.`,
      "",
      `Name: ${req.name}`,
      `Email: ${req.email}`,
      req.phone ? `Phone: ${req.phone}` : "Phone: not given",
      req.level ? `Level: ${LEVELS[req.level]}` : null,
      req.notes ? `\nNotes:\n${req.notes}` : null,
    ].filter((l) => l !== null).join("\n"),
    startMs,
    endMs: startMs + ctx.slotMinutes * 60000,
    timeZone: ctx.hostZone,
  };
}

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// Parameter values (like CN) are quoted rather than backslash-escaped; quotes and control characters are dropped.
const icsParam = (s: string) => `"${s.replace(/["\x00-\x1f]/g, "")}"`;
const icsTime = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
// Lines longer than 75 octets are folded with CRLF + space, as RFC 5545 requires.
const fold = (line: string) => {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
};

export function introInvite(req: IntroRequest, event: CalendarEventInput, organizer: { name: string; email: string }, meetingDetails: string, nowMs: number) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SF Trad Music//Intro call//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${event.id}@sftradmusic.com`,
    `DTSTAMP:${icsTime(nowMs)}`,
    `DTSTART:${icsTime(event.startMs)}`,
    `DTEND:${icsTime(event.endMs)}`,
    `SUMMARY:${icsText(`Intro call with ${organizer.name}`)}`,
    `DESCRIPTION:${icsText(meetingDetails)}`,
    `ORGANIZER;CN=${icsParam(organizer.name)}:mailto:${organizer.email}`,
    `ATTENDEE;CN=${icsParam(req.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${req.email}`,
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    "END:VEVENT",
    "END:VCALENDAR",
  ].map(fold).join("\r\n") + "\r\n";
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function html(heading: string, lines: string[]) {
  const body = lines.map((l) => (l ? `<p style="margin:0 0 12px">${escapeHtml(l).replace(/\n/g, "<br>")}</p>` : "")).join("");
  return `<!doctype html><html><body style="margin:0;background:#F9F8F5;font-family:Georgia,serif;color:#11161B">` +
    `<div style="max-width:560px;margin:0 auto;background:#fff"><div style="background:#1D2A44;color:#fff;padding:20px 24px;font-size:18px;letter-spacing:.12em;text-transform:uppercase">Zane Luper</div>` +
    `<div style="padding:24px"><h1 style="font-size:22px;font-weight:normal;margin:0 0 16px">${escapeHtml(heading)}</h1>${body}</div></div></body></html>`;
}

export function clientConfirmation(req: IntroRequest, event: CalendarEventInput, ctx: IntroContext, fromName: string) {
  const clientTime = when(event.startMs, req.timeZone);
  const hostTime = when(event.startMs, ctx.hostZone);
  const lines = [
    `Hi ${req.name.split(" ")[0]},`,
    `Your free ${ctx.slotMinutes}-minute intro call is booked for ${clientTime}${clientTime === hostTime ? "" : ` (${hostTime} for me)`}.`,
    ctx.meetingDetails,
    "The calendar invite is attached. If you need to change the time, just reply to this email.",
    `Looking forward to talking,\n${fromName}`,
  ];
  return { subject: `Your intro call is booked: ${clientTime}`, text: lines.join("\n\n"), html: html("Your intro call is booked", lines) };
}

export function studioNotice(req: IntroRequest, event: CalendarEventInput, ctx: IntroContext, opts: { htmlLink: string | null; clientEmailed: boolean }) {
  const lines = [
    `${req.name} booked a free intro call for ${when(event.startMs, ctx.hostZone)}.`,
    `Email: ${req.email}\nPhone: ${req.phone || "not given"}${req.level ? `\nLevel: ${LEVELS[req.level]}` : ""}`,
    req.notes ? `Notes:\n${req.notes}` : "",
    opts.clientEmailed ? "They've been sent a confirmation with a calendar invite." : "Their confirmation email was NOT sent, so please contact them directly.",
    opts.htmlLink ? `Google Calendar: ${opts.htmlLink}` : "",
  ].filter(Boolean);
  return { subject: `${ctx.label}New intro call: ${req.name}, ${when(event.startMs, ctx.hostZone)}`, text: lines.join("\n\n"), html: html("New intro call booked", lines) };
}
