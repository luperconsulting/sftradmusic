import { runArzoSeed } from "./arzoLive.js";

const result = await runArzoSeed(process.env, "seed");
if (!result.ok) {
  if (result.blocked) console.error(result.blocked);
  if (result.missing.length) console.error(`Missing credentials: ${result.missing.join(", ")}`);
  console.error("No seed was written. This script does not send email or SMS.");
  process.exit(2);
}
console.log(`Seeded portal-test notes, ${result.videos} videos, assignments, and silent lessons for student ${result.studentId}.`);
console.log(result.wroteInvoices
  ? "Cached invoice fixtures were written in Supabase. No GoHighLevel invoice was created."
  : "No cached invoice table, so no invoice rows were written. No GoHighLevel invoice was created.");
console.log("In-portal messages are not seeded. Students and the teacher use email. No email or SMS was sent.");
