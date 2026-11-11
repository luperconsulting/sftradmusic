import { readFileSync } from "node:fs";
import { ARZO_EMAIL, ARZO_GHL_CONTACT_ID, ARZO_NAME, ARZO_STUDENT_ID } from "./arzoFixture.js";

export const PORTAL_TEST = "portal-test";
export const VIDEO_CATEGORIES = ["Technique", "Repertoire", "Practice Exercises", "Music Theory", "Additional Resources"] as const;

const placeholderPath = new URL("./fixtures/portal-test-arzo.mp4", import.meta.url);

export type ArzoSeed = ReturnType<typeof buildArzoSeed>;

export function buildArzoSeed(now = new Date("2026-11-02T18:00:00.000Z")) {
  const past = new Date(now.getTime() - 7 * 86400000).toISOString();
  const upcoming = new Date(now.getTime() + 7 * 86400000).toISOString();
  const end = (iso: string) => new Date(new Date(iso).getTime() + 3600000).toISOString();
  return {
    tag: PORTAL_TEST,
    onlyEmail: ARZO_EMAIL,
    studentId: ARZO_STUDENT_ID,
    profile: {
      fullName: ARZO_NAME,
      firstName: "Arzo",
      email: ARZO_EMAIL,
      ghlContactId: ARZO_GHL_CONTACT_ID,
      billingContactId: ARZO_GHL_CONTACT_ID,
      isMinor: false,
      guardianName: null,
      guardianEmail: null,
      format: "In person" as const,
      styleLine: "Scottish fiddle · portal-test",
      studentSince: "2026-01-15",
    },
    lessons: [
      { key: "past", title: "portal-test: Past fiddle lesson", start: past, end: end(past), address: "Music City SF", toNotify: false as const },
      { key: "upcoming", title: "portal-test: Upcoming fiddle lesson", start: upcoming, end: end(upcoming), address: "Zoom", toNotify: false as const },
    ],
    notes: [
      { title: "portal-test: Published lesson note", lessonDate: past.slice(0, 10), status: "published" as const, summary: "Portal-test summary for Arzo.", technique: "Bow hold.", practice: "Ten minutes of scales.", goals: "Clean the A part.", prep: "Bring the tune sheet." },
      { title: "portal-test: Draft lesson note", lessonDate: upcoming.slice(0, 10), status: "draft" as const, summary: "Draft only the teacher should see.", technique: "Cuts.", practice: "Slow bow.", goals: "Even rhythm.", prep: "None." },
    ],
    videos: VIDEO_CATEGORIES.map((category) => ({
      title: `portal-test: ${category}`,
      category,
      description: "Portal-test placeholder for Arzo Luper.",
      storagePath: `portal-test/arzo/${category.toLowerCase().replace(/\s+/g, "-")}.mp4`,
      bytes: readFileSync(placeholderPath),
    })),
    assignments: [
      { title: "portal-test: Daily scales", instructions: "Play the portal-test scale video once.", dueDate: upcoming.slice(0, 10), lessonDate: past.slice(0, 10), videoTitle: "portal-test: Technique", completed: false },
    ],
    invoices: [
      { title: "portal-test: Paid lesson", status: "paid", liveMode: false, total: 100, amountPaid: 100, amountDue: 0 },
      { title: "portal-test: Open lesson", status: "sent", liveMode: false, total: 100, amountPaid: 0, amountDue: 100 },
    ],
    sendsEmail: false,
    sendsSms: false,
  };
}

export type PageCheck = { page: string; role: "student" | "teacher"; pass: boolean; detail: string };

