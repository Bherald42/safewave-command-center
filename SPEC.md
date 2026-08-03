# Safewave Command Center — Master Build Prompt

*Paste the section titled "THE PROMPT" into Claude Code / Lovable / Replit / Cursor. Part 1 is context for you (the human) on what already exists in the market so you don't rebuild solved problems.*

---

## PART 1 — Market scan (read this first)

Before building, know what you're competing with and what you should *integrate* rather than *rebuild*.

**Why Monday.com is failing you (and what to avoid repeating):** Monday is fast to start and hard to scale. Boards past a couple hundred items get slow, cross-board dependencies are awkward, and engineering teams find it frustrating because it lacks native sprint management, Git integration, and keyboard-driven workflow. It's built for visual operational teams, not for a hardware+software company triaging firmware bugs. Your instinct is right.

**What the alternatives each get right — steal these ideas:**

| Tool | What it does well | Take this |
|---|---|---|
| Linear | Opinionated, fast, keyboard-first, GitHub-native issue tracking | Speed and constraint. Don't build 40 config options. |
| Notion | Wiki + database + docs in one place | Single source of knowledge model |
| ClickUp | Tasks + docs + dashboards in one | Consolidation, but avoid its bloat |
| Attio / HubSpot | Modern relationship-first CRM | Org → contacts → deals → activity data model |
| Zendesk / Intercom | Ticket intake from multiple channels, SLA timers | Unified inbox pattern |
| Vanta / Drata | SOC 2 + HIPAA evidence automation | **Do not rebuild this — integrate it** |
| Retool / Appsmith | Internal tool builder over existing APIs | Consider as the fastest path to v1 |

**Critical build-vs-buy calls:**

1. **Compliance: integrate, don't rebuild.** Vanta and Drata connect read-only to AWS/GCP/GitHub/identity providers, auto-collect evidence, map it to controls across SOC 2, ISO 27001, HIPAA, and GDPR, and run continuous automated tests. Vanta is positioned for a first, fast SOC 2; Drata for scaling multi-framework programs. Platform license runs roughly $7K–$30K/year mid-market with audit fees on top — all-in commonly $30K–$120K for a first Type II. **Your Compliance Zone should be a read-only dashboard over one of their APIs plus your own issue-raising workflow, not a homegrown GRC system.** Drata's API is specifically the better one for pulling compliance data *into* external dashboards like yours.
2. **Shopify: never rebuild, always mirror.** Pull via Shopify Admin GraphQL API + webhooks into your own read-only cache. No writes to Shopify from this platform.
3. **Engineering: mirror GitHub, don't replace it.** Devs stay in GitHub/Linear. Your board reads issues/PRs/releases and adds the *prioritization* layer on top — which is the actual problem you're trying to solve.

**Your real, unsolved problem:** No off-the-shelf tool scores a firmware bug, an enterprise-blocking app feature, and a Shopify support fire on the *same* priority list. That cross-domain triage engine is the thing worth building. Everything else is plumbing.

---

## PART 2 — THE PROMPT

> Copy everything below this line.

---

### PROJECT: Safewave Command Center

Build a mobile-first internal operations platform for Safewave Technology. It is the single source of truth for everything Safewave: team communication, engineering priorities, customer support, enterprise CRM, and compliance. It reads from the tools we already use — it does not replace them.

#### 0. Company context

Safewave Technology makes the first portable vibration-based alert system for the Deaf and hard-of-hearing community. The Safewave band is a wristband that targets the ulnar and median nerves with customizable vibration strength, integrating with smart home security (Google Nest, Ring, ADT), baby monitors (Miku, Nanit, Owlet), alarms, timers, and texts. Mission: improve the safety, security, and quality of living for individuals who are overlooked and underserved in the Deaf (+) community.

**Products to manage in this platform:**
- Safewave Band (physical hardware, current + future revisions)
- Safewave firmware / FireWire
- Consumer mobile app (iOS + Android)
- Enterprise app
- Enterprise dashboard
- Safewave Aware (future product)

**Existing systems to connect:**
- Shopify (DTC storefront, order tracking, ParcelPanel, Judge.me reviews, UpPromote affiliates)
- Firebase (product backend — device telemetry, user accounts, app data)
- GitHub (multiple repos across band firmware, consumer app, enterprise app, dashboard)
- Email (support inbox)
- Compliance platform (Vanta or Drata — TBD)

#### 1. Non-negotiable design principles

