# Backend Integration Handoff

What's needed to connect the SF Trad Music portal (branch `feat/student-teacher-portal`) to live services.

## Current status

| Item | Status | Source |
|---|---|---|
| Vercel preview builds; `/`, `/book`, `/signin`, `/teacher`, `/api/health` return 200 | Reported | ChatGPT's live check. Vercel login blocked a direct check from this repo's side. |
| `/api/health` | Reports Supabase and GHL unconfigured | Reported |
| Migration applied to the live project | Done: 10 tables with RLS, private `lesson-videos` bucket | Reported |
| Teacher and family Auth accounts | None yet | Reported |
| Real GHL or Stripe transactions | None tested | Reported |
| Portal code against live Supabase or GHL | **Never run.** The API is tested with fake services only. | This repo |

GHL paths and fields come from GoHighLevel's published OpenAPI files (`github.com/GoHighLevel/highlevel-api-docs`, `apps/calendars.json`, `contacts.json`, `invoices.json`), but they have not been called.

This repository is **public**, so the GHL location ID, lesson calendar ID and Stripe account ID are deliberately not in this file. Take them from the project brief and set them only in Vercel. Never commit a real value.

## Architecture

| Layer | Location | Notes |
|---|---|---|
| Presentation | `src/portal/views/` | Approved design, converted to React. Takes a view model `v`. |
| View models | `src/portal/vm/` | Turn API data into what the views show. No business rules. |
| Authentication | `src/portal/auth/`, `server/store/supabaseStore.ts` | Supabase Auth. The server validates tokens on every request. |
| Authorization | `server/auth/policy.ts` | Pure rules, plus `authenticate()` in `server/app.ts`. |
| GHL | `server/integrations/ghl.ts` | Server only. |
| Payments and booking | `server/services/billing.ts`, `booking.ts` | Enforces the balance rule. Status is read from GHL only. |
| Notes, videos, assignments | `server/store/` | Supabase tables and private storage. |
| Entry points | `api/index.ts` (Vercel), `server.ts` (local) | Same Express app in `server/app.ts`. |

The public site (`index.html`, `book.html`) is a separate Vite entry and loads no portal code. Any integration left unconfigured makes its routes return `503 integration_not_configured`.

## Environment variables

Set these in Vercel scoped to **Preview** first, so production is unaffected. **`VITE_` values are read at build time: redeploy after changing them.** Server values apply to new deployments too.

| Variable | Required for | Value |
|---|---|---|
| `APP_URL` | API, reset links | This environment's own URL, set separately for Preview and Production. Wrong values send reset links to the wrong site. |
| `VITE_SUPABASE_URL` | Sign-in | Project URL |
| `VITE_SUPABASE_ANON_KEY` | Sign-in | **Public key:** `sb_publishable_...` or legacy anon. A secret key here is refused. |
| `SUPABASE_URL` | API | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | API | **Secret key:** `sb_secret_...` or legacy service_role. Server only. A public key leaves Supabase "not configured". |
| `SUPABASE_VIDEO_BUCKET` | Optional | Defaults to `lesson-videos` |
| `SUPABASE_ANON_KEY` | Optional | Not read by the server. No longer required. |
| `GHL_PRIVATE_INTEGRATION_TOKEN`, `GHL_LOCATION_ID`, `GHL_LESSON_CALENDAR_ID` | Lessons, invoices | All three, or GHL stays "not configured" |
| `GHL_TIMEZONE` | Optional | Defaults to `America/Los_Angeles` |
| `GHL_INVOICE_PAYMENT_URL_TEMPLATE`, `GHL_PAYMENT_LINK_HOSTS` | Pay Now | See Payments |
| `GHL_WEBHOOK_PUBLIC_KEY` | Optional | See Payments |

`VITE_PORTAL_DEMO` must stay unset in Vercel (production builds ignore it regardless).

**Key formats:** no rename is needed. The installed `supabase-js` (2.118) accepts both the new and legacy keys in `createClient` and handles their different headers. The new-key path hasn't been run against the live project yet, so prove it with `/api/me` after setup.

