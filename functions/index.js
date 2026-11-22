/**
 * Safewave Command Center — backend functions.
 *
 * Per-user email model: each teammate connects their OWN mailbox (address +
 * app password), stored privately in mail_credentials/{uid} (owner-only rules;
 * the backend reads it via the Admin SDK to send on their behalf).
 *
 *   sendUserEmail  — callable: send an email from the signed-in user's own
 *                    address and log it to the CRM account. Human-initiated.
 *   sourceProspects— callable: source new commercial contacts (audiology
 *                    clinics, senior-living, schools, VR agencies …) from the
 *                    Google Places business directory so the team can keep the
 *                    top of the funnel full. Needs PLACES_API_KEY (see below).
 *   runCampaigns   — daily: send the next due step of every active outreach
 *                    campaign from its owner's mailbox, personalised per
 *                    account + use case, and log it to the account.
 *   scanOverdue    — daily: flag stale accounts + SLA-breached tickets into
 *                    nudges/summary for the Pulse "needs attention" feed.
 *
 * PLACES_API_KEY: set a Google Places API key so the Prospector can source
 * contacts. Put it in functions/.env  (PLACES_API_KEY=xxxx) — Cloud Functions
 * v2 loads that automatically — or set it on the deployed service. Without it,
 * sourceProspects returns a clear "add your key" message instead of failing.
 */

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

const REGION = "us-central1";
const SLA_HOURS = { safety: 2, high: 8, medium: 24, low: 72 };
const STALE_DAYS = 30;
const CAMPAIGN_SENDS_PER_RUN = 60; // safety cap per daily run

/* ------------------------------------------------------------------ *
 * PHONE / DESKTOP PUSH (standard Web Push, VAPID)
 *
 * Every Command Center alert is a doc in `notifications`. Each one is also
 * pushed to the recipient's devices (to: uid) or everyone's (to: "all"), so it
 * arrives even when the app is closed. Devices register in `push_subs`
 * (owner-only). The VAPID key pair is generated here on first use and kept in
 * `server_keys/vapid`, which no client can read (firestore.rules denies it), so
 * there's no secret to set up. A notification is claimed (pushedAt) inside a
 * transaction before sending, so it is never pushed twice.
 * ------------------------------------------------------------------ */
let VAPID = null;
async function vapidKeys() {
  if (VAPID) return VAPID;
  const ref = db.collection("server_keys").doc("vapid");
  VAPID = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (s.exists && s.data().publicKey && s.data().privateKey) return s.data();
    const k = require("web-push").generateVAPIDKeys();
    const rec = { publicKey: k.publicKey, privateKey: k.privateKey, createdAt: new Date().toISOString() };
    t.set(ref, rec);
    return rec;
  });
  return VAPID;
}
async function deliverPush(ref) {
  let n = null;
  const claimed = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists || s.data().pushedAt) return false;
    n = s.data();
    t.update(ref, { pushedAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  }).catch((e) => { logger.warn("push claim failed", e && e.message); return false; });
  if (!claimed || !n || !n.to) return 0;
  const q = n.to === "all" ? db.collection("push_subs") : db.collection("push_subs").where("uid", "==", n.to);
  const subs = await q.get();
  if (subs.empty) return 0;
  const webpush = require("web-push");
  const k = await vapidKeys();
  webpush.setVapidDetails("https://safewave-command-center.web.app", k.publicKey, k.privateKey);
  const payload = JSON.stringify({ title: n.title || "Safewave", body: n.body || "", link: n.link || "", id: ref.id, safety: /safety/i.test(n.title || "") });
  let sent = 0;
  await Promise.all(subs.docs.map(async (d) => {
    const sub = d.data();
    if (n.to === "all" && n.by && sub.name && sub.name === n.by) return; // don't ping the person who caused it
    try {
      await webpush.sendNotification(sub.sub, payload, { TTL: 86400, urgency: "high", topic: undefined });
      sent++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) await d.ref.delete().catch(() => {}); // device unsubscribed / expired
      else logger.warn("push send failed", code || (e && e.message));
    }
  }));
  return sent;
}
// Add an alert and push it right away (server-side senders use this).
async function addNotification(data) {
  const ref = await db.collection("notifications").add(data);
  await deliverPush(ref).catch((e) => logger.warn("push failed", e && e.message));
  return ref;
}
// Safety net: push anything from the last hour that wasn't pushed yet
// (batched server alerts, or a client that went offline mid-send).
async function sweepPush() {
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - 3600e3);
  const qs = await db.collection("notifications").where("at", ">=", since).orderBy("at", "desc").limit(60).get();
  let n = 0;
  for (const d of qs.docs) { if (!d.data().pushedAt) n += await deliverPush(d.ref).catch(() => 0); }
  return n;
}
exports.pushConfig = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const k = await vapidKeys();
  return { publicKey: k.publicKey };
});
// The app calls this right after it writes an alert, so it reaches phones now.
exports.pushNow = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const id = String((request.data && request.data.id) || "").replace(/[^\w-]/g, "");
  if (!id) return { sent: 0 };
  return { sent: await deliverPush(db.collection("notifications").doc(id)) };
});
// "Send a test to my phone" from the Alerts sheet.
exports.pushTest = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const subs = await db.collection("push_subs").where("uid", "==", request.auth.uid).get();
  if (subs.empty) return { devices: 0, sent: 0 };
  const ref = await db.collection("notifications").add({ to: request.auth.uid, title: "🔔 Test alert", body: "Push works on this device.", link: "s-pulse", by: "Push test", at: admin.firestore.FieldValue.serverTimestamp() });
  return { devices: subs.size, sent: await deliverPush(ref) };
});

/* ------------------------------------------------------------------ *
 * SEND EMAIL from the signed-in user's own mailbox
 * ------------------------------------------------------------------ */
exports.sendUserEmail = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to send email.");
  const { to, subject, text, accountId, ticketId, auto } = request.data || {};
  if (!to || !text) throw new HttpsError("invalid-argument", "Recipient and message are required.");

  const creds = await getCreds(request.auth.uid);
  if (!creds) throw new HttpsError("failed-precondition", "Connect your email first (Account → Connect email).");
  const sender = senderFrom(creds, await getProfile(request.auth.uid));

  try {
    await deliver(creds, sender, { to, subject, text });
  } catch (e) {
    logger.error("sendUserEmail failed", e && e.message);
    throw new HttpsError("internal", "Send failed — check your email address and app password in Connect email.");
  }

  const line = `${auto ? "🤖 Auto-email" : "✉️ Email"} from ${creds.email} to ${to}: ${text.slice(0, 300)}`;
  if (accountId) await logNote(accountId, { user: creds.email, at: stamp(), text: line });
  if (ticketId) {
    await db.collection("tickets").doc(ticketId).set(
      { lastReplyAt: new Date().toISOString(), lastReplyBy: creds.email, status: "answered" },
      { merge: true }
    );
  }
  return { ok: true };
});

/* ------------------------------------------------------------------ *
 * ASK AGENT — the in-app assistant ("Ask Safewave")
 * Answers questions & writes reports over a company-data snapshot the
 * client assembles from what the signed-in user is already allowed to see.
 * The Anthropic key lives only here (server-side), never in the client.
 * ------------------------------------------------------------------ */
exports.askAgent = onCall({ region: REGION, timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to ask the assistant.");
  const key = process.env.ANTHROPIC_API_KEY || "";
  if (!key) throw new HttpsError("failed-precondition", "The AI model isn't connected yet.");

  const { question, context, history } = request.data || {};
  if (!question || !("" + question).trim()) throw new HttpsError("invalid-argument", "Ask a question.");

  const snapshot = typeof context === "string" ? context : JSON.stringify(context || {});
  const sys =
    "You are the Safewave Command Center assistant — an internal ops copilot for Safewave Technology, " +
    "maker of the Safewave Band (a vibration-alert wristband for people who are Deaf or hard of hearing).\n\n" +
    "Answer the user's question, or write the report they ask for, using ONLY the company data snapshot below. " +
    "It is a live view of what this user is allowed to see (CRM pipeline, support tickets, stock & orders, build tasks" +
    ", and — only if present — financials and the fundraise).\n\n" +
    "Rules:\n" +
    "- Be concise and specific; cite real numbers from the snapshot.\n" +
    "- Format with short Markdown (headings, bullets, bold figures). No preamble like 'Certainly'.\n" +
    "- If the answer isn't in the snapshot, say what's missing and where in the app to find it — do not invent data.\n" +
    "- Money is USD. 'Need follow-up' means an open account with no next step. Red is reserved for life-safety.\n" +
    "- Never mention API keys, secrets, environment variables, repositories, deploys or setup steps. If something isn't switched on, say it isn't available yet and that Brad can turn it on.\n" +
    "- For 'where is …' questions use ONLY this app map (phone: Menu in the bottom bar; desktop: left sidebar). If a page isn't listed, say you can't verify where it is.\n" +
    "  Home (Today, My Work) · Messages (bottom bar on phones, top bar on desktop) · Customers → CRM (Pipeline; Campaigns and Prospect open from the Pipeline action row), Support · " +
    "Fundraise (Overview, Meetings, Traction, Financials, Plan, Investors, Data room) · Operations → Stock & orders · Product → Build, Release QC, Field, Feedback · " +
    "Finance → Financials (Overview, 13-week cash, P&L, Projections, Budget, Payroll, Build spend, Access) · Resources → Guides, Knowledge (this assistant) · " +
    "Settings → Users, Compliance, Vault. Some pages only show for people with access.\n\n" +
    "=== COMPANY DATA SNAPSHOT ===\n" + snapshot.slice(0, 90000);

  const msgs = [];
  (Array.isArray(history) ? history.slice(-8) : []).forEach((m) => {
    if (m && (m.role === "user" || m.role === "assistant") && m.content) {
      msgs.push({ role: m.role, content: ("" + m.content).slice(0, 4000) });
    }
  });
  msgs.push({ role: "user", content: ("" + question).slice(0, 4000) });

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        system: sys,
        messages: msgs,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      logger.error("askAgent Anthropic error", resp.status, body.slice(0, 500));
      throw new HttpsError("internal", "The assistant hit an error (" + resp.status + "). Try again in a moment.");
    }
    const data = await resp.json();
    const answer = (data && Array.isArray(data.content) ? data.content : [])
      .filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();
    return { answer: answer || "I couldn't find an answer in the current data." };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error("askAgent failed", e && e.message);
    throw new HttpsError("internal", "The assistant is unavailable right now.");
  }
});

/* ------------------------------------------------------------------ *
 * DRAFT FIRMWARE NOTES — auto-populate a firmware release's notes from
 * the firmware repo's commits since the last release.
 *
 * Reads commits from the firmware GitHub repo (FW_REPO_TOKEN, read-only),
 * cleans the subjects, and — if ANTHROPIC_API_KEY is present — summarizes
 * them into short release notes; otherwise returns the cleaned bullet list.
 * Returns the repo HEAD sha so the client can store it on the release and
 * diff from it next time (compare API). Never writes to GitHub.
 * ------------------------------------------------------------------ */
