# Legacy GoHighLevel code

Supabase is the source of truth for students, guardians, billing contacts, lessons, invoices and payments.
This folder keeps the old GoHighLevel client and helpers so old records can be migrated into Supabase.

Rules:

- Nothing under `server/` outside this folder, `api/`, `server.ts`, or `src/` may import from here.
  `tests/legacy-isolation.test.ts` fails the build if anything does.
- Only migration scripts and the tests for this folder may use it.
- The portal reads no `GHL_*` environment variable at runtime.