**Expected responses:** `/api/health` shows `{"supabase":true,"ghl":true}` once configured. `/api/me` returns 503 until Supabase is configured, then 401 without a session. It only returns 200 when signed in with a portal account, so a 401 is the correct result for an anonymous check.

## 1. Supabase

### Migration status

`supabase/migrations/0001_portal.sql` is **already applied to the live project. Do not run it there again**; it isn't written to be re-run. Put later changes in a new file.

The live project had extra restrictions added when it was applied: `execute` on `current_account_id()`, `is_teacher()` and `can_view_student(uuid)` was revoked from `public` and `anon` and granted to `authenticated`. The repo file now includes those statements, so **the file and live project match on this, as reported**. Nobody has diffed the live schema against the file. Compare them once, for example with `supabase db diff`.

Effect: an anon-role query on a table whose policy calls these functions now gets a permission error instead of an empty result. That's safe, and the portal never queries that way because the API uses the secret key.

**Helper functions and exposed schemas:** the three `SECURITY DEFINER` functions are in `public`, so signed-in users can call them directly through the Data API. Today's exposure is small: each answers only about the caller or returns one boolean, and `can_view_student` can only confirm a student ID the caller already has. Moving them to a non-exposed schema is still recommended, but not urgent. It takes a new migration that creates a `private` schema, grants it `usage` and the function `execute` to `authenticated`, recreates the functions there, and replaces **all** the policies that call them in one transaction. Test family and teacher reads before and after. It hasn't been done.

### Setup

1. Auth settings: **turn off public sign-ups**, enable TOTP MFA, and add `<APP_URL>/reset-password` for each environment to the redirect allow list. Set up custom SMTP so reset emails are reliable. Set the password minimum to at least 12 characters. Sign-ups being off is defense in depth: a login with no `accounts` row gets 403 regardless.
2. Email OTP expiry: the app's copy says reset links expire in 24 hours, which means 86400 seconds, Supabase's maximum. Either set that, or tell us the value you prefer so the copy can change.
3. Create the teacher: add a user in the Supabase dashboard, then insert their row:
   ```sql
   insert into accounts (user_id, role, email, display_name)
   values ('<auth user id>', 'teacher', '<email>', 'Zane Luper');
   ```
   On first sign-in the portal requires 2FA enrollment before any teacher data loads.
4. Check the bucket's file size limit. The design says uploads up to 2 GB; confirm your plan allows it, or lower the copy in `UploadVideoDialog`. Large files may need resumable uploads (TUS), which the portal doesn't do yet.

### Data model

`accounts` (user, role, status) · `students` (`ghl_contact_id`, `billing_contact_id`) · `account_students` (`can_book`, `can_pay`) · `lesson_notes` (draft/published) · `videos` · `video_assignments` (`watched_at`) · `practice_assignments` · `practice_assignment_students` (`completed_at`) · `invitations` (SHA-256 `token_hash`, 7-day expiry) · `audit_log`.

## 2. GoHighLevel

Create a **Private Integration Token** for the sub-account with these scopes, and set `GHL_PRIVATE_INTEGRATION_TOKEN`, `GHL_LOCATION_ID`, `GHL_LESSON_CALENDAR_ID`:
`calendars.readonly`, `calendars/events.readonly`, `calendars/events.write`, `contacts.readonly`, `invoices.readonly`.

Do not touch the Free Intro Call widget (`vc5JhcEjhKFs3MpJyj9p`). The portal only uses the student lesson calendar.

| Service function | GHL call | Version header |
|---|---|---|
| `getFreeSlots` | `GET /calendars/{calendarId}/free-slots` (31-day maximum) | 2021-04-15 |
| `createAppointment` | `POST /calendars/events/appointments` | 2021-04-15 |
| `updateAppointment` | `PUT /calendars/events/appointments/{eventId}` | 2021-04-15 |
| `getAppointment` | `GET /calendars/events/appointments/{eventId}` | 2021-04-15 |
| `listCalendarEvents` | `GET /calendars/events` | 2021-04-15 |
| `getContactAppointments` | `GET /contacts/{contactId}/appointments` | 2021-07-28 |
| `listInvoices` | `GET /invoices/?altId&altType=location&contactId&limit&offset` | 2021-07-28 |
| `getInvoice` | `GET /invoices/{invoiceId}` | 2021-07-28 |