exports.draftFirmwareNotes = onCall({ region: REGION, timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to draft notes.");
  const ghToken = process.env.FW_REPO_TOKEN || "";
  if (!ghToken) throw new HttpsError("failed-precondition",
    "Connect GitHub first — add an FW_REPO_TOKEN repo secret (a token with read access to the firmware repo) and redeploy.");

  const { version, sinceSha } = request.data || {};
  const repo = (process.env.FW_REPO || "bherald42/safewave-band-firmware").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  const branch = process.env.FW_BRANCH || "main";
  const ghHeaders = {
    "authorization": "Bearer " + ghToken,
    "accept": "application/vnd.github+json",
    "user-agent": "safewave-command-center",
    "x-github-api-version": "2022-11-28",
  };

  // 1) Gather commits. With a known baseline sha, use the compare API (only the
  //    new commits); otherwise fall back to the most recent commits on branch.
  let commits = [];
  let headSha = null;
  let range = "";
  try {
    if (sinceSha) {
      const cmp = await fetch(
        `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(sinceSha)}...${encodeURIComponent(branch)}`,
        { headers: ghHeaders });
      if (cmp.ok) {
        const d = await cmp.json();
        commits = (d.commits || []).map((c) => (c.commit && c.commit.message) || "");
        headSha = (d.commits && d.commits.length) ? d.commits[d.commits.length - 1].sha : sinceSha;
        range = sinceSha.slice(0, 7) + ".." + branch;
      } else if (cmp.status !== 404 && cmp.status !== 422) {
        const t = await cmp.text();
        logger.error("draftFirmwareNotes github compare", cmp.status, t.slice(0, 300));
        throw new HttpsError("internal",
          "GitHub returned " + cmp.status + " — check the token has read access to " + repo + ".");
      }
      // 404/422 = baseline sha not on this repo/branch anymore → fall through.
    }
    if (!headSha) {
      const lst = await fetch(
        `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=30`,
        { headers: ghHeaders });
      if (!lst.ok) {
        const t = await lst.text();
        logger.error("draftFirmwareNotes github commits", lst.status, t.slice(0, 300));
        throw new HttpsError("internal",
          "GitHub returned " + lst.status + " — check the FW_REPO_TOKEN and that it can read " + repo + ".");
      }
      const arr = await lst.json();
      commits = (Array.isArray(arr) ? arr : []).map((c) => (c.commit && c.commit.message) || "");
      headSha = (Array.isArray(arr) && arr.length) ? arr[0].sha : null;
      range = "latest " + commits.length + " commits";
    }
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error("draftFirmwareNotes github fetch failed", e && e.message);
    throw new HttpsError("internal", "Couldn't reach GitHub. Try again in a moment.");
  }

  // 2) Clean commit subjects: first line only, drop merges + exact dupes.
  const seen = new Set();
  const clean = [];
  commits.forEach((m) => {
    const subj = ("" + m).split("\n")[0].trim();
    if (!subj) return;
    if (/^merge (branch|pull request|remote-tracking)/i.test(subj)) return;
    const k = subj.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    clean.push(subj);
  });

  if (!clean.length) {
    return { notes: "", headSha, commitCount: 0, range, ai: false, message: "No new commits since the last release." };
  }

  const listText = clean.slice(0, 80).map((s) => "- " + s).join("\n");

  // 3) Summarize into release notes if the assistant is connected; else the list.
  const aiKey = process.env.ANTHROPIC_API_KEY || "";
  if (!aiKey) return { notes: listText, headSha, commitCount: clean.length, range, ai: false };

  try {
    const sys =
      "You write concise, factual firmware release notes for the Safewave Band — a vibration-alert wristband " +
      "for people who are Deaf or hard of hearing. You are given git commit subjects since the last release. " +
      "Produce short user-facing notes as Markdown bullets, grouped under **Fixes**, **Improvements**, and **New** " +
      "(include a group only if it has items). Merge related commits, drop internal noise (version bumps, formatting, " +
      "CI, refactors with no user effect). No preamble, no marketing language. Red is reserved for life-safety — never " +
      "imply severity with color.";
    const usr = "Firmware version: " + (version || "(unspecified)") + "\nCommit subjects since last release:\n" + listText;
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 900, system: sys, messages: [{ role: "user", content: usr }] }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      logger.error("draftFirmwareNotes anthropic", resp.status, t.slice(0, 300));
      return { notes: listText, headSha, commitCount: clean.length, range, ai: false };
    }
    const data = await resp.json();
    const notes = (data && Array.isArray(data.content) ? data.content : [])
      .filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();
    return { notes: notes || listText, headSha, commitCount: clean.length, range, ai: !!notes };
  } catch (e) {
    logger.error("draftFirmwareNotes summarize failed", e && e.message);
    return { notes: listText, headSha, commitCount: clean.length, range, ai: false };
  }
});

/* ------------------------------------------------------------------ *
 * SOURCE PROSPECTS — Google Places business directory
 * ------------------------------------------------------------------ */
exports.sourceProspects = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to source prospects.");
  const { query, location } = request.data || {};
  if (!query) throw new HttpsError("invalid-argument", "Give the prospector something to search for.");

  const key = process.env.PLACES_API_KEY || "";
  if (!key) {
    throw new HttpsError(
      "failed-precondition",
      "The prospector needs a Google Places API key. Add PLACES_API_KEY to functions/.env (or the deployed service) and redeploy — see BACKEND_SETUP.md."
    );
  }

  const textQuery = [query, location].filter(Boolean).join(" in ");
  let j;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.primaryTypeDisplayName",
      },
      body: JSON.stringify({ textQuery, maxResultCount: 20 }),
    });
    j = await res.json();
    if (!res.ok) {
      const msg = (j && j.error && j.error.message) || "Places API error";
      logger.error("Places API error", msg);
      throw new HttpsError("internal", "Prospect search failed: " + msg);
    }
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error("sourceProspects fetch failed", e && e.message);
    throw new HttpsError("internal", "Could not reach the business directory — try again.");
  }

  const results = (j.places || []).map((p) => ({
    name: (p.displayName && p.displayName.text) || "",
    address: p.formattedAddress || "",
    phone: p.nationalPhoneNumber || "",
    website: p.websiteUri || "",
    category: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || "",
  })).filter((r) => r.name);

  return { results };
});

/* ------------------------------------------------------------------ *
 * SHOPIFY WEBHOOK — orders, fulfilment/tracking, and returns
 * ------------------------------------------------------------------ *
 * Point these Shopify webhook topics at this function's URL (same URL for all):
 *   orders/create          → new order → orders/{id} + "new order" alert to all
 *   fulfillments/create     → tracking number synced back onto the order + band
 *   fulfillments/update     → tracking updates
 *   returns/request         → a return opens in the Returns queue + alert to all
 *   returns/approve|close|cancel|decline → return status kept in sync
 * Set SHOPIFY_WEBHOOK_SECRET to the webhook signing secret so we can verify
 * each request is really from Shopify. (Function name kept as shopifyOrderWebhook
 * so an already-configured URL keeps working.)
 */
exports.shopifyOrderWebhook = onRequest({ region: REGION }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).send("POST only"); return; }
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || "";
  if (!secret) { res.status(503).send("Webhook secret not configured"); return; }

  const hmac = req.get("X-Shopify-Hmac-Sha256") || "";
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  let ok = false;
  try {
    const digest = crypto.createHmac("sha256", secret).update(raw).digest("base64");
    const a = Buffer.from(digest), b = Buffer.from(hmac);
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { ok = false; }
  if (!ok) { res.status(401).send("Invalid signature"); return; }

  const topic = req.get("X-Shopify-Topic") || "orders/create";
  const body = req.body || {};
  try {
    if (topic.indexOf("returns/") === 0) await handleShopifyReturn(topic, body);
    else if (topic.indexOf("fulfillments/") === 0 || topic === "orders/fulfilled") await handleShopifyFulfillment(body);
    else await handleShopifyOrder(body);
  } catch (e) {
    logger.error("shopifyWebhook " + topic + " failed", e && e.message);
    res.status(500).send("error"); return;
  }
  res.status(200).send("ok");
});

