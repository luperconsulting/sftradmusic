// Read-only check of the GoHighLevel invoice API, run inside a Preview deployment so the token stays in Vercel.
// Sends GET requests only. The output has no names, emails, phones, addresses, tokens or URL paths.
import { createHash } from "node:crypto";
import { getBilling } from "../services/billing.js";
import { createGhlClient } from "../integrations/ghl.js";

const BASE = "https://services.leadconnectorhq.com";
const short = (v: unknown) => (v ? createHash("sha256").update(String(v)).digest("hex").slice(0, 8) : "none");

function linkFields(value: unknown, path = "", out = new Set<string>()) {
  if (Array.isArray(value)) value.forEach((v) => linkFields(v, `${path}[]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) linkFields(v, path ? `${path}.${k}` : k, out);
  } else if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    try { out.add(`${path} -> ${new URL(value).host}`); } catch { out.add(`${path} (unparseable)`); }
  } else if (/url|link|hosted|checkout/i.test(path)) out.add(`${path} (${typeof value})`);
  return out;
}

export async function runGhlInvoiceCheck(token: string, location: string, invoiceId: string | null) {
  const scope = `altId=${encodeURIComponent(location)}&altType=location`;
  const get = async (path: string, version: string | null = "2021-07-28") => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (version) headers.Version = version;
    const res = await fetch(BASE + path, { method: "GET", headers, signal: AbortSignal.timeout(10000) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  const versions: Record<string, number> = {};
  for (const v of ["2021-07-28", "v3", null]) versions[v ?? "(missing)"] = (await get(`/invoices/?${scope}&limit=1&offset=0`, v)).status;

  const list = await get(`/invoices/?${scope}&limit=100&offset=0`);
  const rows: any[] = list.body?.invoices ?? [];
  const statusCounts: Record<string, number> = {};
  for (const i of rows) {
    const k = `${i.status}/${i.liveMode ? "live" : "test"}`;
    statusCounts[k] = (statusCounts[k] ?? 0) + 1;
  }

  const sampleId = invoiceId ?? rows[0]?._id ?? null;
  const one = sampleId ? await get(`/invoices/${encodeURIComponent(sampleId)}?${scope}`) : null;
  const sample = one && one.status < 300 ? one.body : null;
  const contactId: string | undefined = sample?.contactDetails?.id;

  let filter: Record<string, unknown> | null = null;
  let billing: Record<string, unknown> | null = null;
  if (contactId) {
    const filtered = await get(`/invoices/?${scope}&limit=100&offset=0&contactId=${encodeURIComponent(contactId)}`);
    const filteredRows: any[] = filtered.body?.invoices ?? [];
    const bogus = await get(`/invoices/?${scope}&limit=100&offset=0&contactId=doesNotExist000000000000`);
    filter = {
      status: filtered.status,
      returned: filteredRows.length,
      belongingToOtherContacts: filteredRows.filter((i) => i.contactDetails?.id !== contactId).length,
      otherContactsInUnfilteredSample: rows.filter((i) => i.contactDetails?.id !== contactId).length,
      nonexistentContact: { status: bogus.status, returned: bogus.body?.invoices?.length ?? null },
    };
    // The portal's real billing code, on the real data
    const client = createGhlClient({ token, locationId: location, lessonCalendarId: "unused", timezone: "UTC", paymentUrlTemplate: null, paymentHosts: [] });
    try {
      const b = await getBilling(client, contactId);
      billing = { outstanding: b.outstanding, openInvoices: b.openInvoices.length, bookingBlocked: b.bookingBlocked, testInvoiceIsOpen: b.openInvoices.some((i) => i.id === sampleId), historyCount: b.history.length };
    } catch (e) {
      billing = { error: e instanceof Error ? e.message : "failed" };
    }
  }

  return {
    versions,
    list: { status: list.status, returned: rows.length, total: list.body?.total ?? null, statusCounts },
    invoice: one
      ? {
          source: invoiceId ? "provided" : "first listed",
          status: one.status,
          ...(sample
            ? {
                invoiceStatus: sample.status,
                liveMode: sample.liveMode,
                currency: sample.currency,
                total: sample.total,
                amountDue: sample.amountDue,
                amountPaid: sample.amountPaid,
                items: (sample.invoiceItems ?? []).map((x: any) => ({ amount: x.amount, qty: x.qty })),
                totalSummary: sample.totalSummary ? { subTotal: sample.totalSummary.subTotal, discount: sample.totalSummary.discount, tax: sample.totalSummary.tax } : null,
                contact: short(contactId),
                fieldNames: Object.keys(sample),
                possibleLinkFields: [...linkFields(sample)],
              }
            : {}),
        }
      : null,
    contactFilter: filter,
    billing,
  };
}