### Verify first, against the live API

- [ ] Are invoice `total` and `amountDue` in dollars or cents? The code assumes dollars. A wrong assumption shows wrong amounts.
- [ ] Does `GET /invoices/` really filter by `contactId`? The code also re-checks ownership on every row.
- [ ] What status does an overdue invoice report? The spec lists `draft, sent, payment_processing, paid, void, partially_paid`. Anything else with money due blocks booking.
- [ ] Does `getAppointment` wrap its result in `event`? The code accepts both shapes.
- [ ] `toLessonDTO` detects Zoom from the appointment's address or title. Confirm how Zoom lessons are stored, and whether cancelled ones appear in `appointmentStatus`.

### Student mappings (required)

Each student needs a row in `students`, and this mapping is what every access check depends on:
- `ghl_contact_id`: the student's GHL contact, whose appointments are the student's lessons.
- `billing_contact_id`: **the responsible payer's** GHL contact, whose invoices decide the booking block. For a child, use the parent. For an adult, it's the same as `ghl_contact_id`.

No GHL custom fields or objects are required. Invitations create the `accounts` and `account_students` rows. Guardian-to-student links live in `account_students`.

### Why some data isn't in GHL

Lesson notes, drafts, video files and assignments for minors need row-level privacy, private drafts and expiring playback links. GHL custom fields and media don't provide those documented guarantees, so this data is in Supabase. The design's "stored in GHL Media" copy was changed to "stored privately" for that reason.

## 3. Payments

**This is the biggest open gap.** GHL's invoice API has no hosted payment URL field. `Text2PayInvoiceResponseDto.invoiceUrl` exists, but that call creates a new invoice, so it isn't usable here.

1. Open a real test invoice's payment page and confirm whether its URL follows a stable pattern from the invoice ID.
2. If so, set `GHL_INVOICE_PAYMENT_URL_TEMPLATE="https://HOST/PATH/{invoiceId}"` and `GHL_PAYMENT_LINK_HOSTS="HOST"`.
3. If not, the fallback is sending the invoice through `POST /invoices/{invoiceId}/send`, which needs `invoices.write` and a change to `getInvoicePaymentLink`.

Until then **Pay Now returns 503 and the button shows that message.** Stripe Link availability is controlled by the checkout GHL opens; nothing in the portal can turn it on.

Payment status is always read live from GHL, and the portal never writes it. The "Mark paid", "Remind", "Send" and "Void" actions return `501` by design. No Stripe webhook is needed for correct behavior.

`POST /api/webhooks/ghl` verifies RSA-SHA256 over the raw body from the `x-wh-signature` header against `GHL_WEBHOOK_PUBLIC_KEY`, and rejects everything if that key is unset. It changes no state. **Confirm the header and key against GHL's webhook documentation before relying on it.**

## 4. Booking restriction

`createLessonBooking` in `server/services/booking.ts`, in order: authorize the account → read every invoice for `billing_contact_id` live → any outstanding amount returns `402 outstanding_balance` with the required message → confirm the slot is still free → create the appointment. If GHL can't be read, nothing is booked. Rescheduling an existing lesson isn't blocked by a balance, matching the design, but is refused inside 24 hours.

**Invoices due immediately** is a GHL setting on how invoices are created. The portal displays the due date GHL returns and doesn't set it. Update the GHL invoice template or automation.

## 5. Teacher permissions and 2FA

