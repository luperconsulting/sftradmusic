import { runArzoSeed } from "./arzoLive.js";

const result = await runArzoSeed(process.env, "cleanup");
if (!result.ok) {
  if (result.blocked) console.error(result.blocked);
  if (result.missing.length) console.error(`Missing credentials: ${result.missing.join(", ")}`);
  console.error("Nothing was deleted.");
  process.exit(2);
}
console.log(`Removed portal-test notes, videos, storage objects, assignments, messages, and lessons for student ${result.studentId}. The account was kept.`);