1. **Mobile-first, not mobile-responsive.** Design every screen at 390px wide first, then scale up. Bottom tab navigation. Thumb-reachable primary actions. Everything must be doable one-handed on a phone.
2. **Read-heavy, write-light.** No changes to the actual products are made through this platform. It is an information and coordination layer. Writes are limited to: internal notes, tasks, tickets, CRM records, messages, and compliance findings.
3. **Three taps maximum** from app open to any piece of information.
4. **Fast.** Sub-second navigation. If a board is slow the whole thing fails, and that is exactly why we are leaving Monday.com.
5. **Obvious.** A new employee should understand it without training. It should feel stupid to use anything else.
6. **Accessibility is table stakes.** We build for the Deaf+ community — this tool must meet WCAG 2.2 AA. Full keyboard navigation, screen-reader labels, visible focus states, no information conveyed by color alone, captions on any video, and haptic/visual alternatives to audio alerts.

#### 2. Branding

Source visual identity from safewavetech.com.

- **Primary theme:** black (`#000000`) base, per the site's declared theme color. High-contrast dark UI with white type and a single accent color pulled from the live site's product imagery and CTA buttons.
- **Tone:** clean, safety-oriented, confident, human. Not playful. Not corporate-sterile.
- **Voice for empty states and system copy:** short, direct, plain English.
- Pull the Safewave wordmark and any brand assets from the site's CDN.
- Define the whole thing as design tokens (color, spacing, type scale, radius) in one file so it can be re-themed in one place.

#### 3. Access control

Three roles, enforced server-side on every query — not just hidden in the UI.

| Role | Access |
|---|---|
| **Admin** | Everything. User management, financials, compliance, all boards, audit log. |
| **Manager** | Team + engineering + customer + CRM. Configurable per-board access. Sees financial summaries, not raw payout data. Cannot manage users or compliance controls. |
| **Employee** | Assigned boards and tickets only. No financials, no compliance, no CRM unless explicitly granted. |

Requirements:
- Individual boards/sections can be locked to specific roles or named users.
- Task assignment works across roles; an admin can assign to anyone, a manager to their team.
- Every permission change and every sensitive-data view writes to an immutable audit log (this is a SOC 2 control — build it now, not later).
- SSO-ready. Enforce MFA for Admin and Manager.

#### 4. Modules

##### 4.1 Home / Pulse (landing screen)
A single scrollable mobile screen answering "what needs me right now":
- Top 3 priority items from the triage engine, cross-domain
- Unread messages count and @mentions
- Open urgent tickets and SLA breaches
- Today's revenue + orders (Shopify) — Admin/Manager only
- Compliance controls currently failing
- CRM follow-ups due today
Every card taps through to its module. Role-filtered.

##### 4.2 Team Communication
Teams/Slack-style, deliberately simple:
- Channels (public + private), DMs, group threads
- **Company-wide Updates feed** — pinned announcements with read receipts so leadership knows who saw what
- @mentions, reactions, file attachments, image previews
- Threaded replies (no infinite nesting — one level)
- Search across all messages
- Push notifications with granular per-channel mute
- Ability to convert any message into a task or a ticket in one tap, preserving a link back to the conversation

##### 4.3 Engineering & Development — *the priority engine (highest-value module)*
This solves our single biggest problem: **deciding what to build and fix next across firmware, apps, and dashboard.**

**Data:** Mirror GitHub issues, PRs, branches, and releases across all Safewave repos, read-only, via webhooks. Group by product: Band Hardware, FireWire/Firmware, Consumer App, Enterprise App, Enterprise Dashboard, Safewave Aware, Infrastructure.

**The triage engine — build this properly:**

Every item (bug or feature, from any source: GitHub, support ticket, enterprise customer request, internal idea) gets scored on a single unified scale so a firmware bug and an enterprise feature request can sit on the same ranked list.

Use a weighted RICE+ model with hardware/safety awareness:

- **Reach** — how many users affected (pull real numbers from Firebase: active devices, app installs, affected firmware versions)
- **Impact** — 0.25 / 0.5 / 1 / 2 / 3
- **Confidence** — 50% / 80% / 100%
- **Effort** — person-weeks, engineer-estimated
- **Safety multiplier** — ×3 if the issue could cause a missed emergency alert. This is a life-safety product; anything that breaks alerting outranks everything else. Automatically flag issues tagged with alert delivery, band connectivity, or battery failure.
- **Revenue multiplier** — ×2 if it blocks a signed or in-pipeline enterprise deal (auto-detected by linking the item to a CRM record)