function shopShortDate(iso) { try { return new Date(iso || Date.now()).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch (e) { return ""; } }

// Shared Shopify order → orders/{id} mapping, used by BOTH the real-time
// webhook and the pull-based sync so the two paths write identical docs.
function mapShopifyOrder(o) {
  const cust = o.customer || {}, ship = o.shipping_address || {};
  const name = [cust.first_name, cust.last_name].filter(Boolean).join(" ") || ship.name || o.email || "Customer";
  const n = o.name || ("#" + (o.order_number || o.id || ""));
  const id = String(o.id || n).replace(/[^\w-]/g, "") || String(Date.now());
  const f0 = (o.fulfillments && o.fulfillments[0]) || null;
  const rec = {
    n: n, name: name, email: o.email || "", total: Number(o.total_price || 0),
    date: shopShortDate(o.created_at),
    ful: String(o.fulfillment_status || "").toLowerCase() === "fulfilled" ? "FULFILLED" : "UNFULFILLED",
    source: "shopify",
    at: o.created_at ? new Date(o.created_at).toISOString() : new Date().toISOString(),
  };
  if (f0) {
    rec.tracking = f0.tracking_number || (f0.tracking_numbers && f0.tracking_numbers[0]) || "";
    rec.trackingUrl = f0.tracking_url || (f0.tracking_urls && f0.tracking_urls[0]) || "";
    rec.carrier = f0.tracking_company || "";
  }
  return { id: id, rec: rec };
}

async function handleShopifyOrder(o) {
  const mapped = mapShopifyOrder(o);
  const id = mapped.id, rec = mapped.rec;
  rec.at = new Date().toISOString(); // real-time arrival stamp for webhook orders
  await db.collection("orders").doc(id).set(rec, { merge: true });
  await addNotification({
    to: "all", title: "New order " + rec.n, body: rec.name + " · $" + rec.total,
    link: "s-stock", by: "Shopify", at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function handleShopifyFulfillment(f) {
  const orderId = String(f.order_id || f.id || "").replace(/[^\w-]/g, "");
  if (!orderId) return;
  const first = (f.fulfillments && f.fulfillments[0]) || f;
  const track = first.tracking_number || (first.tracking_numbers && first.tracking_numbers[0]) || "";
  const trackUrl = first.tracking_url || (first.tracking_urls && first.tracking_urls[0]) || "";
  const carrier = first.tracking_company || "";
  await db.collection("orders").doc(orderId).set({ ful: "FULFILLED", tracking: track, trackingUrl: trackUrl, carrier: carrier }, { merge: true });
  // mirror the tracking number onto our in-app fulfilment + band records
  const ord = await db.collection("orders").doc(orderId).get();
  const n = ord.exists ? ord.data().n : null;
  if (n && track) {
    const fs = await db.collection("fulfillments").doc(n).get();
    if (fs.exists) {
      await fs.ref.set({ tracking: track }, { merge: true });
      const serial = fs.data().serial;
      if (serial) await db.collection("bands").doc(serial).set({ tracking: track }, { merge: true });
    }
  }
}

async function handleShopifyReturn(topic, body) {
  const r = body.return || body;
  const orderId = String(r.order_id || "").replace(/[^\w-]/g, "");
  const rmaId = "RMA-SH-" + String(r.id || Date.now()).slice(-8);
  const status = topic === "returns/approve" ? "label-issued"
    : topic === "returns/close" ? "restocked"
    : (topic === "returns/cancel" || topic === "returns/decline") ? "cancelled"
    : "requested";
  let n = null, serial = "", size = "", customer = "";
  if (orderId) {
    const ord = await db.collection("orders").doc(orderId).get();
    if (ord.exists) {
      n = ord.data().n; customer = ord.data().name || "";
      if (n) { const fs = await db.collection("fulfillments").doc(n).get(); if (fs.exists) { serial = fs.data().serial || ""; size = fs.data().size || ""; } }
    }
  }
  const existing = await db.collection("returns").doc(rmaId).get();
  const rec = { id: rmaId, order: n || ("#" + (r.order_id || "")), serial: serial, size: size, customer: customer, status: status, source: "shopify", at: (existing.exists && existing.data().at) || new Date().toISOString(), updatedAt: new Date().toISOString() };
  await db.collection("returns").doc(rmaId).set(rec, { merge: true });
  if (!existing.exists && status === "requested") {
    await addNotification({
      to: "all", title: "Return requested · " + rec.order, body: (customer || "") + (serial ? " · band " + serial : ""),
      link: "s-stock", by: "Shopify", at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

/* ------------------------------------------------------------------ *
 * SHOPIFY PULL SYNC  →  keep orders/ in step with Shopify without a webhook
 *
 * Webhooks only push new events and can be dropped, so the Command Center
 * can silently fall behind. This reads the Shopify Admin API directly to
 * backfill order history and self-heal past any missed delivery. Needs two
 * secrets (injected into functions/.env at deploy, never committed):
 *   SHOPIFY_STORE_DOMAIN   e.g. safewavetech.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN    an Admin API access token with read_orders, OR
 *   SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET  from a Dev Dashboard app
 * Without them the callable returns a clear "connect Shopify" message and
 * the scheduled job no-ops, so nothing breaks before they're set.
 * ------------------------------------------------------------------ */
const SHOPIFY_API_VERSION = "2026-10";

// Two ways to authenticate, whichever the secrets provide:
//  - SHOPIFY_ADMIN_TOKEN: a non-expiring token from an older admin-created
//    custom app ("shpat_…").
//  - SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET: an app made in Shopify's Dev
//    Dashboard (the only kind Shopify lets you create now). We trade them for
//    a 24-hour token with the client-credentials grant and cache it.
function shopifyCreds() {
  const domain = (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const token = process.env.SHOPIFY_ADMIN_TOKEN || "";
  const clientId = process.env.SHOPIFY_CLIENT_ID || "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";
  return { domain: domain, token: token, clientId: clientId, clientSecret: clientSecret,
    ok: !!(domain && (token || (clientId && clientSecret))) };
}

let shopifyTokenCache = { token: "", exp: 0 };
async function shopifyToken() {
  const c = shopifyCreds();
  if (!c.ok) throw new Error("Shopify Admin API not configured");
  if (c.token) return c.token;
  if (shopifyTokenCache.token && Date.now() < shopifyTokenCache.exp) return shopifyTokenCache.token;
  const r = await fetch("https://" + c.domain + "/admin/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret }).toString(),
  });
  if (!r.ok) throw new Error("Shopify token exchange " + r.status + " — check the app is installed on the store");
  const d = await r.json();
  shopifyTokenCache = { token: d.access_token, exp: Date.now() + Math.max(60, (Number(d.expires_in) || 86399) - 300) * 1000 };
  return shopifyTokenCache.token;
}

// Fetch one page of orders; returns { orders, next } where next is the
// cursor URL from Shopify's Link header (null when there are no more pages).
async function fetchShopifyOrdersPage(pageUrl) {
  const c = shopifyCreds();
  const token = await shopifyToken();
  const url = pageUrl || ("https://" + c.domain + "/admin/api/" + SHOPIFY_API_VERSION +
    "/orders.json?status=any&limit=250");
  const r = await fetch(url, { headers: { "X-Shopify-Access-Token": token, "content-type": "application/json" } });
  if (!r.ok) throw new Error("Shopify API " + r.status + " " + r.statusText);
  const data = await r.json();
  let next = null;
  const link = r.headers.get("link") || "";
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  if (m) next = m[1];
  return { orders: data.orders || [], next: next };
}

// Pull orders and upsert into orders/{id}. backfill:true walks every page
// (history); backfill:false pulls just the most-recent page (cheap reconcile).
async function pullShopifyOrders(opts) {
  opts = opts || {};
  const maxPages = opts.backfill ? 40 : 1; // 40 * 250 = 10k-order ceiling
  let page = null, pages = 0;
  const items = [];
  do {
    const res = await fetchShopifyOrdersPage(page);
    res.orders.forEach((o) => items.push(mapShopifyOrder(o)));
    page = res.next;
    pages++;
  } while (page && pages < maxPages);
  // Commit in batches (Firestore caps a batch at 500 writes).
  for (let i = 0; i < items.length; i += 400) {
    const batch = db.batch();
    items.slice(i, i + 400).forEach((it) => batch.set(db.collection("orders").doc(it.id), it.rec, { merge: true }));
    await batch.commit();
  }
  await db.collection("settings").doc("shopify").set({
    lastSyncAt: new Date().toISOString(), lastSyncCount: items.length, lastSyncBy: opts.by || "system",
  }, { merge: true });
  return items.length;
}

// Callable: "Sync now" / "Backfill history" from the Stock screen.
exports.syncShopifyOrders = onCall({ region: REGION, timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to sync orders.");
  if (!shopifyCreds().ok) {
    throw new HttpsError("failed-precondition",
      "Shopify isn't connected yet — add the SHOPIFY_STORE_DOMAIN and Shopify app secrets to enable order sync.");
  }
  try {
    const by = (request.auth.token && request.auth.token.email) || request.auth.uid;
    const synced = await pullShopifyOrders({ backfill: !!(request.data && request.data.backfill), by: by });
    try { await pullShopifyStock(); } catch (e) { logger.warn("Shopify stock mirror skipped", e && e.message); }
    const s = await db.collection("settings").doc("shopify").get();
    return { synced: synced, lastSyncAt: (s.exists && s.data().lastSyncAt) || null };
  } catch (e) {
    logger.error("syncShopifyOrders failed", e && e.message);
    throw new HttpsError("internal", "Sync failed — " + ((e && e.message) || "check the Shopify token"));
  }
});

// Scheduled reconcile: pulls the most-recent page every 15 minutes so new
// orders and fulfilment/tracking changes land even if a webhook was missed.
exports.scheduledShopifySync = onSchedule({ schedule: "every 15 minutes", region: REGION }, async () => {
  await sweepPush().catch((e) => logger.warn("push sweep failed", e && e.message)); // alerts that missed their instant push
  if (!shopifyCreds().ok) { logger.info("scheduledShopifySync skipped — Shopify not configured"); return; }
  try {
    const n = await pullShopifyOrders({ backfill: false, by: "schedule" });
    logger.info("scheduledShopifySync upserted " + n + " orders");
  } catch (e) {
    logger.error("scheduledShopifySync failed", e && e.message);
  }
  // Stock mirror is separate so a token without inventory scopes can't
  // break order sync.
  try { await pullShopifyStock(); } catch (e) { logger.warn("Shopify stock mirror skipped", e && e.message); }
});

/* ------------------------------------------------------------------ *
 * SHOPIFY WRITE-BACK — the Command Center is where bands actually get
 * packed, so it tells Shopify when an order ships (tracking number +
 * customer email from Shopify) and mirrors what Shopify thinks is in
 * stock at the shipping location, so an oversold size surfaces on Today.
 * Uses the GraphQL Admin API. App scopes needed on top of read_orders:
 *   read/write_merchant_managed_fulfillment_orders  (mark shipped)
 *   read_products, read_inventory, read_locations    (stock mirror)
 * Optional SHOPIFY_LOCATION_ID pins the shipping location; otherwise the
 * location named like "Office"/"Covington" (or the first active) is used.
 * ------------------------------------------------------------------ */
const SHOPIFY_GQL_VERSION = "2026-10";
async function shopifyGql(query, variables) {
  const c = shopifyCreds();
  const token = await shopifyToken();
  const r = await fetch("https://" + c.domain + "/admin/api/" + SHOPIFY_GQL_VERSION + "/graphql.json", {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "content-type": "application/json" },
    body: JSON.stringify({ query: query, variables: variables || {} }),
  });
  const text = await r.text();
  let d = {};
  try { d = text ? JSON.parse(text) : {}; } catch (e) { d = {}; }
  if (!r.ok || (d.errors && d.errors.length)) {
    const msg = d.errors ? (typeof d.errors === "string" ? d.errors : (d.errors[0] && d.errors[0].message) || JSON.stringify(d.errors)) : r.statusText;
    const e = new Error("Shopify " + r.status + " " + msg);
    e.status = r.status;
    if (/access denied|scope/i.test(msg)) e.status = 403;
    throw e;
  }
  return d.data || {};
}
function userErr(payload) {
  const ue = payload && payload.userErrors;
  return ue && ue.length ? ue.map((u) => u.message).join("; ") : "";
}

// USPS / DHL are what Safewave ships with; anything else is left for
// Shopify to auto-detect from the number.
function guessCarrier(num) {
  const n = String(num || "").replace(/\s+/g, "").toUpperCase();
  if (!n) return "";
  if (/^\d{10}$/.test(n) || /^JD\d{18}$/.test(n)) return "DHL Express";
  if (/^(94|93|92|95|91)\d{18,20}$/.test(n) || /^\d{20,22}$/.test(n) || /^[A-Z]{2}\d{9}US$/.test(n)) return "USPS";
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return "UPS";
  return "";
}

async function shopifyShipLocationId() {
  if (process.env.SHOPIFY_LOCATION_ID) {
    const v = String(process.env.SHOPIFY_LOCATION_ID);
    return v.indexOf("gid://") === 0 ? v : "gid://shopify/Location/" + v;
  }
  const d = await shopifyGql("{ locations(first: 25) { nodes { id name isActive } } }");
  const locs = ((d.locations && d.locations.nodes) || []).filter((l) => l.isActive !== false);
  const pick = locs.find((l) => /office|covington/i.test(l.name || "")) || locs[0];
  return pick ? pick.id : null;
}

const ORDER_FULFIL_FIELDS = "id name displayFulfillmentStatus " +
  "fulfillmentOrders(first: 10) { nodes { id status supportedActions { action } } } " +
  "fulfillments(first: 10) { id status }";

// Find the Shopify order for a Command Center order. orders/{id} uses the
// numeric Shopify id as its doc id; otherwise search by order name.
async function findShopifyOrder(orderName, orderId) {
  let id = orderId && /^\d+$/.test(String(orderId)) ? String(orderId) : null;
  if (!id && orderName) {
    const q = await db.collection("orders").where("n", "==", orderName).limit(1).get();
    if (!q.empty && /^\d+$/.test(q.docs[0].id)) id = q.docs[0].id;
  }
  if (id) {
    const d = await shopifyGql("query($id: ID!) { order(id: $id) { " + ORDER_FULFIL_FIELDS + " } }", { id: "gid://shopify/Order/" + id });
    if (d.order) return d.order;
  }
  const name = String(orderName || "").replace(/"/g, "");
  if (!name) return null;
  const d = await shopifyGql("query($q: String!) { orders(first: 1, query: $q) { nodes { " + ORDER_FULFIL_FIELDS + " } } }", { q: "name:" + name });
  return (d.orders && d.orders.nodes && d.orders.nodes[0]) || null;
}

exports.shopifyFulfillOrder = onCall({ region: REGION, timeoutSeconds: 60 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to fulfil orders.");
  if (!shopifyCreds().ok) {
    throw new HttpsError("failed-precondition", "Shopify isn't connected yet — add the Shopify app secrets.");
  }
  const data = request.data || {};
  const orderName = String(data.orderName || "").slice(0, 40);
  const tracking = String(data.tracking || "").trim().slice(0, 60);
  const carrier = String(data.carrier || "").trim().slice(0, 40) || guessCarrier(tracking);
  const by = (request.auth.token && request.auth.token.email) || request.auth.uid;
  if (!orderName || /^DEMO-/i.test(orderName)) throw new HttpsError("invalid-argument", "Not a Shopify order.");
  const fdoc = db.collection("fulfillments").doc(orderName.replace(/\//g, "-"));
  try {
    const order = await findShopifyOrder(orderName, data.orderId);
    if (!order) throw new HttpsError("not-found", "Couldn't find " + orderName + " in Shopify.");
    const open = ((order.fulfillmentOrders && order.fulfillmentOrders.nodes) || []).filter((f) =>
      ["OPEN", "IN_PROGRESS", "SCHEDULED"].indexOf(f.status) >= 0 &&
      (f.supportedActions || []).some((a) => a.action === "CREATE_FULFILLMENT"));
    const trackingInfo = tracking ? { number: tracking } : null;
    if (trackingInfo && carrier) trackingInfo.company = carrier;
    let result = "created", fulfillmentId = null;
    if (open.length) {
      const input = { lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })), notifyCustomer: true };
      if (trackingInfo) input.trackingInfo = trackingInfo;
      const d = await shopifyGql("mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }", { f: input });
      const err = userErr(d.fulfillmentCreate);
      if (err) throw new Error(err);
      fulfillmentId = d.fulfillmentCreate.fulfillment && d.fulfillmentCreate.fulfillment.id;
    } else {
      // Already fulfilled in Shopify (e.g. marked by hand) — just attach tracking.
      const last = (order.fulfillments || []).filter((f) => f.status !== "CANCELLED").pop();
      if (last && trackingInfo) {
        const d = await shopifyGql("mutation($id: ID!, $t: FulfillmentTrackingInput!) { fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $t, notifyCustomer: true) { fulfillment { id } userErrors { field message } } }", { id: last.id, t: trackingInfo });
        const err = userErr(d.fulfillmentTrackingInfoUpdate);
        if (err) throw new Error(err);
        result = "tracking_updated";
      } else {
        result = "already_fulfilled";
      }
      fulfillmentId = last ? last.id : null;
    }
    const at = new Date().toISOString();
    const numericId = String(order.id).split("/").pop();
    const ord = { ful: "FULFILLED" };
    if (tracking) { ord.tracking = tracking; ord.carrier = carrier || ""; }
    await db.collection("orders").doc(numericId).set(ord, { merge: true });
    await fdoc.set({ shopify: { status: result, at: at, by: by, fulfillmentId: fulfillmentId || null, carrier: carrier || "" } }, { merge: true });
    return { status: result, carrier: carrier || "" };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error("shopifyFulfillOrder failed", orderName, e && e.message);
    const scope = e && (e.status === 401 || e.status === 403);
    await fdoc.set({ shopify: { status: "failed", at: new Date().toISOString(), by: by, error: String((e && e.message) || "").slice(0, 200) } }, { merge: true }).catch(() => {});
    throw new HttpsError(scope ? "permission-denied" : "internal",
      scope ? "The Shopify app can't mark orders shipped yet — add the fulfillment scopes." : "Shopify said: " + ((e && e.message) || "unknown error"));
  }
});

// Mirror Shopify's "available" count per band size at the shipping
// location into settings/shopify.stock. Notifies everyone the moment a
// size goes oversold (negative), not on every 15-minute pass.
async function pullShopifyStock() {
  const loc = await shopifyShipLocationId();
  if (!loc) return null;
  const d = await shopifyGql("query($id: ID!) { location(id: $id) { name inventoryLevels(first: 250) { nodes { " +
    "quantities(names: [\"available\"]) { name quantity } " +
    "item { variant { title selectedOptions { name value } product { title status } } } } } } }", { id: loc });
  const levels = (d.location && d.location.inventoryLevels && d.location.inventoryLevels.nodes) || [];
  const stock = { S: 0, M: 0, L: 0 };
  let matched = 0;
  levels.forEach((lv) => {
    const v = lv.item && lv.item.variant;
    if (!v || !v.product || !/band/i.test(v.product.title || "") || v.product.status === "ARCHIVED") return;
    const label = [v.title].concat((v.selectedOptions || []).map((o) => o.value)).join(" ");
    const m = label.match(/\b(small|medium|large|s|m|l)\b/i);
    if (!m) return;
    const q = (lv.quantities || []).find((x) => x.name === "available");
    stock[m[1][0].toUpperCase()] += Number((q && q.quantity) || 0);
    matched++;
  });
  if (!matched) return null;
  const ref = db.collection("settings").doc("shopify");
  const prev = (await ref.get()).data() || {};
  const prevStock = prev.stock || {};
  const newlyOver = Object.keys(stock).filter((z) => stock[z] < 0 && !(Number(prevStock[z]) < 0));
  await ref.set({ stock: stock, stockAt: new Date().toISOString(), stockLocation: (d.location && d.location.name) || "" }, { merge: true });
  if (newlyOver.length) {
    const names = { S: "Small", M: "Medium", L: "Large" };
    await addNotification({
      to: "all", title: "Shopify oversold: " + newlyOver.map((z) => names[z] + " (" + stock[z] + ")").join(", "),
      body: "Customers bought more than the store shows in stock. Restock in Shopify or pause the size.",
      link: "s-stock", by: "Shopify", at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return stock;
}

/* ------------------------------------------------------------------ *
 * COMPLIANCE STANDARD-WATCH — monthly (and on-demand) web check for
 * changes to the standards Safewave certifies against: SOC 2 (the AICPA
 * Trust Services Criteria) and HIPAA (HHS Security & Privacy Rules,
 * 45 CFR Part 164). Uses the Anthropic Messages API with the web-search
 * tool, appends the result to compliance/updates, and notifies admins
 * when a standard has actually changed. No Drata / third-party GRC vendor.
 * ------------------------------------------------------------------ */
const COMPLIANCE_LOG_CAP = 24;

// Pull the first balanced JSON object out of a model reply (tolerates
// ```json fences and any prose the model adds around it).
function firstJsonObject(s) {
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(body.slice(start, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}

function normStd(x) {
  x = x && typeof x === "object" ? x : {};
  return {
    changed: !!x.changed,
    summary: ("" + (x.summary || "")).slice(0, 600),
    asOf: ("" + (x.asOf || "")).slice(0, 80),
    sources: (Array.isArray(x.sources) ? x.sources : []).filter((u) => typeof u === "string").slice(0, 5),
  };
}

async function runComplianceCheck(by) {
  const key = process.env.ANTHROPIC_API_KEY || "";
  if (!key) { const err = new Error("no-key"); err.code = "no-key"; throw err; }
  const today = new Date().toISOString().slice(0, 10);
  const sys =
    "You are a GRC compliance analyst for Safewave Technology (maker of the Safewave Band, a life-safety wearable " +
    "for people who are Deaf or hard of hearing). Your job: determine whether the two standards this company is " +
    "certifying against have had any published updates, revisions, errata, or notable regulatory changes recently.\n" +
    "  1. SOC 2 — the AICPA Trust Services Criteria (TSC).\n" +
    "  2. HIPAA — the HHS Security Rule and Privacy Rule, 45 CFR Part 164 (including any NPRM / final rules).\n" +
    "Use web search against authoritative sources (aicpa-cima.com, hhs.gov, federalregister.gov). Today is " + today + ".\n" +
    "Respond with ONLY a JSON object, no prose and no markdown fences, of exactly this shape:\n" +
    '{"soc2":{"changed":boolean,"summary":"1-2 sentences","asOf":"date or revision label","sources":["url"]},' +
    '"hipaa":{"changed":boolean,"summary":"1-2 sentences","asOf":"date or revision label","sources":["url"]},' +
    '"headline":"one short line summarising both"}\n' +
    "Set changed:true ONLY for a genuine change to the standard itself (not vendor blog chatter). If nothing has " +
    "changed, changed:false and the summary should state the current in-force revision and that no change was found.";
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      system: sys,
      messages: [{ role: "user", content: "Run the standards check for SOC 2 and HIPAA now. Search the web for the latest status of each, then return the JSON." }],
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
    }),
  });
  if (!resp.ok) {
    const b = await resp.text();
    logger.error("compliance check Anthropic error", resp.status, b.slice(0, 400));
    const err = new Error("api-" + resp.status); err.code = "api"; throw err;
  }
  const data = await resp.json();
  const text = (data && Array.isArray(data.content) ? data.content : [])
    .filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();
  const parsed = firstJsonObject(text) || {};
  const rec = {
    at: new Date().toISOString(),
    by: by || "system",
    model: "claude-sonnet-5",
    soc2: normStd(parsed.soc2),
    hipaa: normStd(parsed.hipaa),
    headline: ("" + (parsed.headline || "Standards check completed.")).slice(0, 300),
  };

  const ref = db.collection("compliance").doc("updates");
  const snap = await ref.get();
  const log = (snap.exists && Array.isArray(snap.data().log)) ? snap.data().log : [];
  log.unshift(rec);
  await ref.set({ log: log.slice(0, COMPLIANCE_LOG_CAP), lastCheckAt: rec.at, lastCheckBy: rec.by }, { merge: true });

  if (rec.soc2.changed || rec.hipaa.changed) {
    try {
      const admins = await db.collection("users").where("role", "in", ["admin", "superadmin"]).get();
      const now = admin.firestore.FieldValue.serverTimestamp();
      const batch = db.batch();
      admins.forEach((u) => {
        batch.set(db.collection("notifications").doc(), {
          to: u.id, title: "Compliance: standard updated", body: rec.headline.slice(0, 140),
          link: "s-comply", by: "Standard watch", at: now,
        });
      });
      await batch.commit(); await sweepPush().catch(() => {});
    } catch (e) { logger.error("compliance notify failed", e && e.message); }
  }
  return rec;
}

// Callable: "Check for standard updates" button on the Comply screen.
exports.checkComplianceUpdates = onCall({ region: REGION, timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to run the compliance check.");
  try {
    const by = (request.auth.token && request.auth.token.email) || request.auth.uid;
    const rec = await runComplianceCheck(by);
    return { ok: true, rec: rec };
  } catch (e) {
    if (e && e.code === "no-key") {
      throw new HttpsError("failed-precondition",
        "The standard-watch needs the assistant — add an ANTHROPIC_API_KEY secret to enable the web check.");
    }
    logger.error("checkComplianceUpdates failed", e && e.message);
    throw new HttpsError("internal", "Standard check failed — try again in a moment.");
  }
});

// Scheduled: the 1st of every month, quietly re-check the standards.
exports.scheduledComplianceCheck = onSchedule({ schedule: "1 of month 09:00", region: REGION }, async () => {
  if (!process.env.ANTHROPIC_API_KEY) { logger.info("scheduledComplianceCheck skipped — ANTHROPIC_API_KEY not set"); return; }
  try {
    const rec = await runComplianceCheck("schedule");
    logger.info("scheduledComplianceCheck: soc2 changed=" + rec.soc2.changed + " hipaa changed=" + rec.hipaa.changed);
  } catch (e) {
    logger.error("scheduledComplianceCheck failed", e && e.message);
  }
});

/* ------------------------------------------------------------------ *
 * RELEASE QC SAFETY NET — daily scan that makes sure no release slips
 * out the door untested and nothing sits half-tested forever. The soak
 * test itself runs in the tester's browser (Web Bluetooth / Web Serial
 * to a real band); this backend job is the memory so the process isn't
 * "we think it works": it flags releases that are testing but have no
 * passing run, or were released without a passing soak, and nudges
 * leadership. Read-only over releases/qc_runs; writes only notifications.
 * ------------------------------------------------------------------ */
exports.scanReleaseTesting = onSchedule({ schedule: "every day 14:00", region: REGION }, async () => {
  const now = Date.now();
  const rels = await db.collection("releases").get();
  if (rels.empty) { logger.info("scanReleaseTesting: no releases"); return null; }

  // Which releases have a passing soak run for their current version?
  const passByRelease = {};
  const runs = await db.collection("qc_runs").where("verdict", "==", "pass").get();
  runs.forEach((r) => { const d = r.data() || {}; if (d.releaseId) passByRelease[d.releaseId + "@" + (d.version || "")] = true; });

  const flags = [];
  rels.forEach((doc) => {
    const r = doc.data() || {};
    const key = doc.id + "@" + (r.version || "");
    const passed = !!passByRelease[key];
    const label = (r.product || "build") + " " + (r.version || "");
    if (r.status === "released" && !passed) {
      flags.push({ sev: "gap", title: "Released without a passing soak", body: label + " is marked Released but has no passing QC run." });
    } else if (r.status === "testing") {
      const started = Date.parse(r.testingSince || r.createdAt || "") || now;
      const days = Math.floor((now - started) / 864e5);
      if (!passed && days >= 3) flags.push({ sev: "warn", title: "Release stuck in testing", body: label + " has been in QC " + days + " days with no passing run." });
    } else if (r.status === "failed") {
      flags.push({ sev: "warn", title: "Release failed QC", body: label + " failed its last soak test — needs a fix + re-test." });
    }
  });

  await db.collection("nudges").doc("releaseQc").set({
    at: new Date().toISOString(), count: flags.length, flags: flags.slice(0, 20),
  }, { merge: true });

  if (flags.length) {
    try {
      const leads = await db.collection("users").where("role", "in", ["admin", "manager", "superadmin"]).get();
      const stamp = admin.firestore.FieldValue.serverTimestamp();
      const batch = db.batch();
      const top = flags[0];
      leads.forEach((u) => {
        batch.set(db.collection("notifications").doc(), {
          to: u.id, title: "Release QC: " + top.title, body: top.body + (flags.length > 1 ? " (+" + (flags.length - 1) + " more)" : ""),
          link: "s-qc", by: "Release QC", at: stamp,
        });
      });
      await batch.commit(); await sweepPush().catch(() => {});
    } catch (e) { logger.error("scanReleaseTesting notify failed", e && e.message); }
  }
  logger.info("scanReleaseTesting: " + flags.length + " flag(s)");
  return null;
});

/* ------------------------------------------------------------------ *
 * RUN CAMPAIGNS  →  send next due step of each active campaign
 * ------------------------------------------------------------------ */
exports.runCampaigns = onSchedule({ schedule: "every day 15:00", region: REGION }, async () => {
  const now = Date.now();

  const camps = {};
  (await db.collection("campaigns").get()).forEach((d) => { camps[d.id] = d.data(); });
  if (!Object.keys(camps).length) { logger.info("runCampaigns: no campaigns"); return null; }

  const senderCache = {}; // uid -> {creds, sender} | null
  async function resolveSender(uid) {
    if (uid in senderCache) return senderCache[uid];
    const creds = await getCreds(uid);
    senderCache[uid] = creds ? { creds, sender: senderFrom(creds, await getProfile(uid)) } : null;
    return senderCache[uid];
  }

  // Sales accounts and investors (investors live in their own finance-gated collection).
  const accs = { docs: [...(await db.collection("crm_accounts").get()).docs, ...(await db.collection("investors").get()).docs] };
  let sent = 0;
  for (const doc of accs.docs) {
    if (sent >= CAMPAIGN_SENDS_PER_RUN) break;
    const a = doc.data();
    if (a.archived) continue; // archived accounts never get campaign mail
    const en = a.campaign;
    if (!en || en.status !== "active") continue;
    if (en.nextAt && Date.parse(en.nextAt) > now) continue;

    const camp = camps[en.id];
    if (!camp || camp.status !== "active") continue;
    const steps = camp.steps || [];
    const idx = en.step || 0;
    if (idx >= steps.length) { await setEnrollment(doc.ref, en, { status: "completed" }); continue; }

    const to = a.email || (a.contacts && a.contacts[0] && a.contacts[0].email) || "";
    if (!to) { await setEnrollment(doc.ref, en, { status: "no-email" }); continue; }

    const owner = await resolveSender(camp.ownerUid || en.ownerUid);
    if (!owner) { await setEnrollment(doc.ref, en, { status: "no-sender" }); continue; }

    const ctx = mergeCtx(a);
    const step = steps[idx];
    const subject = renderTemplate(step.subject, ctx);
    const text = renderTemplate(step.body, ctx);
    try {
      await deliver(owner.creds, owner.sender, { to, subject, text });
      sent++;
    } catch (e) {
      logger.error("campaign send failed", e && e.message);
      continue; // leave enrollment as-is; retry next run
    }

    const note = { user: owner.creds.email, at: stamp(), text: `🤖 Campaign "${camp.name}" · step ${idx + 1} → ${to}: ${text.slice(0, 200)}` };
    let patch;
    if (idx + 1 < steps.length) {
      const gap = Math.max(0, (steps[idx + 1].day || 0) - (step.day || 0));
      patch = { step: idx + 1, nextAt: new Date(now + gap * 86400000).toISOString(), lastSentAt: new Date(now).toISOString() };
    } else {
      patch = { step: idx + 1, status: "completed", lastSentAt: new Date(now).toISOString() };
    }
    const notes = (a.notes || []).slice(); notes.unshift(note);
    await doc.ref.set({ notes, campaign: Object.assign({}, en, patch) }, { merge: true });
  }
  logger.info(`runCampaigns: ${sent} emails sent`);
  return null;
});

/* ------------------------------------------------------------------ *
 * SCAN OVERDUE  →  nudges/summary
 * ------------------------------------------------------------------ */
exports.scanOverdue = onSchedule({ schedule: "every day 13:00", region: REGION }, async () => {
  const now = Date.now();

  const accs = await db.collection("crm_accounts").get();
  const staleAccounts = [];
  accs.forEach((d) => {
    const a = d.data();
    if (a.archived || a.stage === "Won" || a.stage === "Lost") return;
    const last = lastActivity(a);
    if (last == null || (now - last) / 86400000 > STALE_DAYS) {
      staleAccounts.push({ id: d.id, name: a.name || "", owner: a.owner || "Unassigned", stage: a.stage || "New" });
    }
  });

  const tix = await db.collection("tickets").where("status", "==", "open").get();
  const breached = [];
  tix.forEach((d) => {
    const t = d.data();
    const hrs = (now - Date.parse(t.created || 0)) / 3600000;
    if (hrs > (SLA_HOURS[t.sev] || 24)) breached.push({ id: d.id, title: t.title || "", sev: t.sev || "medium" });
  });

  await db.collection("nudges").doc("summary").set({
    updatedAt: new Date().toISOString(),
    staleAccounts: staleAccounts.slice(0, 100),
    breachedTickets: breached.slice(0, 100),
    staleCount: staleAccounts.length,
    breachedCount: breached.length,
  });
  logger.info(`scanOverdue: ${staleAccounts.length} stale, ${breached.length} breached`);
  return null;
});

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
async function getCreds(uid) {
  const snap = await db.collection("mail_credentials").doc(uid).get();
  const c = snap.exists ? snap.data() : null;
  return c && c.email && c.pass && c.smtp ? c : null;
}
async function getProfile(uid) {
  try { const s = await db.collection("users").doc(uid).get(); return s.exists ? (s.data() || {}) : {}; }
  catch (e) { return {}; }
}
function senderFrom(creds, prof) {
  return { email: creds.email, name: (prof && prof.name) || creds.email.split("@")[0], title: (prof && prof.title) || "", phone: (prof && prof.phone) || creds.phone || "" };
}
function mailTransport(creds) {
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({
    host: creds.smtp,
    port: Number(creds.port) || 587,
    secure: Number(creds.port) === 465,
    auth: { user: creds.email, pass: creds.pass },
  });
}
async function deliver(creds, sender, { to, subject, text }) {
  const transport = mailTransport(creds);
  await transport.sendMail({
    from: `"${(sender.name || "").replace(/"/g, "")}" <${creds.email}>`,
    to,
    subject: subject || "(no subject)",
    text: (text || "") + signatureText(sender),
    html: buildBrandedEmail(text || "", sender),
  });
}
async function logNote(accountId, note) {
  let acc = await db.collection("crm_accounts").doc(accountId).get();
  if (!acc.exists) acc = await db.collection("investors").doc(accountId).get();
  if (!acc.exists) return;
  const notes = (acc.data().notes || []).slice();
  notes.unshift(note);
  await acc.ref.set({ notes }, { merge: true });
}
function setEnrollment(ref, en, patch) {
  return ref.set({ campaign: Object.assign({}, en, patch) }, { merge: true });
}
function stamp() {
  return new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function renderTemplate(s, ctx) {
  return String(s == null ? "" : s).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (ctx[k] != null ? ctx[k] : ""));
}
function serverDisplayName(a) {
  let n = (a.name || "").trim();
  if (/^https?:\/\//i.test(n) || /^www\./i.test(n)) {
    try { return new URL(/^https?:/i.test(n) ? n : "https://" + n).hostname.replace(/^www\./, ""); }
    catch (e) { return n.replace(/^https?:\/\//i, "").replace(/^www\./, "").replace(/\/.*$/, ""); }
  }
  return n;
}
function mergeCtx(a) {
  const contact = a.contact || (a.contacts && a.contacts[0] && a.contacts[0].name) || "";
  const first = (contact.trim().split(/\s+/)[0]) || "there";
  return { firstName: first, contact: contact || "there", company: serverDisplayName(a) || "your team", city: (a.location || "").split(",")[0] || "" };
}

function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function signatureText(c) {
  let s = "\n\n--\n" + (c.name || c.email);
  s += c.title ? "\n" + c.title + " · Safewave Technology" : "\nSafewave Technology";
  if (c.phone) s += "\n" + c.phone;
  s += "\n" + c.email + "\nsafewavetech.com";
  return s;
}
function buildBrandedEmail(body, c) {
  const name = esc(c.name || c.email);
  const bodyHtml = esc(body).replace(/\n/g, "<br>");
  const titleLine = c.title ? esc(c.title) + " &nbsp;·&nbsp; Safewave Technology" : "Safewave Technology";
  const contact = [
    c.phone ? esc(c.phone) : "",
    '<a href="mailto:' + esc(c.email) + '" style="color:#0aa5bd;text-decoration:none">' + esc(c.email) + "</a>",
    '<a href="https://safewavetech.com" style="color:#0aa5bd;text-decoration:none">safewavetech.com</a>',
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  return (
    '<div style="margin:0;padding:24px 0;background:#f4f6f8">' +
      '<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1d22">' +
        '<div style="background:#0B0C0E;padding:22px 28px;border-bottom:3px solid #4FD8EC">' +
          '<img src="https://cdn.shopify.com/s/files/1/0630/9602/9423/files/logo3x.png?v=1646599241" alt="Safewave" width="160" style="display:block;border:0;outline:none;height:auto;max-width:160px">' +
        "</div>" +
        '<div style="padding:28px 28px 4px 28px">' + bodyHtml + "</div>" +
        '<div style="padding:0 28px 26px 28px"><div style="margin-top:22px;padding-top:16px;border-top:2px solid #4FD8EC">' +
          '<div style="font-weight:700;font-size:15px;color:#0B0C0E">' + name + "</div>" +
          '<div style="font-size:13px;color:#555">' + titleLine + "</div>" +
          '<div style="font-size:12px;color:#888;margin-top:6px">' + contact + "</div>" +
        "</div></div>" +
        '<div style="background:#f4f6f8;padding:14px 28px;font-size:11px;color:#9aa2ab">Safewave Technology — vibration alerts for the Deaf &amp; hard-of-hearing. <a href="https://safewavetech.com" style="color:#9aa2ab">safewavetech.com</a></div>' +
      "</div>" +
    "</div>"
  );
}
function pDate(s) { if (!s) return null; const d = Date.parse(s); return isNaN(d) ? null : d; }
function lastActivity(a) {
  const ds = [];
  (a.notes || []).forEach((n) => { const d = pDate(n.at); if (d) ds.push(d); });
  const dd = pDate(a.date);
  if (dd) ds.push(dd);
  // Stage changes, creation and restores count as activity too.
  ["stageChangedAt", "createdAt", "restoredAt"].forEach((k) => { const v = a[k] ? Date.parse(a[k]) : NaN; if (!isNaN(v)) ds.push(v); });
  return ds.length ? Math.max.apply(null, ds) : null;
}

/* ============================================================================
 * FIELD MONITOR — cross-project telemetry mirror
 * ----------------------------------------------------------------------------
 * The mobile app lives in a SEPARATE Firebase project (default: safewave-371716).
 * This scheduled function reads that project's telemetry with a read-only-in-
 * practice service account (APP_FIREBASE_SA — the JSON key, injected at deploy)
 * and mirrors it into THIS project so the super-admin Field Monitor can review
 * every wearer's band + app activity in one place.
 *   - Incremental: a cursor (field_sync/cursor) tracks the last-seen timestamp
 *     for activity_logs and history so each run only pulls new rows.
 *   - Idempotent: mirror doc id = "<srcCollection>_<srcId>", so re-runs upsert.
 *   - Bounded: caps rows/users/bands per run to stay within function limits.
 * If APP_FIREBASE_SA isn't set the function no-ops (safe before the secret is
 * provisioned). Never writes to the app project.
 * ==========================================================================*/
let _appDb = null;
function appProjectDb() {
  if (_appDb) return _appDb;
  // The app-project service-account key, provided as base64 of the JSON key file
  // (APP_FIREBASE_SA_B64) so a multi-line key survives the .env round-trip. A raw
  // single-line JSON in APP_FIREBASE_SA is also accepted as a fallback.
  let raw = "";
  if (process.env.APP_FIREBASE_SA_B64) {
    try { raw = Buffer.from(process.env.APP_FIREBASE_SA_B64, "base64").toString("utf8"); } catch (e) { raw = ""; }
  } else {
    raw = process.env.APP_FIREBASE_SA || "";
  }
  if (!raw) return null;
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { logger.error("APP_FIREBASE_SA(_B64) is not valid JSON"); return null; }
  try {
    const app = admin.initializeApp(
      { credential: admin.credential.cert(sa), projectId: sa.project_id },
      "appProject"
    );
    _appDb = app.firestore();
    return _appDb;
  } catch (e) {
    // Re-init guard: if the named app already exists (warm instance), reuse it.
    try { _appDb = admin.app("appProject").firestore(); return _appDb; } catch (_) {}
    logger.error("appProjectDb init failed", e);
    return null;
  }
}

// Normalize an app-project activity_logs doc into a Field Monitor event.
function normActivity(id, d) {
  const m = d.metadata || {};
  const ms = d.timestamp && d.timestamp.toMillis ? d.timestamp.toMillis() : 0;
  return {
    src: "activity_logs", srcId: id,
    kind: d.type || "event",
    userId: d.userId || null,
    userEmail: d.userEmail || null,
    bandName: m.bandName || null,
    platform: d.devicePlatform || null,
    reason: m.reason || null,
    bleErrorCode: (m.bleErrorCode !== undefined ? m.bleErrorCode : null),
    bleReason: (m.bleReason !== undefined ? m.bleReason : null),
    firmwareVersion: m.firmwareVersion || null,
    batteryLevel: (m.batteryLevel !== undefined ? m.batteryLevel : null),
    missingPermissions: m.missingPermissions || null,
    ts: ms, mirroredAt: Date.now(),
  };
}
// Normalize an app-project history doc (a delivered notification) into an event.
function normHistory(id, d) {
  const ms = d.date && d.date.toMillis ? d.date.toMillis() : 0;
  const ackMs = d.acknowledgedAt && d.acknowledgedAt.toMillis ? d.acknowledgedAt.toMillis() : null;
  return {
    src: "history", srcId: id,
    kind: "alert",
    userId: d.userId || null,
    appName: d.appName || null,
    bundleIdentifier: d.bundleIdentifier || null,
    message: d.message || null,
    acknowledged: !!d.acknowledged,
    acknowledgedAt: ackMs,
    ts: ms, mirroredAt: Date.now(),
  };
}

exports.mirrorFieldTelemetry = onSchedule(
  { schedule: "every 5 minutes", region: REGION, timeoutSeconds: 300 },
  async () => {
    const src = appProjectDb();
    if (!src) { logger.info("mirrorFieldTelemetry skipped — APP_FIREBASE_SA not set"); return; }

    const curRef = db.collection("field_sync").doc("cursor");
    const curSnap = await curRef.get();
    const cur = curSnap.exists ? (curSnap.data() || {}) : {};
    let actMs = Number(cur.activityMs || 0);
    let histMs = Number(cur.historyMs || 0);
    const LIMIT = 500;
    let events = 0;

    // ---- activity_logs (connect/disconnect/permission/battery events) ----
    try {
      const snap = await src.collection("activity_logs")
        .where("timestamp", ">", admin.firestore.Timestamp.fromMillis(actMs))
        .orderBy("timestamp", "asc").limit(LIMIT).get();
      let batch = db.batch(), n = 0;
      for (const doc of snap.docs) {
        const ev = normActivity(doc.id, doc.data());
        batch.set(db.collection("field_events").doc("activity_logs_" + doc.id), ev, { merge: true });
        if (ev.ts > actMs) actMs = ev.ts;
        events++; if (++n >= 450) { await batch.commit(); batch = db.batch(); n = 0; }
      }
      if (n) await batch.commit();
    } catch (e) { logger.error("mirror activity_logs failed", e); }

    // ---- history (delivered notifications + button-ack) ----
    try {
      const snap = await src.collection("history")
        .where("date", ">", admin.firestore.Timestamp.fromMillis(histMs))
        .orderBy("date", "asc").limit(LIMIT).get();
      let batch = db.batch(), n = 0;
      for (const doc of snap.docs) {
        const ev = normHistory(doc.id, doc.data());
        batch.set(db.collection("field_events").doc("history_" + doc.id), ev, { merge: true });
        if (ev.ts > histMs) histMs = ev.ts;
        events++; if (++n >= 450) { await batch.commit(); batch = db.batch(); n = 0; }
      }
      if (n) await batch.commit();
    } catch (e) { logger.error("mirror history failed", e); }

    // ---- roster: mirror users + live band status (full bounded snapshot) ----
    let users = 0, bands = 0;
    try {
      const snap = await src.collection("users").limit(2000).get();
      let batch = db.batch(), n = 0;
      for (const doc of snap.docs) {
        const u = doc.data() || {};
        batch.set(db.collection("field_users").doc(doc.id), {
          userId: doc.id,
          name: u.name || u.displayName || null,
          email: u.email || null,
          bandName: u.bandName || (Array.isArray(u.bands) ? (u.bands[0] || null) : null),
          organizationId: u.organizationId || null,
          mirroredAt: Date.now(),
        }, { merge: true });
        users++; if (++n >= 450) { await batch.commit(); batch = db.batch(); n = 0; }
      }
      if (n) await batch.commit();
    } catch (e) { logger.error("mirror users failed", e); }
    try {
      const snap = await src.collection("bands").limit(2000).get();
      let batch = db.batch(), n = 0;
      for (const doc of snap.docs) {
        const b = doc.data() || {};
        batch.set(db.collection("field_bands").doc(doc.id), {
          bandId: doc.id,
          name: b.name || doc.id,
          assignedUserId: b.assignedUserId || null,
          isConnected: (b.isConnected !== undefined ? b.isConnected : null),
          batteryLevel: (b.batteryLevel !== undefined ? b.batteryLevel : null),
          ancsStatus: (b.ancsStatus !== undefined ? b.ancsStatus : null),
          firmwareVersion: b.firmwareVersion || null,
          lastConnected: b.lastConnected && b.lastConnected.toMillis ? b.lastConnected.toMillis() : null,
          lastDisconnected: b.lastDisconnected && b.lastDisconnected.toMillis ? b.lastDisconnected.toMillis() : null,
          mirroredAt: Date.now(),
        }, { merge: true });
        bands++; if (++n >= 450) { await batch.commit(); batch = db.batch(); n = 0; }
      }
      if (n) await batch.commit();
    } catch (e) { logger.error("mirror bands failed", e); }

    await curRef.set({ activityMs: actMs, historyMs: histMs, lastRunAt: Date.now(), lastCounts: { events, users, bands } }, { merge: true });
    logger.info("mirrorFieldTelemetry done", { events, users, bands });
  }
);

/* ------------------------------------------------------------------ *
 * TEAM SIGN-INS — when each teammate first signed in, last signed in
 * and was last active, from Firebase Auth's own records. Super admin and
 * the oversight accounts only (the same people who see the Users screen).
 * lastRefreshTime moves roughly hourly while someone has the app open, so
 * it is the best "last active" for the time before the app logged sessions.
 * ------------------------------------------------------------------ */
const SIGNIN_VIEWERS = ["jared@safewavetech.com", "trevon@safewavetech.com"];
exports.teamSignIns = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const me = await db.collection("users").doc(request.auth.uid).get();
  const email = String(request.auth.token.email || "").toLowerCase();
  const ok = (me.exists && me.data().role === "superadmin") || SIGNIN_VIEWERS.includes(email);
  if (!ok) throw new HttpsError("permission-denied", "Super admin only.");
  const out = [];
  let page;
  do {
    page = await admin.auth().listUsers(1000, page && page.pageToken);
    page.users.forEach((u) => out.push({
      uid: u.uid,
      email: u.email || "",
      created: u.metadata.creationTime || null,
      lastSignIn: u.metadata.lastSignInTime || null,
      lastActive: u.metadata.lastRefreshTime || null,
      disabled: !!u.disabled,
    }));
  } while (page.pageToken);
  return { users: out };
});

/* ------------------------------------------------------------------ *
 * VIDEO VIEWS — who watched the training video, for how long, and which
 * chapters. The /training/ page is public (no sign-in), so it reports
 * here instead of writing Firestore itself:
 *  - a teammate signed in to Command Center in the same browser sends
 *    their ID token, and the view is tied to their account;
 *  - anyone else is a guest, identified only by the name they typed.
 * Each viewing session is one video_views/{id} doc. Counters only move
 * forward and watched time is capped by real elapsed time, so a replayed
 * or forged beacon cannot inflate a view. Read by super admin + oversight
 * (Users screen); written only here.
 * ------------------------------------------------------------------ */
const VIDEO_CHAPTERS = {
  training: ["overview", "setup", "people", "alerts", "phone", "aware", "messaging", "health", "wrap-up"],
};
const VIEW_ORIGINS = ["https://safewave-command-center.web.app", "https://safewave-command-center.firebaseapp.com"];
function viewDevice(ua) {
  ua = String(ua || "");
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "Other";
  const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return br ? os + " · " + br : os;
}
exports.videoView = onRequest({ region: REGION }, async (req, res) => {
  const origin = req.get("Origin") || "";
  if (VIEW_ORIGINS.includes(origin)) { res.set("Access-Control-Allow-Origin", origin); res.set("Vary", "Origin"); }
  if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods", "POST"); res.set("Access-Control-Allow-Headers", "Content-Type"); res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).send("POST only"); return; }
  if (origin && !VIEW_ORIGINS.includes(origin)) { res.status(403).send("origin"); return; }
  let b = req.body;
  try { if (typeof b === "string") b = JSON.parse(b); else if (Buffer.isBuffer(b)) b = JSON.parse(b.toString("utf8")); } catch (e) { res.status(400).send("json"); return; }
  b = b || {};
  const id = String(b.id || "");
  const video = String(b.video || "");
  const chapterIds = VIDEO_CHAPTERS[video];
  if (!/^[a-z0-9]{16,40}$/.test(id) || !chapterIds) { res.status(400).send("bad view"); return; }
  const duration = Math.max(0, Math.min(Number(b.duration) || 0, 4 * 3600));
  const cap = (duration || 7200) * 3; // nobody watches one session more than three times over
  const watched = Math.max(0, Math.min(Number(b.watched) || 0, cap));
  const position = Math.max(0, Math.min(Number(b.position) || 0, duration || cap));
  const chapters = {};
  if (b.chapters && typeof b.chapters === "object") {
    chapterIds.forEach((c) => { const v = Number(b.chapters[c]); if (v > 0) chapters[c] = Math.min(v, cap); });
  }

  let uid = null, email = "", name = "";
  if (b.token) {
    try {
      const t = await admin.auth().verifyIdToken(String(b.token));
      uid = t.uid; email = String(t.email || "");
      const u = await db.collection("users").doc(uid).get();
      name = (u.exists && (u.data().name || "")) || t.name || email.split("@")[0] || "";
    } catch (e) { uid = null; }
  }
  if (!uid) name = String(b.guest || "").replace(/\s+/g, " ").trim().slice(0, 60);

  const ref = db.collection("video_views").doc(id);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      const old = snap.exists ? snap.data() : null;
      if (old && old.uid && uid && old.uid !== uid) throw new Error("owner");
      if (old && old.uid && !uid) { uid = old.uid; email = old.email || ""; name = old.name || ""; } // a token that lapsed mid-view keeps the view's owner
      const started = old && old.startedAt && old.startedAt.toMillis ? old.startedAt.toMillis() : now;
      const elapsed = Math.max(0, (now - started) / 1000);
      const allow = elapsed * 2.2 + 30; // playback at up to 2x, plus a little slack
      const merged = Object.assign({}, (old && old.chapters) || {});
      Object.keys(chapters).forEach((c) => { merged[c] = Math.max(merged[c] || 0, Math.min(chapters[c], allow)); });
      const doc = {
        video, uid: uid || null, email: uid ? email : "", name: name || (old && old.name) || "",
        guest: !uid,
        watchedSeconds: Math.max((old && old.watchedSeconds) || 0, Math.min(watched, allow)),
        furthestSeconds: Math.max((old && old.furthestSeconds) || 0, position),
        durationSeconds: duration || (old && old.durationSeconds) || 0,
        chapters: merged,
        completed: !!((old && old.completed) || b.ended === true || (duration && position >= duration - 20)),
        device: viewDevice(req.get("User-Agent")),
        lastAt: admin.firestore.FieldValue.serverTimestamp(),
        beats: admin.firestore.FieldValue.increment(1),
      };
      if (!old) doc.startedAt = admin.firestore.FieldValue.serverTimestamp();
      if (old && (old.beats || 0) > 2000) throw new Error("too many");
      tx.set(ref, doc, { merge: true });
    });
  } catch (e) {
    res.status(e && e.message === "owner" ? 403 : 429).send("rejected"); return;
  }
  res.status(204).send("");
});

/* ------------------------------------------------------------------ *
 * TICKET INTAKE  →  tickets/{id}
 * Support messages from the Safewave phone app and the customer dashboard
 * (Firebase project safewave-371716, collection contact_submissions) are
 * forwarded here by that project's forwardSupportToCommandCenter function,
 * so every complaint lands on one Support board.
 *
 * No shared secret: the caller sends a Google-signed ID token for its own
 * service account. We check it with Google (signature, expiry, audience) and
 * only accept the app project's service accounts.
 * ------------------------------------------------------------------ */
const INTAKE_AUDIENCE = "https://us-central1-safewave-command-center.cloudfunctions.net/ticketIntake";
const INTAKE_CALLERS = [
  "393568702648-compute@developer.gserviceaccount.com", // safewave-371716 default compute SA (Cloud Functions v2)
  "safewave-371716@appspot.gserviceaccount.com",
];
const SAFETY_WORDS = /\b(fire|smoke|alarm (didn'?t|did not|never)|missed (an )?alert|didn'?t (buzz|vibrate|alert)|no (buzz|vibration)|overheat|hot|burn|swell|battery (swell|bulg)|injur|emergency)\b/i;

async function verifyCaller(req) {
  const h = req.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok) return null;
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(tok));
  if (!r.ok) return null;
  const c = await r.json();
  if (c.aud !== INTAKE_AUDIENCE) return null;
  if (String(c.email_verified) !== "true") return null;
  if (!INTAKE_CALLERS.includes(c.email)) return null;
  if (Number(c.exp) * 1000 < Date.now()) return null;
  return c.email;
}

const clip = (v, n) => (v === undefined || v === null || v === "") ? null : String(v).slice(0, n || 60);
function intakeDevice(d) {
  if (!d || typeof d !== "object") return null;
  const o = { platform: clip(d.platform, 20), osVersion: clip(d.osVersion, 30), deviceModel: clip(d.deviceModel, 60), appVersion: clip(d.appVersion, 30), appBuild: clip(d.appBuild, 30) };
  Object.keys(o).forEach((k) => { if (o[k] === null) delete o[k]; });
  return Object.keys(o).length ? o : null;
}
function intakeAppUser(u, site) {
  if (!u || typeof u !== "object") return null;
  const bands = (Array.isArray(u.bands) ? u.bands : []).slice(0, 4).map((b) => {
    const o = { name: clip(b && b.name, 60), serial: clip(b && b.serial, 60), firmware: clip(b && b.firmware, 30),
      battery: Number.isFinite(Number(b && b.battery)) ? Math.max(0, Math.min(100, Math.round(Number(b.battery)))) : null,
      connected: (b && typeof b.connected === "boolean") ? b.connected : null,
      lastConnected: Number.isFinite(Number(b && b.lastConnected)) ? Number(b.lastConnected) : null };
    Object.keys(o).forEach((k) => { if (o[k] === null) delete o[k]; });
    return o;
  }).filter((o) => Object.keys(o).length);
  const o = { userId: clip(u.userId, 128), organizationName: clip(site, 120) };
  if (bands.length) o.bands = bands;
  Object.keys(o).forEach((k) => { if (o[k] === null) delete o[k]; });
  return Object.keys(o).length ? o : null;
}
exports.ticketIntake = onRequest({ region: REGION }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).send("POST only"); return; }
  let caller;
  try { caller = await verifyCaller(req); } catch (e) { caller = null; }
  if (!caller) { res.status(403).send("Forbidden"); return; }

  const b = req.body || {};
  const srcId = String(b.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!srcId) { res.status(400).send("Missing id"); return; }
  const message = String(b.message || "").slice(0, 5000);
  const name = String(b.name || "").slice(0, 120);
  const email = String(b.email || "").slice(0, 200);
  const site = String(b.organizationName || b.organizationId || "").slice(0, 120);
  const fromDashboard = !!b.organizationId;
  const firstLine = (message.split(/\n/)[0] || "Support request").trim();
  const title = (firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine) || "Support request";
  const safety = SAFETY_WORDS.test(message);

  const id = "APP-" + srcId.slice(-10).toUpperCase();
  const ref = db.collection("tickets").doc(id);
  const existing = await ref.get();
  if (existing.exists) { res.json({ ok: true, id, duplicate: true }); return; }

  const t = {
    id, title,
    customer: [name, site].filter(Boolean).join(" · ") || email || "App user",
    email,
    channel: fromDashboard ? "Dashboard" : "In-app",
    product: fromDashboard ? "Dashboard" : "App",
    sev: safety ? "safety" : "medium",
    desc: message,
    assignee: "",
    due: "",
    status: "open",
    created: new Date().toISOString(),
    by: fromDashboard ? (site || "Customer dashboard") : "Phone app",
    source: { project: "safewave-371716", collection: "contact_submissions", id: srcId, organizationId: b.organizationId || null },
  };
  // Optional context the app / forwarder can send with the message: the phone
  // and app version, and the customer's band(s) as the app saw them.
  const dv = intakeDevice(b.device);
  if (dv) t.device = dv;
  const au = intakeAppUser(b.appUser, site);
  if (au) t.appUser = au;
  await ref.set(t);
  await addNotification({
    to: "all",
    title: (safety ? "⚠ Safety ticket: " : "New ticket: ") + title,
    body: t.customer,
    link: "s-support:" + id, // opens this ticket directly
    by: t.by,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info(`ticketIntake: ${id} from ${caller} (${t.channel}${safety ? ", safety" : ""})`);
  res.json({ ok: true, id });
});

/* ------------------------------------------------------------------ *
 * DAILY ACTION EMAIL  (7:00 am Eastern, every day)
 * Each teammate gets ONLY their own items: overdue, due today, due this
 * week — from action items, build tasks, tickets and CRM next steps — plus a
 * one-line company context. Nobody with nothing due gets an email. Sent from
 * the super admin's connected mailbox; without one it falls back to an
 * in-app notification. sendMyDigest lets anyone send theirs now (preview).
 * ------------------------------------------------------------------ */
const APP_URL = "https://safewave-command-center.web.app";
function ymdET(ms) { return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
function nameMatches(who, user) {
  if (!who || !user) return false;
  const w = String(who).toLowerCase().trim();
  const me = String(user.name || "").toLowerCase().trim();
  const first = me.split(" ")[0];
  if (user.uid && w === String(user.uid).toLowerCase()) return true;
  return (me && w === me) || (first.length > 1 && w.indexOf(first) >= 0) || (user.email && w === String(user.email).toLowerCase());
}
async function digestData() {
  const [acts, build, tix, crm, rtasks, investors, dataroom] = await Promise.all([
    db.collection("actions").where("status", "==", "open").get(),
    db.collection("build_tasks").get(),
    db.collection("tickets").where("status", "==", "open").get(),
    db.collection("crm_accounts").get(),
    db.collection("raise_tasks").where("status", "==", "open").get(),
    db.collection("investors").get(),
    db.collection("dataroom").get(),
  ]);
  const items = [];
  acts.forEach((d) => { const a = d.data(); items.push({ who: a.ownerName || a.owner || "", whoUid: a.owner || "", title: a.title, due: a.due || "", kind: "Action" }); });
  build.forEach((d) => { const t = d.data(); if (t.status === "done") return; items.push({ who: t.assignee || "", title: t.title, due: t.due || "", kind: "Build" }); });
  tix.forEach((d) => { const t = d.data(); items.push({ who: t.assignee || "", title: `${t.sev === "safety" ? "SAFETY ticket" : "Ticket"}: ${t.title}`, due: t.due || "", kind: "Ticket" }); });
  crm.forEach((d) => { const a = d.data(); if (a.archived || !a.dueAt || a.stage === "Won" || a.stage === "Lost") return; items.push({ who: a.owner || "", title: (a.nextStep ? a.nextStep + " — " : "Follow up: ") + (a.name || "account"), due: String(a.dueAt).slice(0, 10), kind: "CRM" }); });
  // The raise. Each person only receives their own items, and only the
  // finance group is ever assigned these.
  rtasks.forEach((d) => { const x = d.data(); items.push({ who: x.ownerName || "", whoUid: x.owner || "", title: "Raise: " + x.title + (x.investorName ? " — " + x.investorName : ""), due: x.due || "", kind: "Raise" }); });
  investors.forEach((d) => { const a = d.data(); if (!a.dueAt || a.commitStatus === "wired" || a.commitStatus === "passed") return; items.push({ who: a.owner || "", title: "Raise: " + (a.nextStep ? a.nextStep + " — " : "Investor follow-up: ") + (a.name || "investor"), due: String(a.dueAt).slice(0, 10), kind: "Raise" }); });
  const DR_EMAILS = { brad: ["brad.herald@safewavetech.com"], trey: ["trevon@safewavetech.com"], both: ["brad.herald@safewavetech.com", "trevon@safewavetech.com"] };
  dataroom.forEach((d) => { const it = d.data(); if ((it.files || []).length || !it.due) return; (DR_EMAILS[it.who] || DR_EMAILS.trey).forEach((em) => items.push({ who: "", whoEmail: em, title: "Data room: " + (it.title || d.id), due: it.due, kind: "Raise" })); });
  return { items, openTickets: tix.size };
}
function digestFor(user, data, todayStr) {
  const weekStr = ymdET(Date.now() + 7 * 864e5);
  const em = String(user.email || "").toLowerCase();
  const mine = data.items.filter((x) => (x.whoUid && x.whoUid === user.uid) || (x.whoEmail && em && x.whoEmail === em) || nameMatches(x.who, user));
  const overdue = mine.filter((x) => x.due && x.due < todayStr).sort((a, b) => a.due.localeCompare(b.due));
  const today = mine.filter((x) => x.due === todayStr);
  const week = mine.filter((x) => x.due > todayStr && x.due <= weekStr).sort((a, b) => a.due.localeCompare(b.due));
  return { overdue, today, week, count: overdue.length + today.length + week.length };
}
function digestText(user, g, data) {
  const fmt = (x) => `• ${x.title}${x.due ? " (" + new Date(x.due + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ")" : ""}`;
  const first = String(user.name || "there").split(" ")[0];
  let t = `Good morning ${first}, here's what's yours today.\n\n`;
  if (g.overdue.length) t += `OVERDUE (${g.overdue.length})\n${g.overdue.map(fmt).join("\n")}\n\n`;
  if (g.today.length) t += `DUE TODAY (${g.today.length})\n${g.today.map(fmt).join("\n")}\n\n`;
  if (g.week.length) t += `THIS WEEK (${g.week.length})\n${g.week.map(fmt).join("\n")}\n\n`;
  t += `Company: ${data.openTickets} open support ticket${data.openTickets === 1 ? "" : "s"}.\n\nOpen the Command Center: ${APP_URL}`;
  return t;
}
async function digestSender() {
  const supers = await db.collection("users").where("role", "==", "superadmin").get();
  for (const s of supers.docs) {
    const creds = await getCreds(s.id);
    if (creds) return { creds, sender: senderFrom(creds, s.data() || {}) };
  }
  return null;
}
async function sendDigests(onlyUid) {
  const todayStr = ymdET(Date.now());
  const data = await digestData();
  const users = await db.collection("users").get();
  const mail = await digestSender();
  let sent = 0, notified = 0;
  for (const u of users.docs) {
    if (onlyUid && u.id !== onlyUid) continue;
    const user = Object.assign({ uid: u.id }, u.data() || {});
    if (!user.email || user.digestOff) continue;
    const g = digestFor(user, data, todayStr);
    if (!g.count && !onlyUid) continue;
    const subject = g.count
      ? `Today: ${g.overdue.length ? g.overdue.length + " overdue, " : ""}${g.today.length} due today, ${g.week.length} this week`
      : "Today: nothing due — you're clear";
    const text = digestText(user, g, data);
    if (mail) {
      try { await deliver(mail.creds, mail.sender, { to: user.email, subject, text }); sent++; continue; }
      catch (e) { logger.error("digest send failed", user.email, e && e.message); }
    }
    await addNotification({ to: u.id, title: subject, body: "Open Home for your Today list", link: "s-pulse", by: "Daily email", at: admin.firestore.FieldValue.serverTimestamp() });
    notified++;
  }
  logger.info(`dailyDigest: ${sent} emailed, ${notified} in-app${mail ? "" : " (no connected super-admin mailbox)"}`);
  return { sent, notified, mailbox: mail ? mail.creds.email : null };
}
exports.dailyDigest = onSchedule({ schedule: "every day 07:00", timeZone: "America/New_York", region: REGION }, async () => {
  await sendDigests(null);
});
exports.sendMyDigest = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return sendDigests(request.auth.uid);
});

/* ------------------------------------------------------------------ *
 * WEEKLY RAISE ROLLOUT — Monday 7:30 am ET to the raise leadership (the
 * finance group: super admins, Trey and the finance allow-list) plus
 * observers (Jared — informed, no decision rights), or whoever is set in
 * settings/raise.rolloutTo. Summarises the
 * round, the latest raise-sync minutes and decisions, every action item
 * and raise task (overdue / open / done this week), data room progress and
 * the next meeting.
 * ------------------------------------------------------------------ */
// Observers get the rollout (they stay informed) but can't send it.
const RAISE_OBSERVERS = ["jared@safewavetech.com"];
async function raiseRolloutRecipients() {
  const raise = (await db.collection("settings").doc("raise").get()).data() || {};
  let list = Array.isArray(raise.rolloutTo) && raise.rolloutTo.length ? raise.rolloutTo : null;
  if (!list) {
    const fin = (await db.collection("settings").doc("finance").get()).data() || {};
    const supers = await db.collection("users").where("role", "==", "superadmin").get();
    list = [...(fin.emails || []), ...supers.docs.map((d) => (d.data() || {}).email).filter(Boolean), "trevon@safewavetech.com", ...RAISE_OBSERVERS];
  }
  return [...new Set(list.map((e) => String(e || "").toLowerCase().trim()).filter((e) => /@/.test(e)))];
}
function nextRaiseMeeting(raise, fromMs) {
  const day = Number.isInteger(raise.meetDay) ? raise.meetDay : null;
  if (day == null) return null;
  const anchor = raise.meetAnchor ? Date.parse(raise.meetAnchor + "T12:00:00Z") : null;
  for (let i = 0; i < 21; i++) {
    const d = new Date(fromMs + i * 864e5);
    const ymd = ymdET(d.getTime());
    const dow = new Date(ymd + "T12:00:00Z").getUTCDay();
    if (dow !== day) continue;
    if (raise.meetCadence === "biweekly" && anchor) {
      const weeks = Math.round((Date.parse(ymd + "T12:00:00Z") - anchor) / (7 * 864e5));
      if (((weeks % 2) + 2) % 2 !== 0) continue;
    }
    return ymd;
  }
  return null;
}
const fmtUSD = (n) => { const v = Math.round(Number(n) || 0); return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US"); };
const fmtDay = (ymd) => ymd ? new Date(ymd + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "";
async function raiseRolloutText() {
  const now = Date.now(), today = ymdET(now), weekAgo = now - 7 * 864e5;
  const [raiseDoc, invs, tasks, meetings, dr] = await Promise.all([
    db.collection("settings").doc("raise").get(),
    db.collection("investors").get(),
    db.collection("raise_tasks").get(),
    db.collection("raise_meetings").orderBy("date", "desc").limit(3).get(),
    db.collection("dataroom").get(),
  ]);
  const finDoc = await db.collection("finance").doc("main").get().catch(() => null);
  const raise = raiseDoc.data() || {};
  let committed = 0, wired = 0, active = 0;
  invs.forEach((d) => { const a = d.data(); const c = Number(a.commit) || 0;
    if (a.commitStatus === "wired") { wired += c; committed += c; } else if (a.commitStatus === "hard") committed += c;
    if (a.commitStatus !== "passed") active++; });
  let t = `Weekly raise rollout — week of ${fmtDay(today)}\n\n`;
  t += `ROUND\n${raise.round || "Round"}: ${fmtUSD(committed)} committed${raise.target ? " of " + fmtUSD(raise.target) : ""} (${fmtUSD(wired)} wired) · ${active} investor${active === 1 ? "" : "s"} in play\n\n`;
  // 13-week cash headline, as last saved from Financials → 13-week cash.
  const c13 = finDoc && finDoc.exists ? ((finDoc.data() || {}).cash13 || {}).summary : null;
  if (c13 && c13.at) {
    t += `CASH — NEXT 13 WEEKS
${fmtUSD(c13.cash)} today${c13.asOf ? " (bank balance " + fmtDay(c13.asOf) + ")" : ""} · lowest ${fmtUSD(c13.low)} week of ${fmtDay(c13.lowWeek)} · ${fmtUSD(c13.end)} in 13 weeks
`;
    t += c13.below ? `Below the ${fmtUSD(c13.buffer)} buffer for ${c13.below} week${c13.below === 1 ? "" : "s"}, starting the week of ${fmtDay(c13.firstBelowWeek)}.

` : `Stays above the ${fmtUSD(c13.buffer)} buffer all 13 weeks.

`;
  }
  const all = tasks.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const byId = {}; all.forEach((x) => { byId[x.id] = x; });
  const line = (x) => `• ${x.title}${x.investorName ? " — " + x.investorName : ""} (${x.ownerName || "unassigned"}${x.due ? ", due " + fmtDay(x.due) : ""})`;
  const m = meetings.docs.length ? meetings.docs[0].data() : null;
  if (m) {
    t += `LAST RAISE SYNC — ${fmtDay(m.date)}${(m.attendees || []).length ? " (" + m.attendees.join(", ") + ")" : ""}\n`;
    if (m.minutes) t += `Minutes:\n${String(m.minutes).slice(0, 2500)}\n`;
    if (m.decisions) t += `Decisions:\n${String(m.decisions).slice(0, 1200)}\n`;
    const acts = (m.actions || []).map((a) => Object.assign({}, a, byId[a.id] || {}));
    if (acts.length) t += `Action items:\n${acts.map((a) => (a.status === "done" ? "✓ " : "") + line(a).slice(2)).map((x) => "• " + x).join("\n")}\n`;
    t += "\n";
  } else {
    t += "LAST RAISE SYNC\nNo meeting logged yet.\n\n";
  }
  const open = all.filter((x) => x.status === "open");
  const overdue = open.filter((x) => x.due && x.due < today);
  const doneWk = all.filter((x) => x.status === "done" && x.doneAt && Date.parse(x.doneAt) >= weekAgo);
  t += `RAISE TASKS\n`;
  if (overdue.length) t += `Overdue (${overdue.length}):\n${overdue.map(line).join("\n")}\n`;
  const rest = open.filter((x) => !(x.due && x.due < today)).sort((a, b) => (a.due || "9").localeCompare(b.due || "9"));
  if (rest.length) t += `Open (${rest.length}):\n${rest.slice(0, 15).map(line).join("\n")}\n`;
  if (doneWk.length) t += `Done this week (${doneWk.length}):\n${doneWk.map(line).join("\n")}\n`;
  if (!open.length && !doneWk.length) t += "Nothing open.\n";
  const items = dr.docs.map((d) => d.data());
  const ready = items.filter((i) => (i.files || []).length).length;
  const weekOut = ymdET(now + 7 * 864e5);
  const dueSoon = items.filter((i) => !(i.files || []).length && i.due && i.due <= weekOut);
  t += `\nDATA ROOM\n${ready} of ${items.length} ready.${dueSoon.length ? " Due by " + fmtDay(weekOut) + ":\n" + dueSoon.map((i) => `• ${i.title} (${i.who === "brad" ? "Brad" : i.who === "both" ? "Brad + Trey" : "Trey"}${i.due < today ? ", overdue" : ""})`).join("\n") : ""}\n`;
  const next = nextRaiseMeeting(raise, now);
  t += `\nNEXT RAISE SYNC\n${next ? fmtDay(next) + (raise.meetTime ? " at " + raise.meetTime : "") + (raise.meetCadence === "biweekly" ? " (every 2 weeks)" : " (weekly)") : "Not scheduled — set it on Fundraise → Meetings."}\n`;
  return { subject: `Raise rollout: ${fmtUSD(committed)}${raise.target ? " of " + fmtUSD(raise.target) : ""} · ${overdue.length} overdue · ${open.length} open`, text: t };
}
async function sendRaiseRollout() {
  const to = await raiseRolloutRecipients();
  const { subject, text } = await raiseRolloutText();
  const mail = await digestSender();
  let sent = 0, notified = 0;
  for (const em of to) {
    if (mail) {
      try { await deliver(mail.creds, mail.sender, { to: em, subject, text }); sent++; continue; }
      catch (e) { logger.error("rollout send failed", em, e && e.message); }
    }
    const u = await db.collection("users").where("email", "==", em).limit(1).get();
    if (!u.empty) { await addNotification({ to: u.docs[0].id, title: "Weekly raise rollout is ready", body: "Open Fundraise → Meetings", link: "s-raise", by: "Weekly email", at: admin.firestore.FieldValue.serverTimestamp() }); notified++; }
  }
  await db.collection("settings").doc("raise").set({ lastRolloutAt: new Date().toISOString() }, { merge: true });
  logger.info(`raise rollout: ${sent} emailed, ${notified} in-app`);
  return { sent, notified, recipients: to.length, mailbox: mail ? mail.creds.email : null };
}
exports.weeklyRaiseRollout = onSchedule({ schedule: "every monday 07:30", timeZone: "America/New_York", region: REGION }, async () => {
  await sendRaiseRollout();
});
// Callable: preview (returns the text) or send now. Finance group only.
exports.raiseRollout = onCall({ region: REGION, timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const em = String((request.auth.token && request.auth.token.email) || "").toLowerCase();
  const me = (await db.collection("users").doc(request.auth.uid).get()).data() || {};
  const allowed = (await raiseRolloutRecipients()).includes(em) || me.role === "superadmin";
  if (!allowed) throw new HttpsError("permission-denied", "The raise rollout is for the finance group.");
  if (request.data && request.data.preview) {
    const r = await raiseRolloutText();
    return Object.assign(r, { recipients: await raiseRolloutRecipients() });
  }
  if (RAISE_OBSERVERS.includes(em)) throw new HttpsError("permission-denied", "View-only — Brad or Trey send the rollout.");
  return sendRaiseRollout();
});