/** What each portal page can show from the seed plan. Invoices are described, not created. */
export function pageChecks(seed: ArzoSeed): PageCheck[] {
  const published = seed.notes.filter((n) => n.status === "published");
  const checks: PageCheck[] = [
    { page: "Student profile", role: "student", pass: !!seed.profile.fullName && !!seed.profile.email && !!seed.profile.styleLine, detail: seed.profile.fullName },
    { page: "Student lessons", role: "student", pass: seed.lessons.some((l) => l.key === "past") && seed.lessons.some((l) => l.key === "upcoming") && seed.lessons.every((l) => l.toNotify === false), detail: `${seed.lessons.length} lessons, notifications off` },
    { page: "Student notes", role: "student", pass: published.length === 1 && published[0].summary.length > 0, detail: published.map((n) => n.title).join(", ") },
    { page: "Student practice", role: "student", pass: seed.assignments.length === 1 && seed.assignments[0].instructions.length > 0, detail: seed.assignments[0].title },
    { page: "Student videos", role: "student", pass: VIDEO_CATEGORIES.every((c) => seed.videos.some((v) => v.category === c && v.bytes.length > 0)), detail: `${seed.videos.length} categories` },
    { page: "Student balance", role: "student", pass: false, detail: "The balance view reads GoHighLevel. The seed does not create invoices, because there is no cached invoice table." },
    { page: "Teacher students", role: "teacher", pass: seed.profile.ghlContactId === ARZO_GHL_CONTACT_ID, detail: seed.profile.email },
    { page: "Teacher profile", role: "teacher", pass: seed.profile.format === "In person" && seed.profile.studentSince === "2026-01-15", detail: seed.profile.styleLine },
    { page: "Teacher notes", role: "teacher", pass: seed.notes.length === 2, detail: "One published note and one draft." },
    { page: "Teacher videos", role: "teacher", pass: seed.videos.every((v) => v.storagePath.startsWith("portal-test/arzo/")), detail: seed.videos[0].storagePath },
    { page: "Teacher assignments", role: "teacher", pass: seed.assignments[0].videoTitle.startsWith("portal-test:"), detail: seed.assignments[0].title },
    { page: "Teacher calendar", role: "teacher", pass: seed.lessons.every((l) => l.title.startsWith("portal-test:")), detail: "Past and upcoming portal-test lessons." },
    { page: "Teacher invoices", role: "teacher", pass: false, detail: "The invoice view reads GoHighLevel. The seed does not create invoices." },
  ];
  return checks;
}

/** True only when a cached Supabase invoice table is already there. Never a reason to create a GoHighLevel invoice. */
export function invoiceFixturePlan(cacheTableReady: boolean) {
  if (!cacheTableReady) return { write: false as const, reason: "No cached invoice table. GoHighLevel invoices are not created." };
  return { write: true as const, rows: buildArzoSeed().invoices.map((row) => ({ ...row, liveMode: false as const })) };
}

const guardResult = (env: Record<string, string | undefined>, required: string[]) => {
  if (env.VERCEL_ENV === "production" || env.SEED_TARGET === "production") {
    return { ok: false as const, missing: [] as string[], blocked: "Refusing to seed or clean production." };
  }
  const missing = required.filter((name) => !env[name]);
  if (missing.length) return { ok: false as const, missing };
  return { ok: true as const };
};

/** Video upload talks only to Supabase. It does not book a lesson or create an invoice. */
export function videoSeedGuard(env: Record<string, string | undefined>) {
  return guardResult(env, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
}

export function seedGuard(env: Record<string, string | undefined>): { ok: true } | { ok: false; missing: string[]; blocked?: string } {
  if (env.VERCEL_ENV === "production" || env.SEED_TARGET === "production") {
    return { ok: false, missing: [], blocked: "Refusing to seed or clean production." };
  }
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GHL_PRIVATE_INTEGRATION_TOKEN", "GHL_LOCATION_ID", "GHL_LESSON_CALENDAR_ID"];
  const missing = required.filter((name) => !env[name]);
  if (env.GHL_SAFE_MODE === "false" || env.GHL_SAFE_MODE === "0" || env.GHL_SAFE_MODE === "off") {
    return { ok: false, missing, blocked: "Set GHL_SAFE_MODE=true so a seeded booking cannot notify anyone." };
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true };
}

export type SeedStore = {
  rows: { kind: string; key: string }[];
  appointments: { title: string; toNotify: boolean; contactId: string }[];
  emails: string[];
  sms: string[];
};

export function emptyStore(): SeedStore {
  return { rows: [], appointments: [], emails: [], sms: [] };
}

/** In-memory apply used by tests. The CLI refuses to run this against production or without credentials. */
export function applySeed(store: SeedStore, seed: ArzoSeed = buildArzoSeed()) {
  if (seed.sendsEmail || seed.sendsSms) throw new Error("The Arzo seed must not send mail or SMS.");
  const drop = (kind: string) => { store.rows = store.rows.filter((r) => r.kind !== kind); };
  drop("profile");
  store.rows.push({ kind: "profile", key: seed.profile.email });
  drop("note");
  for (const note of seed.notes) store.rows.push({ kind: "note", key: note.title });
  drop("video");
  for (const video of seed.videos) store.rows.push({ kind: "video", key: video.storagePath });
  drop("assignment");
  for (const item of seed.assignments) store.rows.push({ kind: "assignment", key: item.title });
  store.appointments = seed.lessons.map((l) => ({ title: l.title, toNotify: l.toNotify, contactId: seed.profile.ghlContactId }));
  return store;
}

export function cleanupSeed(store: SeedStore) {
  store.rows = store.rows.filter((r) => r.kind === "profile");
  store.appointments = [];
  return store;
}
