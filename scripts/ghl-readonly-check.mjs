#!/usr/bin/env node
// Read-only GoHighLevel invoice check. Only ever sends GET requests, and prints no token, name, email,
// phone, address or URL path. Contact IDs are shortened to a hash. Safe output to share.
//
// Required env: GHL_PRIVATE_INTEGRATION_TOKEN, GHL_LOCATION_ID
// Optional env: GHL_TEST_INVOICE_ID (an existing invoice known to be $100)
import { createHash } from "node:crypto";

const BASE = "https://services.leadconnectorhq.com";
const { GHL_PRIVATE_INTEGRATION_TOKEN: token, GHL_LOCATION_ID: location, GHL_TEST_INVOICE_ID: testId } = process.env;
if (!token || !location) {
  console.error("Set GHL_PRIVATE_INTEGRATION_TOKEN and GHL_LOCATION_ID first.");
  process.exit(1);
}
const short = (v) => (v ? createHash("sha256").update(String(v)).digest("hex").slice(0, 8) : "none");
const scope = `altId=${encodeURIComponent(location)}&altType=location`;

async function get(path, version = "2021-07-28") {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (version) headers.Version = version;
  const res = await fetch(BASE + path, { method: "GET", headers, signal: AbortSignal.timeout(15000) });
  let body = null;
  try { body = await res.json(); } catch { /* status is enough */ }
  return { status: res.status, body };
}

// Field names that could carry a payment link, with only the host of any URL value.
function linkFields(value, path = "", out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => linkFields(v, `${path}[]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) linkFields(v, path ? `${path}.${k}` : k, out);
  else if (typeof value === "string" && /^https?:\/\//i.test(value)) out.add(`${path} -> ${new URL(value).host}`);
  else if (/url|link|hosted|checkout/i.test(path)) out.add(`${path} (${typeof value})`);
  return out;
}

const amounts = (i) => ({
  status: i.status, liveMode: i.liveMode, currency: i.currency, total: i.total, amountDue: i.amountDue, amountPaid: i.amountPaid,
  items: (i.invoiceItems ?? []).map((x) => ({ amount: x.amount, qty: x.qty })),
  totalSummary: i.totalSummary ? { subTotal: i.totalSummary.subTotal, discount: i.totalSummary.discount } : null,
  contact: short(i.contactDetails?.id),
});

console.log("== 1. Version header on list (limit=1) ==");
for (const v of ["2021-07-28", "v3", null]) {
  const r = await get(`/invoices/?${scope}&limit=1&offset=0`, v);
  console.log(`Version ${v ?? "(missing)"}: HTTP ${r.status}${r.status < 300 ? `, total=${r.body?.total}` : ""}`);
}

console.log("\n== 2. List sample ==");
const list = await get(`/invoices/?${scope}&limit=100&offset=0`);
const invoices = list.body?.invoices ?? [];
console.log(`HTTP ${list.status}, returned=${invoices.length}, total=${list.body?.total}`);
const counts = {};
for (const i of invoices) { const k = `${i.status}/${i.liveMode ? "live" : "test"}`; counts[k] = (counts[k] ?? 0) + 1; }
console.log("status/mode counts:", counts);
const past = invoices.filter((i) => i.amountDue > 0 && new Date(i.dueDate) < new Date());
console.log("past due with money owing, by status:", past.reduce((a, i) => ({ ...a, [i.status]: (a[i.status] ?? 0) + 1 }), {}));

console.log("\n== 3. Known invoice: dollars or cents? ==");
const sampleId = testId ?? invoices[0]?._id;
let sample = null;
if (sampleId) {
  const r = await get(`/invoices/${encodeURIComponent(sampleId)}?${scope}`);
  sample = r.body;
  console.log(`GET invoice (${testId ? "GHL_TEST_INVOICE_ID" : "first listed, not a known $100 invoice"}): HTTP ${r.status}`);
  if (r.status < 300) console.log(JSON.stringify(amounts(sample), null, 1));
} else console.log("No invoice available.");

console.log("\n== 4. contactId filter ==");
const contactId = sample?.contactDetails?.id;
if (contactId) {
  const r = await get(`/invoices/?${scope}&limit=100&offset=0&contactId=${encodeURIComponent(contactId)}`);
  const rows = r.body?.invoices ?? [];
  const others = rows.filter((i) => i.contactDetails?.id !== contactId).length;
  console.log(`Real contact ${short(contactId)}: HTTP ${r.status}, returned=${rows.length}, total=${r.body?.total}, belonging to others=${others}`);
  const unfilteredOthers = invoices.filter((i) => i.contactDetails?.id !== contactId).length;
  console.log(`Unfiltered sample has ${unfilteredOthers} invoices for other contacts ${unfilteredOthers ? "(so the filter is proven if 'others' is 0)" : "(can't prove filtering with one contact)"}`);
  const bogus = await get(`/invoices/?${scope}&limit=100&offset=0&contactId=doesNotExist000000000000`);
  console.log(`Nonexistent contact: HTTP ${bogus.status}, returned=${bogus.body?.invoices?.length ?? "n/a"}`);
} else console.log("Skipped: no contact on the sample invoice.");

console.log("\n== 5. Fields that could hold a payment link (names and hosts only) ==");
const fields = sample ? [...linkFields(sample)] : [];
console.log(fields.length ? fields.join("\n") : "none");
console.log("\nAll top-level invoice fields:", sample ? Object.keys(sample).join(", ") : "n/a");