- Teacher routes need `role = 'teacher'` and a session at `aal2`. A family account with a verified factor also needs `aal2`.
- **Owner decision:** 2FA stays optional for family accounts, matching the approved design's "Set this up later" and "Turn on 2FA" banner. It is required for the teacher, and for any family account once enrolled. Do not make it mandatory for families without asking the owner.
- Roles come only from the `accounts` table. No route accepts a role from the browser except the teacher's invitation form, which allows only `guardian` or `student`.
- Enrollment and verification use Supabase's `mfa.enroll` and `mfa.challengeAndVerify`. No code is checked in the browser.
- **Recovery codes:** Supabase TOTP has no recovery codes. The screens stay, but say they aren't available. Enroll a second authenticator device for the teacher account now, because a lost phone otherwise means a manual reset by a Supabase administrator.
- Suspending an account sets `status = 'suspended'` and bans the auth user. The status is checked on every request.

## Authentication review results

| Requirement | Result | How |
|---|---|---|
| Public registration can't create portal accounts | Met, tested | A login without an `accounts` row gets 403 |
| Invitation-only enrollment on the server | Met, tested | Hashed, expiring, single-use, rate limited |
| Roles can't be escalated | Met, tested | Stored server-side; request fields ignored |
| Supabase validates passwords and TOTP | Met in code | The browser only calls Supabase. Not yet run live. |
| Protected APIs require verified MFA | Teacher always; family once enrolled | Owner decision: optional for families |
| Family boundaries | Met, tested | Every student, invoice, appointment and video is checked |
| Verified, expiring recovery link | Met in code, **test live** | Page requires Supabase's `PASSWORD_RECOVERY` event. Expiry is the OTP setting. |
| Backend validates tokens | Met, tested | `auth.getUser` on every request |
| Frontend can't bypass security | Met, tested | All checks are server-side |
| Missing credentials fail safely | Met, tested | 503. Sign-in shows "not connected". |

**Test these live, because they can't be proven with fakes:**
- [ ] Open a reset link: the form appears. Open `/reset-password` directly while signed in: it refuses.
- [ ] Reset the password **on an account with 2FA on.** Supabase may refuse it with `insufficient_aal`. The screen then says so, but that account would have no self-service reset, so tell the repo owner if it happens.
- [ ] Change a password in Security with the right and wrong current password. This uses `updateUser({ current_password })`, so confirm the project accepts it.
- [ ] Confirm `sb_publishable_` and `sb_secret_` keys work for sign-in, admin user creation and storage signing.

### Code changes in this pass

- `0001_portal.sql`: added the live function permissions and a do-not-reapply notice.
- **Password reset:** `/reset-password` now requires a verified recovery link. A signed-in session alone could change the password before. It also signs out all sessions after a reset.
- **Password change:** now uses Supabase's `current_password` check. The old approach re-signed in and dropped the 2FA level.
- **Invoice privacy:** linked accounts without `can_pay` no longer receive invoices. They see "balance unavailable" and can't book from the UI.
- **Invitation failure:** if account setup fails after the login is created, the login is deleted and the invitation reopened. A retry would previously have failed forever.
- **Teacher preview:** can't mark assignments complete.
- **Keys:** new and legacy formats are recognized. A key in the wrong place is refused rather than used. `SUPABASE_ANON_KEY` is no longer required by the server.
- Added tests for all of the above and for `vercel.json` routing.

## API contract

All responses are JSON. Errors are `{ "error": { "code", "message" } }`. Types are in `shared/portal-types.ts`. Requests carry `Authorization: Bearer <Supabase access token>`, except where marked public.

