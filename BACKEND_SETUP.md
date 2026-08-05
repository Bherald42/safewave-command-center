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

## Install to home screen (PWA)
The app ships a web manifest (`public/manifest.webmanifest`) + service worker
(`public/sw.js`), so on the live HTTPS site it can be installed to a phone home
screen (Android: "Install app"; iOS Safari: Share → Add to Home Screen). It then
opens full-screen like a native app. The service worker already handles `push`
notifications — it just needs a sender (below).

## New-order alerts — Shopify webhook (built; needs wiring)
The `shopifyOrderWebhook` function is live. It verifies each request came from
Shopify, writes the order to `orders/{id}` (the app's fulfilment queue reads
these live), and creates a `to:"all"` notification so **everyone** gets the
new-order alert in-app (and as a phone/desktop push once they tap "Enable
alerts"). To turn it on:

1. **Get the function URL.** After a deploy it's
   `https://us-central1-safewave-command-center.cloudfunctions.net/shopifyOrderWebhook`
   (confirm in Firebase console → Functions).
2. **Create the webhook in Shopify.** Settings → Notifications → Webhooks →
   *Create webhook* → Event **Order creation**, Format **JSON**, URL = the
   function URL above. (Shopify shows a signing secret when you add webhooks.)
3. **Store the signing secret** as a repo secret so the function can verify
   requests: GitHub → repo **Settings → Secrets and variables → Actions →
   New repository secret**, name `SHOPIFY_WEBHOOK_SECRET`, value = the secret
   from Shopify. Re-run the functions deploy so it picks it up.

Until the secret is set the endpoint returns `503` (it refuses unverified
writes). Optional later: add **email** alerts (reuse `sendUserEmail` from an ops
account) and true background **FCM push** (VAPID key + `firebase-messaging-sw.js`
+ device tokens) — the service worker's `push` handler is already in place.

## New Firestore collections (rules already included)
`inventory/main` (location counts), `fulfillments/{orderId}` (QC + firmware +
sign-off), `build_tasks`, `campaigns`, `chat_channels/*/messages`,
`settings/chat`, `finance/main`, `settings/finance`.

## Notes
- Support-ticket replies and account emails are human-initiated. **Campaign
  emails send automatically** once a campaign is activated and accounts are
  enrolled — pause the campaign to stop sends.
- Stock: Covington is the sellable/QC pool; fulfilling an order decrements it and
  logging a return adds back. QR labels print from the fulfilment card (the QR
  image comes from a public QR generator).
- Users should use an **app password** (Gmail/Outlook/IONOS all offer one), not
  their main login password.
- Future hardening: OAuth mailbox connect (Gmail/Microsoft) and encrypting
  stored credentials with a backend key.
