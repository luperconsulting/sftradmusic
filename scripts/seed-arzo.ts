import { runArzoSeed } from "./arzoLive.js";

const result = await runArzoSeed(process.env, "seed");
if (!result.ok) {
  if (result.blocked) console.error(result.blocked);
  if (result.missing.length) console.error(`Missing credentials: ${result.missing.join(", ")}`);
  console.error("No seed was written. This script does not send email or SMS.");
  process.exit(2);
}
console.log(`Seeded portal-test notes, videos, assignments, and silent lessons for student ${result.studentId}.`);
console.log("Invoices were not created. Messages were not created. No email or SMS was sent.");