| Method and path | Who | Purpose |
|---|---|---|
| `POST /api/invitations/verify` | public, rate limited | Check a code or link token |
| `POST /api/invitations/redeem` | public, rate limited | Create the account, single use |
| `GET /api/me` | signed in | Profile, role, feature flags |
| `GET /api/portal/dashboard?studentId=` | family; teacher read-only | Lessons, notes, videos, billing (`billing: null` means unavailable) |
| `GET /api/lessons/slots?studentId&from&to` | family | Open times |
| `POST /api/lessons` | family | Book, enforces the balance rule |
| `POST /api/lessons/:eventId/reschedule` | family | Move a lesson, 24-hour rule |
| `POST /api/invoices/:id/payment-link` | payer | Authorized payment URL |
| `GET /api/videos/:id/playback` | assigned family, teacher | Signed URL, 15 minutes |
| `POST /api/videos/:id/watched` | family | Record watched |
| `POST /api/assignments/:id/complete` | family | Completion tracking |
| `POST /api/packages/purchase`, `/api/autopay`, `/api/referrals/*` | any | `501`, not enabled |
| `GET /api/teacher/students`, `/students/:id`, `/overview`, `/calendar`, `/invoices`, `/settings` | teacher | Studio data |
| `POST /api/teacher/notes`, `PUT /notes/:id`, `POST /notes/:id/publish` | teacher | Notes |
| `GET,POST /api/teacher/videos`, `/videos/url`, `/videos/upload`, `PUT /videos/:id`, `GET,PUT /videos/:id/assignees` | teacher | Library |
| `GET,POST /api/teacher/assignments` | teacher | Practice assignments |
| `GET,POST /api/teacher/invitations`, `POST /invitations/:id/revoke` | teacher | Invitations |
| `POST /api/teacher/accounts/:id/password-reset`, `/suspend`, `/restore` | teacher | Access management |
| `POST /api/webhooks/ghl` | signed by GHL | See Payments |

## Production blockers

1. Portal has never run against live services. Auth accounts don't exist yet.
2. **Pay Now has no confirmed payment URL** (see Payments).
3. GHL "Verify first" list is unanswered, including dollars versus cents, which affects the balance rule's displayed amounts.
4. No student mappings exist, and without them nobody has lessons or invoices.
5. Owner review of the privacy notice and consent for minors' data.
6. Families can't yet see or complete practice assignments in the UI. The backend exists, but `/portal/assignments` goes to the videos section.
7. Rate limits are per instance. Move them to a shared store before launch.
8. Rich-text notes were requested; notes are plain text.

## Known limitations

- **Invitation emails aren't sent.** The portal creates a link or code, copies it, and shows it once; Zane sends it. Only a hash is stored, so a lost one means issuing a new invitation. Wire up an email sender to automate this.
- **Rate limits are per server instance.** Move `server/rateLimit.ts` to a shared store such as Upstash before relying on it under real traffic.
- **Features with UI but no backend:** lesson packages, referrals, autopay, weekly repeat bookings, adult-account transfer, recovery codes, invoice PDF download. All say they aren't active. None charges or discounts anything.
- **Notes are plain text** in the design's five fields, not rich text, and render as text so no HTML can be injected.
- **Enrollment codes are `SFTM-XXXX-XXXX`**, longer than the design's `SFTM-XXXX`, which was short enough to guess.
- **Design decisions to confirm:** the booking dialog shows only the 60-minute $100 lesson. The prototype's data also had an unused 45-minute $75 option, which isn't offered.
- **`/portal/*` subroutes** are sections or dialogs of the single approved dashboard, not separate pages.
- **Views use a loosely typed view model** (`VM`), so a wrong field shows as blank instead of failing the type check. Inline styles come straight from the approved design.

## Production checklist

- [x] Vercel preview builds and `/`, `/book`, `/signin`, `/teacher`, `/api/health` load (reported).
- [x] Migration applied (reported).
- [ ] After the next deploy, confirm `/portal`, `/reset-password` and `/api/me` on the preview. `/api/me` should return 503, then 401 once configured.
- [ ] Set all environment variables in Vercel, Preview first, then redeploy.
- [ ] Turn off public sign-ups, create the teacher, enroll 2FA and a backup device.
- [ ] Complete "Test these live" above.
- [ ] Complete "Verify first" and the payment URL step.
- [ ] Add one test family and confirm: another family's data is refused, drafts are hidden, a balance blocks booking, paying unblocks it.
- [ ] Confirm the CSP allows the real Supabase host and that video playback works.
- [ ] Review the privacy notice and consent for storing minors' data with Supabase.
- [ ] Merge only after all of the above.
