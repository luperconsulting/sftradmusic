// The Supabase store names the missing migration when payment_reports doesn't exist (PostgREST PGRST205).
import { describe, expect, it, vi } from "vitest";

const missing = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.payment_reports' in the schema cache" } };
// Every query builder method returns the builder; awaiting it (or .single()) resolves to the missing-table error.
const builder: any = new Proxy({}, {
  get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => void) => resolve(missing) : () => builder),
});
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => builder, storage: { from: () => builder } }) }));

const { createSupabaseStore } = await import("../server/store/supabaseStore");

describe("payment_reports missing (migration 0007 not applied)", () => {
  const store = createSupabaseStore("https://project.supabase.co", "sb_secret_test_only_not_real", "lesson-videos");

  it("reads fail with a message that names the migration", async () => {
    await expect(store.listPaymentReports({ invoiceIds: ["i"], status: "pending" })).rejects.toThrow(/payment_reports is missing \(apply supabase\/migrations\/0007_payment_reports\.sql\): Could not find the table/);
  });

  it("writes return 503 migration_required", async () => {
    await expect(store.createPaymentReport({ invoiceId: "i", studentId: "s", reportedByAccountId: "a", method: "zelle", amountCents: null, note: "" })).rejects.toMatchObject({ status: 503, code: "migration_required" });
  });
});
