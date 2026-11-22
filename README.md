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

## Booking page setup (Google Calendar and Gmail)

The booking widget at `/book` offers 15-minute intro calls during your weekly hours (`BOOKING_HOURS`), minus anything busy in Google Calendar. When someone confirms, the server checks the time is still free, then:
1. creates the event on your booking calendar
2. emails the client a confirmation with a calendar invite attached
3. emails you a "New intro call" notice

Everything runs on the server, and there is no Google key anywhere. On Vercel, each function has an OIDC token. Google's Workload Identity Federation exchanges that token for a short-lived access token that impersonates a service account. The scopes requested are `https://www.googleapis.com/auth/calendar.freebusy` and `https://www.googleapis.com/auth/calendar.events`. The service account can only change calendars you've shared with it as "Make changes to events".

A service account can't invite people to a Google event, so the client's invite arrives as an attachment on the confirmation email. Google, Apple and Outlook calendars all accept it.

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

7. **Share the calendars.** In Google Calendar, open each calendar's settings and use **Share with specific people** to add `SA_EMAIL`. Copy each calendar's ID from **Integrate calendar**.
   - **The calendar intro calls go on** (listed first in `GOOGLE_CALENDAR_IDS`): give it **Make changes to events**.
   - **Any other calendar that should only block times:** **See only free/busy (hide details)** is enough.

7a. **Gmail app password.** In the Google Account that sends the emails, turn on 2-Step Verification. Then create an app password under **Security → App passwords**. It goes in Vercel as `SMTP_PASS` and is the one secret here. Google Workspace accounts may need an admin to allow app passwords first.

8. **Set the Vercel environment variables:**

   Only `SMTP_PASS` is a secret. The other optional settings (notice, booking horizon, meeting details, who gets notices) are listed in `.env.example`.

   | Variable | Value |
   | --- | --- |
   | `GCP_PROJECT_NUMBER` | The numeric project number, not the project ID |
   | `GCP_WORKLOAD_IDENTITY_POOL_ID` | `POOL_ID` |
   | `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID` | `PROVIDER_ID` |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `SA_EMAIL` |
   | `GOOGLE_CALENDAR_IDS` | Calendar IDs, comma separated. Intro calls go on the first one |
   | `SMTP_USER` | The Gmail address the emails come from. You get the booking notices here too |
   | `SMTP_PASS` | The Gmail app password. **This one is a secret** |
   | `BOOKING_HOURS` | Optional. Weekly hours in Los Angeles time; default `mon-fri 10:00-18:00` |

   Redeploy after setting them.

**Checking it works:** open `/api/booking/availability?from=YYYY-MM-DD&to=YYYY-MM-DD` on the deployment, with a range of 31 days or less. If any setting is missing, or Google refuses the exchange or the calendar read, it returns `503 availability_unavailable` and nothing else. The Vercel function log then shows a short reason such as `[google] free/busy failed: google auth 403` or `google calendar not readable`. Local `npm run dev` has no Vercel OIDC token unless you run `vercel env pull`, so locally the endpoint returns the safe error.

**Testing a booking on a Preview:** on Preview deployments, calendar events are titled `[Preview] Intro call: …`. Confirmation emails go only to addresses in `BOOKING_TEST_EMAIL_ALLOWLIST` (default `luperdev@gmail.com`), and you always get the notice. Book with that address, check both emails and the event, then delete the event from your calendar. If a booking fails, the function log shows a short reason, such as `[google] create event failed: google events 403` (the calendar isn't shared as "Make changes to events") or `[mail] "…" was not sent (535)` (the app password is wrong).
