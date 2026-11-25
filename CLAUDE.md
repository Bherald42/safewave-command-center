# Safewave Command Center — working guide for Claude

This file is auto-loaded at the start of every Claude Code session in this repo.
Read it first. It tells you how the app is built, how it ships, and the rules that
must never be broken. If you follow it, a brand-new chat behaves exactly like the
one that built this app — no extra setup, no extra permissions.

## What this is

Safewave Command Center is the internal ops platform for **Safewave Technology**,
maker of the **Safewave Band** — a vibration-alert wristband for the Deaf and
hard-of-hearing. The Command Center runs the whole company: CRM, support tickets,
build board, inventory & fulfillment, financials, fundraising, campaigns, team
pulse, feedback, and an in-app AI assistant ("Ask Safewave").

## Architecture (know this before editing)

- **Frontend is ONE file: `public/index.html`** (~300KB+). Vanilla HTML/CSS/JS,
  no build step, no framework, no bundler. All screens, styles, and logic live
  inline in this single file. Firebase compat SDKs are loaded via script tags plus
  `/__/firebase/init.js`. **Do not introduce a build tool or split the file** unless
  the user explicitly asks — the single-file design is intentional.
- **Backend is `functions/index.js`** — Firebase Cloud Functions v2 (Node 20):
  `sendUserEmail`, `sourceProspects`, `shopifyOrderWebhook`, `runCampaigns`,
  `scanOverdue`, `askAgent` (calls the Anthropic Messages API, model
  `claude-sonnet-5`, with a local fallback in the frontend).
- **Alerts reach phones by Web Push.** Every alert is a `notifications` doc; the
  backend pushes it to the recipient's devices (`push_subs`, owner-only) with a
  VAPID key it generates and keeps in `server_keys/vapid` (no client access, no
  secret to set). Server code adds alerts with `addNotification()`; the app calls
  `pushNow` after it writes one; `scheduledShopifySync` sweeps anything missed.
  Devices opt in from the Alerts sheet (bell). iPhone needs the Home Screen app.
- **Support tickets carry app diagnostics.** The phone app's Help & Support
  messages are forwarded by `forwardSupportToCommandCenter` (in the
  `safewave-dashboard` repo, app project `safewave-371716`) to `ticketIntake`,
  with the customer's device, bands and recent `activity_logs` (technical fields
  only, never notification content). Logs land in `ticket_diag/{ticketId}`;
  `diagnoseTicket` writes `tickets.diagnosis` (built-in rules, or the AI model
  when `ANTHROPIC_API_KEY` is set) — a draft the team reviews before sending.
  `scanFieldHealth` (dashboard repo, an `activity_logs` trigger — that project has
  no Cloud Scheduler) also opens **AUTO-** tickets on its own from app telemetry (failed firmware update, alerts can't reach the
  band, repeated disconnects, band silent 2+ days); one per customer + issue,
  reopened if it recurs. Super admins can pause it (`settings/support.autoTickets`).
- **Shopify and the sales@ inbox connect from inside the app.** A super admin
  pastes the Shopify app keys (Stock → Connect Shopify) or the IONOS mailbox
  password (Support → Connect); Cloud Functions test them and keep them in
  `server_keys/{shopify,inbox}` (no client access). Repo secrets still win if set.
  `scheduledShopifySync` (every 15 min) syncs orders/stock and reads new sales@
  mail (IMAP, read-only) into Email tickets; email tickets reply from sales@.
  Stock mirrors Shopify's on hand / committed / available per size into
  `settings/shopify`; **Send Covington counts to Shopify** (`pushStockToShopify`)
  sets Shopify's on-hand to the Covington counts (needs the `write_inventory` scope).
  Stock moves keep both in step: orders shipped in Shopify itself take bands off
  Covington (`deductShopifyShipment`, guarded by the `fulfillments` doc); restocked
  returns, Pace transfers received and Covington hand edits are sent to Shopify
  as deltas (`adjustShopifyStock`). The app moves stock with `invMove()` increments.
  Orders keep what was ordered (`orders.items`: size × qty) and where shipped ones
  are (`orders.ship`: carrier status, ETA, delivered date — `refreshShipments` on
  every sync); Orders → To ship shows the sizes, shipped ones split into On the
  way / Delivered.
  Stock Forecast plans from real Shopify sales: `computeSalesVelocity` (every
  sync) writes `settings/shopify.velocity` — 12 weekly counts per size, 4/12-wk
  averages, and `burn` = 60% last-4-wk + 40% last-12-wk, which feeds `BURN`.
  The fulfill sheet connects the actual band over Web Bluetooth (`ffConnectBand`):
  reads firmware (OTA READ_VER), battery and System ID (`hw.hwId`), offers an
  update to the newest Production firmware via the Release Checks flasher
  (`qcOtaFlashStart(relId,{device})`), buzz-tests it, ticks the checklist, and
  saves the band's identity on `bands/{serial}.hw` + `fulfillments.band`.