Score = (Reach × Impact × Confidence ÷ Effort) × Safety × Revenue

**Requirements:**
- One ranked "What's Next" list across all products, visible on mobile
- Manual override with a **required written justification** — every override is logged and visible, so priority decisions are auditable and arguable
- Filter by product, by team, by source
- Sprint/cycle view showing committed vs. in-flight vs. shipped
- Release notes auto-drafted from merged PRs since last release
- Firmware version tracking: what's deployed, adoption rate from Firebase, known issues per version
- "Why is this #1?" — tapping any item shows its score breakdown in plain English

##### 4.4 Customer Management
**Shopify layer (read-only mirror — do not recreate Shopify):**
- Sync via Shopify Admin GraphQL API + webhooks: orders, fulfillment status, customers, products, refunds, reviews
- Executive finance view (Admin/Manager): revenue by day/week/month, AOV, units sold, refund rate, return reasons, top SKUs, affiliate performance
- Order lookup by name, email, or order number — instant, mobile-friendly

**Unified customer profile:** One record per human, merging Shopify orders + Firebase device/app data + email threads + tickets + reviews. On one screen: who they are, what they bought, what band and firmware they're on, when it last synced, every ticket they've filed, every email exchanged, current sentiment.

**Ticketing:**
- Intake from three channels into one queue: support email, Shopify (order issues, review complaints), in-app reports
- Auto-triage on ingest: severity, product area, suggested owner, duplicate detection
- SLA timers with escalation, urgent items surfaced to Pulse
- **Tickets promote directly into the engineering triage engine** with a permanent link — when 40 people report the same Bluetooth drop, that becomes one high-Reach engineering item automatically, and the reporters get notified when it ships
- Canned + AI-drafted responses, human approval required before send
- Note: existing public reviews cite Bluetooth connection drops, band sizing/bulk, and slow support response. Build the system so those three categories are trackable as trend lines, not just individual tickets.

##### 4.5 Enterprise CRM
Purpose-built for selling and servicing enterprise/organizational accounts (schools, care facilities, employers, agencies serving the Deaf+ community).

**Data model:** Organization → Contacts → Opportunities → Activities → Deployed Seats

**Per organization, show:**
- Company profile, industry, size, contract terms, renewal date
- All contacts with role and last-touched date
- **Seat count and activation rate** — how many bands/licenses they hold vs. how many are actually active (from Firebase). This is the churn early-warning signal.
- **Live health feed** — org's dashboard/app status, error rates, device sync failures, open tickets. Support should be able to look into an org's deployment to diagnose issues without calling engineering.
- Full activity timeline: calls, emails, demos, check-ins

**Sales workflow:**
- **Fast call logging** — one tap from the org record, voice-to-text notes on mobile, auto-timestamped. Must take under 15 seconds or nobody will use it.
- **Demo management** — schedule, run, track milestones through a demo lifecycle (scheduled → delivered → trial → pilot → contract), with per-milestone notes and next-step prompts
- **Automated check-in cadence** — configurable per account tier; system creates the follow-up task, nobody has to remember
- **Pipeline view** — deal stages, value, probability, expected close, mobile kanban
- **New business sourcing** — target list, outreach status, source attribution, conversion funnel by channel

**AI layer:**
- Generate email campaigns targeted by segment (org type, stage, activation rate, renewal window). Human review and approve before anything sends.
- Auto-generated account updates: "Riverside School District's activation dropped 12% this month and they have 2 open tickets — worth a check-in."
- Summarize a long account history into a pre-call brief
- Draft follow-ups from call notes
- **Every AI-generated outbound message requires human approval. No autonomous sending to customers.**

##### 4.6 Compliance Zone
Target: SOC 2 Type II, HIPAA, plus a framework for adding ISO 27001, GDPR, and future certifications.

**Architecture decision:** Integrate a compliance automation platform (Vanta or Drata) via API rather than building GRC from scratch. These platforms connect read-only to cloud, identity, code, and device tools, automatically pull evidence, map it to controls, and run continuous tests — and they cross-map controls so SOC 2 evidence is reused for HIPAA and ISO 27001 instead of collected twice. Drata's API is the better choice if the priority is pulling compliance data into an external dashboard like this one.

