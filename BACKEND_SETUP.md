# Backend setup — email, ticket auto-capture & overdue nudges

The Command Center front-end works without a backend. Turning on the backend adds:

- **Email in:** every new message to `sales@safewavetech.com` becomes a support
  ticket, and is logged on the matching CRM account automatically.
- **Email out:** send replies from `sales@` right inside a ticket/account; every
  send (including auto-replies) is logged to the timeline.
- **Overdue nudges:** a daily scan flags stale accounts and SLA-breached tickets
  onto Pulse.

It runs on **Firebase Cloud Functions** (code in `functions/`). This is the one
part that needs a few one-time setup steps. None of your email password or data
is ever committed to this repo.

## One-time setup

1. **Upgrade the Firebase project to the Blaze (pay-as-you-go) plan.**
   Console → ⚙ → Usage and billing → Modify plan → Blaze. Cloud Functions require
   it. At your volume this costs about a dollar a month; there's a free monthly
   allowance below that.

2. **Enable Firestore** (if not already): Console → Build → Firestore Database →
   Create database (production mode). Publish the rules in `firestore.rules`.

3. **Store the mailbox password as a secret** (not in the repo). From the repo
   folder, once Firebase CLI is installed (`npm i -g firebase-tools` then
   `firebase login`):
   ```
   firebase functions:secrets:set IONOS_PASSWORD
   ```
   Paste the `sales@safewavetech.com` mailbox password (or an app password) when
   prompted. Non-secret settings live in `functions/.env` (copy from
   `functions/.env.example`) — the defaults already point at IONOS.

4. **Give the deploy service account permission** to deploy functions. In Google
   Cloud Console → IAM, grant the account used by the GitHub Action
   (`FIREBASE_SERVICE_ACCOUNT`) these roles: **Cloud Functions Admin**,
   **Service Account User**, **Cloud Scheduler Admin**, and **Secret Manager
   Secret Accessor**.

5. **Deploy the functions.** Either:
   - GitHub → **Actions → "Deploy Cloud Functions" → Run workflow**, or
   - locally: `firebase deploy --only functions`.

That's it. Within ~5 minutes new `sales@` emails start appearing in **Support**,
and the reply button in a ticket sends from your mailbox.

## What each function does
| Function | Trigger | Purpose |
|---|---|---|
| `ingestEmail` | every 5 min | Read `sales@` inbox → create tickets + log CRM activity |
| `sendReply` | called from the app | Send a reply from `sales@`, log it to the ticket/account |
| `scanOverdue` | daily | Flag stale accounts + SLA-breached tickets into `nudges/summary` |

## Notes
- Every outbound email (including AI-drafted/auto-replies) is sent only when a
  human clicks send in the app — nothing sends autonomously.
- IONOS uses IMAP (`imap.ionos.com:993`) and SMTP (`smtp.ionos.com:587`).
- The live **client-dashboard device feed** (who's online, bands, uploads) reads
  your *product* Firebase project and is added once that project's read-only
  service account + data shape are provided.
