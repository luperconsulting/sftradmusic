import { runArzoSeed } from "./arzoLive.js";

const result = await runArzoSeed(process.env, "videos");
if (!result.ok) {
  if (result.blocked) console.error(result.blocked);
  if (result.missing.length) console.error(`Missing credentials: ${result.missing.join(", ")}`);
  console.error("No video was uploaded. This script does not send email or SMS and does not create invoices.");
  process.exit(2);
}
console.log(`Uploaded ${result.videos} portal-test videos for student ${result.studentId} and linked portal-test: Technique to portal-test: Daily scales.`);
console.log("No email or SMS was sent. No GoHighLevel invoice was created.");
