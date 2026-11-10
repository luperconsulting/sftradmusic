<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/f840cdb6-056c-4289-a032-22f554afb337

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Google Calendar setup (booking widget)

The public booking widget at `/book` reads free/busy times from Google Calendar on the server. There is no Google key anywhere. On Vercel, each function has an OIDC token. Google's Workload Identity Federation exchanges that token for a short-lived access token that impersonates a service account. The only scope requested is `https://www.googleapis.com/auth/calendar.freebusy`, and the app only calls `freeBusy`. It never reads event details or creates events.

Replace `<team-slug>` with the Vercel team's slug (the part of the dashboard URL after `vercel.com/`), and `PROJECT_ID`, `PROJECT_NUMBER`, `POOL_ID`, `PROVIDER_ID` and `SA_EMAIL` with your own values.

1. **Turn on OIDC in Vercel.** In the project's Settings → Security, enable **Secure backend access with OIDC federation** and choose the **Team** issuer mode.

2. **Enable the APIs** in the Google Cloud project:

   ```bash
   gcloud services enable calendar-json.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project PROJECT_ID
   ```

3. **Create the service account.** It needs no project roles:

   ```bash
   gcloud iam service-accounts create sftradmusic-booking --project PROJECT_ID
   ```

   `SA_EMAIL` is then `sftradmusic-booking@PROJECT_ID.iam.gserviceaccount.com`. Don't create a key for it.

4. **Create the workload identity pool:**

   ```bash
   gcloud iam workload-identity-pools create POOL_ID --project PROJECT_ID --location global --display-name "Vercel"
   ```

5. **Create the OIDC provider.** It trusts Vercel's issuer, maps the subject, and accepts tokens from the `sftradmusic` project only:

   ```bash
   gcloud iam workload-identity-pools providers create-oidc PROVIDER_ID \
     --project PROJECT_ID --location global --workload-identity-pool POOL_ID \
     --issuer-uri "https://oidc.vercel.com/<team-slug>" \
     --allowed-audiences "https://vercel.com/<team-slug>" \
     --attribute-mapping "google.subject=assertion.sub" \
     --attribute-condition "assertion.project == 'sftradmusic'"
   ```

   Vercel's subject looks like `owner:<team-slug>:project:sftradmusic:environment:preview`. To allow Preview only, use the condition `assertion.project == 'sftradmusic' && assertion.environment == 'preview'` instead.

6. **Let the pool impersonate the service account.** Grant `roles/iam.workloadIdentityUser` to the pool principal:

   ```bash
   gcloud iam service-accounts add-iam-policy-binding SA_EMAIL --project PROJECT_ID \
     --role roles/iam.workloadIdentityUser \
     --member "principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/*"
   ```

   The provider's condition already limits the pool to `sftradmusic`. To narrow it to one environment, use `principal://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/subject/owner:<team-slug>:project:sftradmusic:environment:preview` as the member.

7. **Share the calendars.** In Google Calendar, open each calendar's settings and use **Share with specific people** to add `SA_EMAIL` with **See only free/busy (hide details)**. Copy each calendar's ID from **Integrate calendar**.

8. **Set the Vercel environment variables.** None of these are secrets:

   | Variable | Value |
   | --- | --- |
   | `GCP_PROJECT_NUMBER` | The numeric project number, not the project ID |
   | `GCP_WORKLOAD_IDENTITY_POOL_ID` | `POOL_ID` |
   | `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` | `PROVIDER_ID` |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `SA_EMAIL` |
   | `GOOGLE_CALENDAR_IDS` | Calendar IDs, comma separated |

   Redeploy after setting them.

**Checking it works:** open `/api/booking/availability?from=YYYY-MM-DD&to=YYYY-MM-DD` on the deployment, with a range of 31 days or less. If any setting is missing, or Google refuses the exchange or the calendar read, it returns `503 availability_unavailable` and nothing else. The Vercel function log then shows a short reason such as `[google] free/busy failed: google auth 403` or `google calendar not readable`. Local `npm run dev` has no Vercel OIDC token unless you run `vercel env pull`, so locally the endpoint returns the safe error.

## Student and teacher portal (v1)

Supabase (Postgres, Auth, Storage) is the only source of truth. GoHighLevel is not used at runtime; the old
client lives in `server/legacy/ghl/` for migrating records only, and `tests/legacy-isolation.test.ts` fails if
anything that runs imports it.

- **Open lesson times** = the teacher's weekly lesson hours (Teacher → Settings) minus Google Calendar busy times
  (the keyless setup above) minus lessons already booked or held. Lessons are 60 minutes. A Postgres exclusion
  constraint (`lessons_no_overlap`) stops double booking even if two requests race.
- **Prices**: 4-lesson package $380 by Zelle or $375 in cash up front; single session $100. Zelle and cash are
  paid offline. A package invoice adds 4 credits only when the teacher marks it paid. A booking without credits
  creates a $100 invoice and holds the slot ("pending payment") until it is marked paid; unpaid holds release after
  the teacher's hold window (default 24 hours) or at the lesson start. Holds are released whenever lessons are
  read or booked, so no scheduler is needed.
- **Referrals**: $15 off a referred student's first invoice; when it is paid the referrer gets a $25 credit,
  taken off their next invoice once.
- **Card payments** (Stripe Checkout, test keys only) appear only with `CARD_PAYMENTS_ENABLED=true`; the webhook is
  `/api/webhooks/stripe` and handles each event once.
- **Email** goes through Gmail SMTP as zane@sftradmusic.com. With `SAFE_MODE` on (Preview), only
  `SAFE_MODE_EMAIL_ALLOWLIST` addresses are emailed.
- **Ops**: `GET /api/ops/summary` with `Authorization: Bearer $OPS_API_TOKEN` returns today's lessons, unpaid
  invoices, pending holds, pending referrals and new bookings. Read-only.
- **Database**: `supabase/migrations/0005_core_data.sql` and `0006_portal_v1.sql` are not applied. Apply them
  yourself, in order, after review.