- **Invoices & customer POs** (Enterprise → Invoices & POs). Invoices are
  numbered from `counters/invoices`, carry line items, terms, payments and a
  history; sent invoices are voided, never deleted. The PDF is drawn server-side
  (`invoicePdf`, pdfkit) so a download and the emailed copy (`sendInvoice`, from
  sales@ when connected) are identical. The PDF carries the logo (bundled
  `functions/assets/safewave-logo.png`, or one uploaded in Letterhead) and a
  How-to-pay block: ACH details live server-only in `server_keys/invoice_remit`
  (set via `saveInvoiceRemit`, finance group; the app sees only last 4), plus
  check remit-to address and an optional card link from `settings/invoicing`. Customer POs keep the uploaded file in
  Storage (`customer_pos/`) and link to the invoices made from them.
  `scanOverdue` alerts the invoice's creator once when it goes past due.
- **Navigation** (`NAV_GROUPS`): Home (bottom bar on phones) · Enterprise
  (Pipeline · Accounts · Invoices & POs) · Support (All / Consumer / Enterprise
  case filter, `tkSegment`) · Operations (Orders → To ship · All orders · Returns;
  Inventory; Stock Forecast) · Product & Quality (Priorities · Projects · Roadmap ·
  Release Checks · Field Testing · Feedback) · Fundraising · Finance · Resources ·
  Settings. A group's `pills` can point at views inside a page (`navPill`); screens
  that switch their own view call `refreshSubnav()`.
- **Data is Firestore.** Collections include: `users`, `crm_accounts`, `tickets`,
  `campaigns`, `build_tasks`, `build_projects`, `inventory`, `fulfillments`,
  `bands`, `returns`, `orders` (server-write only), `purchase_orders` (supplier POs),
  `invoices` + `customer_pos` + `invoice_products` (Enterprise → Invoices & POs; `counters/invoices`,
  `settings/invoicing` letterhead),
  `notifications`, `nudges`, `mail_credentials`, `chat_channels/{ch}/messages`,
  `feedback` (super-admin read), and `settings/{finance,chat,raise}`.
- **Access rules live in `firestore.rules`** and `storage.rules`. Financials are
  gated to a super-admin-managed allow-list; feedback is readable only by super
  admins; `orders` are server-write only.

## How it ships (the "connections")

Everything deploys through **GitHub Actions on merge to `main`** — there is no
manual deploy and no local Firebase CLI step for you to run.

- `.github/workflows/firebase-hosting-merge.yml` — deploys **Hosting** (the app)
  on every push to `main`.
- `.github/workflows/deploy-functions.yml` — deploys **Functions + Firestore rules
  + Storage rules** when `functions/**`, `firebase.json`, `firestore.rules`, or
  that workflow change on `main`. It injects secrets from **encrypted GitHub Actions
  repo secrets** into a gitignored `functions/.env` at deploy time:
  `PLACES_API_KEY`, `SHOPIFY_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`.

**Secrets never live in the repo.** They are GitHub repo secrets, injected only on
the deploy runner. Never commit a key, never print one, never move one into
`public/`. Mail passwords live owner-only in Firestore, never in code.

## Your workflow every session

