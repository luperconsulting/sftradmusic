# Backend Integration Handoff

What's needed to connect the SF Trad Music portal (branch `feat/student-teacher-portal`) to live services.

**Status: nothing here has been run against real Supabase, GoHighLevel or Stripe.** The API is tested with fake services only. GHL paths and fields come from GoHighLevel's published OpenAPI files (`github.com/GoHighLevel/highlevel-api-docs`, `apps/calendars.json`, `contacts.json`, `invoices.json`), but they have not been called.

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

Names and purpose are in `.env.example`. `VITE_` values ship to the browser, so only the Supabase URL and anon key may use that prefix. `VITE_PORTAL_DEMO` must stay unset in Vercel (production builds ignore it regardless).

## 1. Supabase

1. Create the project and apply `supabase/migrations/0001_portal.sql`. It creates the tables, RLS policies and the private `lesson-videos` bucket.
2. Auth settings: **turn off public sign-ups**, enable TOTP MFA, and add `<APP_URL>/reset-password` to the redirect allow list. Set up custom SMTP so reset emails are reliable.
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
- Enrollment and verification use Supabase's `mfa.enroll` and `mfa.challengeAndVerify`. No code is checked in the browser.
- **Recovery codes:** Supabase TOTP has no recovery codes. The screens stay, but say they aren't available. Enroll a second authenticator device for the teacher account now, because a lost phone otherwise means a manual reset by a Supabase administrator.
- Suspending an account sets `status = 'suspended'` and bans the auth user. The status is checked on every request.

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

- [ ] Open a Vercel **preview** deployment and confirm `/`, `/book`, `/signin`, `/teacher` and `/api/health` load. The Vercel routing in `vercel.json` hasn't been run on Vercel.
- [ ] Set all environment variables in Vercel, preview first.
- [ ] Apply the migration, turn off public sign-ups, create the teacher, enroll 2FA and a backup device.
- [ ] Complete "Verify first" and the payment URL step.
- [ ] Add one test family and confirm: another family's data is refused, drafts are hidden, a balance blocks booking, paying unblocks it.
- [ ] Confirm the CSP allows the real Supabase host and that video playback works.
- [ ] Review the privacy notice and consent for storing minors' data with Supabase.
- [ ] Merge only after all of the above.