**What we build on top:**
- Live control status board: passing / failing / needs review, grouped by framework
- **Issue raising and remediation workflow** — anyone can flag a compliance concern; it routes to an owner with a due date and severity, and failing controls auto-create remediation tasks that appear in the engineering triage queue
- Evidence request tracker for audit periods
- Policy library with employee acknowledgment tracking
- Vendor/subprocessor register with risk rating and review dates
- **HIPAA specifics:** PHI data map (what health-adjacent data Safewave touches, where it lives, who can reach it), BAA tracker for every vendor touching PHI, access review workflow on a schedule, breach notification runbook
- **New-framework readiness:** given the cross-mapping, show "you are already X% ready for ISO 27001 based on existing controls" so adding certifications is a gap list, not a restart
- Audit log of every access to sensitive data in this platform itself

##### 4.7 Knowledge Base
The "one source of truth" backbone. Everything else links into it.
- Product documentation per product line, versioned
- Runbooks: support scripts, escalation paths, firmware release process, incident response
- Onboarding docs by role
- Decision log — why we chose what we chose, searchable, so context isn't lost
- Full-text search across knowledge base, messages, tickets, CRM notes, and engineering items from one search bar
- Any document can be linked from any ticket, task, or CRM record

#### 5. Integrations (build in this order)

1. **Shopify** — Admin GraphQL API + webhooks (orders/create, orders/updated, fulfillments, customers, refunds). Read-only. Cache locally; never block a page load on a Shopify call.
2. **GitHub** — GitHub App with read access to all Safewave repos. Webhooks for issues, PRs, releases. Read-only.
3. **Firebase** — read-only service account. Device registry, firmware versions, app sessions, error logs, org-level deployment data. Careful scoping: this is the most sensitive data in the system and touches the HIPAA question.
4. **Email** — support inbox ingestion (Gmail/Microsoft API), threading into tickets and customer profiles.
5. **Compliance platform** — Vanta or Drata API for control status.
6. **Calendar** — demo and check-in scheduling.

For every integration: read-only by default, credentials in a secrets manager (never in code), graceful degradation if an API is down, and a visible sync-status indicator so nobody trusts stale data.

#### 6. Technical requirements

- Web app, mobile-first, installable as a PWA with push notifications. Native wrappers later if needed.
- Real-time updates for messages, tickets, and priority changes.
- Offline read for recently viewed content — sales staff lose signal in buildings.
- All data encrypted at rest and in transit.
- Role-based authorization enforced at the API layer.
- Immutable audit logging from day one.
- Complete test coverage on the permission system specifically — a leak there is a compliance incident.

#### 7. Build order

- **Phase 1 (weeks 1–4):** Auth + roles + audit log, Pulse home, Team Communication, Knowledge Base
- **Phase 2 (weeks 5–8):** GitHub sync, engineering triage engine, unified priority list
- **Phase 3 (weeks 9–12):** Shopify sync, customer profiles, ticketing with email intake
- **Phase 4 (weeks 13–16):** Enterprise CRM, demo pipeline, AI email campaigns
- **Phase 5 (weeks 17–20):** Compliance Zone, Firebase org health feeds, polish

Ship Phase 1 to the team before starting Phase 2. If they don't open it daily, fix that before adding anything.

#### 8. Deliverables for this first pass

1. Recommended tech stack with reasoning, including an honest build-vs-buy call on whether a platform like Retool gets us to v1 faster than a custom build
2. Complete data model / schema for all modules
3. Permission matrix, role by module by action
4. Mobile wireframes for Pulse, Engineering Priority List, Customer Profile, and Org Record
5. The triage scoring algorithm implemented and testable, with sample data across all three product lines
6. A working Phase 1

Ask clarifying questions before writing code if anything above is ambiguous. Do not assume.

---

## PART 3 — Things to decide before you send this

- **Vanta vs. Drata.** Vanta if the goal is a fast first SOC 2; Drata if you're building a multi-framework program and want the better API for feeding this dashboard. Budget $30K–$120K all-in for a first Type II.
- **Do you actually touch PHI?** If Safewave Aware or any band telemetry captures health-adjacent data, HIPAA scope grows significantly. Get this scoped by counsel before you build the data model, not after.
- **Build vs. buy for v1.** An honest alternative: Linear (engineering) + Attio (CRM) + a compliance platform + a thin custom mobile dashboard that unifies them. Cheaper and faster. The argument for building is the cross-domain triage engine — which genuinely doesn't exist off the shelf. Ask the builder to price both paths.
- **Support response times.** Multiple public reviews cite unanswered support emails. Whatever you build, the ticketing SLA piece has immediate revenue impact — consider pulling it forward ahead of the CRM.