1. **Develop on your own branch.** Each session uses a fresh `claude/<something>`
   branch. **Never reuse another session's branch** — parallel sessions on the same
   branch will clobber each other. If you were told a branch name, use it; otherwise
   create `claude/<short-feature-name>` off the latest `origin/main`.
2. **Verify before you ship.** This app has no test runner, so verify by:
   - `node --check` on the last inline `<script>` block extracted from
     `public/index.html` (catches syntax errors).
   - Playwright headless smoke tests via the app's built-in **"Preview the
     interface"** mode. Launch with
     `executablePath:'/opt/pw-browsers/chromium'`, import Playwright from
     `/opt/node22/lib/node_modules/playwright/index.js`. Drive the real functions
     (`goto(...)`, `renderCRM()`, etc.) and assert on DOM/state. Save a screenshot
     and Read it back to eyeball layout. Scratch tests go in the session scratchpad,
     not the repo.
   - Note: `&` and emoji serialize differently in `innerHTML` — regex smoke checks
     on those can false-negative; confirm with a screenshot before trusting a fail.
3. **Ship:** commit (with the Co-Authored-By footer) → `git fetch origin main` →
   `git rebase origin/main` → `git push -u origin <branch> --force-with-lease` →
   open a PR → squash-merge → wait for the Actions run → confirm the hosting/functions
   run went green. GitHub is done through the **GitHub MCP tools** (`mcp__github__*`),
   loaded on demand via ToolSearch. Only open a PR when the user wants one, but for
   this repo merging to `main` is how anything reaches production.

## Design & product rules (non-negotiable)

- **Logo:** the watch-and-shield mark with the "Safewave" wordmark. Files live in
  `public/brand/` (`safewave-logo.png` for light backgrounds,
  `safewave-logo-light.png` for dark, `safewave-mark.png` watch only, `favicon.png`)
  and `functions/assets/safewave-logo.png` (invoice PDF). Don't reintroduce the
  old knight logo or the Shopify-hosted `logo3x.png`.
  The Command Center's own icon (favicon `brand/cc-favicon.png`, `apple-touch-icon.png`,
  `icon-192/512.png`) is the watch on white with COMMAND above and CENTER below, so
  it's never confused with the customer app; the header shows the logo + a
  COMMAND CENTER tag (`.brand-tag`).

- **Red is reserved for life-safety only.** The Band is an accessibility/safety
  device — never use red for ordinary urgency, overdue tasks, or errors. Use **amber**
  for urgent-but-not-safety states.
- **Match the existing design.** Use the CSS design tokens already defined
  (light default + `:root[data-theme="dark"]` override; theme toggle persisted in
  `localStorage`). New UI should read like the surrounding code — same tokens,
  naming, spacing, and idioms.
- **Financials and the raise** (Fundraise, investors, data room, raise tasks and
  meetings) are editable only by the decision group: Brad, Trevon and the
  super-admin-managed finance allow-list. **Jared is an observer**: informed,
  not deciding. He can *see* everything (Financials and the raise included) and
  gets the weekly raise rollout, but has no operational decision rights. He is
  read-only on business records, enforced in `firestore.rules` (`canOperate()`,
  `canSeeRaise()`) and mirrored in the UI (`isObserver()`). He can open the Vault
  (shared logins) to view and copy, but can't add, edit or delete entries. **Feedback** is readable only by super admins.
- **Never commit customer or investor PII** to this repo.
- Write for a small internal team that is about to dogfood this. Prefer clear,
  low-friction UI over dense dashboards; the CRM went through several rounds toward
  a "metrics strip + action rail + saved views + pipeline surface" shape — keep that
  spirit.

## Housekeeping

- The user still needs to (their side, not yours): add the `ANTHROPIC_API_KEY`,
  `PLACES_API_KEY`, and `SHOPIFY_WEBHOOK_SECRET` repo secrets and re-run the relevant
  workflow to fully light up the AI assistant, prospecting, and Shopify webhook;
  enable Firebase Storage; invite the team to sign in.
- Reference docs already in the repo: `README.md`, `SPEC.md`, `BACKEND_SETUP.md`.
