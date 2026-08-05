# Backend setup — per-user email + overdue nudges

The Command Center front-end works without a backend. Turning on the backend adds:

- **Send email from the CRM** — each teammate connects their **own** mailbox
  (Account → Connect email); "Email this account" then sends from their address
  and logs it to the account timeline. No shared mailbox or secret required.
- **Overdue nudges** — a daily scan flags stale accounts and SLA-breached
  tickets into `nudges/summary`.

It runs on **Firebase Cloud Functions** (code in `functions/`). No email
passwords live in this repo — each user's credentials are stored privately in
Firestore (`mail_credentials/{uid}`, owner-only), and the function reads them
server-side to send.

> **Deferred:** ingesting customer support tickets from a shared `sales@` inbox
> is on hold until that mailbox exists. It'll be re-added as its own function.

## One-time setup

1. **Blaze plan** — already enabled. (Cloud Functions require it.)

2. **Firestore enabled** — Console → Build → Firestore Database → Create database
   (production mode). Publish the rules in `firestore.rules`.

3. **Give the deploy service account permission.** In Google Cloud Console →
   IAM, grant the account behind the `FIREBASE_SERVICE_ACCOUNT` GitHub secret
   these roles: **Cloud Functions Admin**, **Cloud Build Editor**,
   **Artifact Registry Administrator**, **Service Account User**, and
   **Cloud Scheduler Admin**. (I'll confirm the exact one from the first deploy
   log if any is missing.)

4. **Deploy.** GitHub → **Actions → "Deploy Cloud Functions" → Run workflow**.
   (Or locally: `firebase deploy --only functions`.)

That's it — no secrets to set. After deploy, "Email this account" and ticket
replies send in-app from each user's own connected address.

## Functions
| Function | Trigger | Purpose |
|---|---|---|
| `sendUserEmail` | called from the app | Send from the signed-in user's mailbox; log to the account/ticket |
| `sourceProspects` | called from the app | Source new commercial contacts from Google Places for the CRM Prospector |
| `runCampaigns` | daily 15:00 UTC | Send the next due step of every active outreach campaign, personalised per account + use case |
| `scanOverdue` | daily 13:00 UTC | Flag stale accounts + SLA-breached tickets into `nudges/summary` |

## Prospector — Google Places API key
The CRM **Prospector** sources real businesses (audiology clinics, senior-living,
schools, VR agencies) with name, address, phone and website. It needs a Google
Places API key:

1. In Google Cloud Console → **APIs & Services**, enable the **Places API (New)**.
2. Create an API key (restrict it to the Places API).
3. Put it where the function can read it — either:
   - add a line to `functions/.env`:  `PLACES_API_KEY=your_key_here`  (Cloud
     Functions v2 loads `.env` automatically), **or**
   - set it on the deployed service's environment.
4. Redeploy functions.

Until the key is set, the Prospector shows a clear "add your key" message instead
of failing. The key lives only on the server — never in the client bundle.

## Campaigns — automated outreach
`runCampaigns` sends each account's next due campaign step from the campaign
owner's connected mailbox (so activate a campaign only after connecting email).
Steps are personalised with `{{firstName}}`, `{{company}}`, `{{city}}` and carry
the Safewave use-case pitch. Enrollment/step state lives on each `crm_accounts`
doc under `campaign`; campaigns live in the `campaigns` collection.

## Notes
- Support-ticket replies and account emails are human-initiated. **Campaign
  emails send automatically** once a campaign is activated and accounts are
  enrolled — pause the campaign to stop sends.
- Users should use an **app password** (Gmail/Outlook/IONOS all offer one), not
  their main login password.
- Future hardening: OAuth mailbox connect (Gmail/Microsoft) and encrypting
  stored credentials with a backend key.
