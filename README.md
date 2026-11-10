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
