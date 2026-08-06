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
  if (!key) throw new HttpsError("failed-precondition", "The assistant isn't connected yet — add an ANTHROPIC_API_KEY secret to enable it.");

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
    "- Money is USD. 'Need follow-up' means an open account with no next step. Red is reserved for life-safety.\n\n" +
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

async function handleShopifyOrder(o) {
  const cust = o.customer || {}, ship = o.shipping_address || {};
  const name = [cust.first_name, cust.last_name].filter(Boolean).join(" ") || ship.name || o.email || "Customer";
  const n = o.name || ("#" + (o.order_number || o.id || ""));
  const id = String(o.id || n).replace(/[^\w-]/g, "") || String(Date.now());
  const rec = {
    n: n, name: name, email: o.email || "", total: Number(o.total_price || 0),
    date: shopShortDate(o.created_at),
    ful: String(o.fulfillment_status || "").toLowerCase() === "fulfilled" ? "FULFILLED" : "UNFULFILLED",
    source: "shopify", at: new Date().toISOString(),
  };
  await db.collection("orders").doc(id).set(rec, { merge: true });
  await db.collection("notifications").add({
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
    await db.collection("notifications").add({
      to: "all", title: "Return requested · " + rec.order, body: (customer || "") + (serial ? " · band " + serial : ""),
      link: "s-stock", by: "Shopify", at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

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

  const accs = await db.collection("crm_accounts").get();
  let sent = 0;
  for (const doc of accs.docs) {
    if (sent >= CAMPAIGN_SENDS_PER_RUN) break;
    const a = doc.data();
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
    if (a.stage === "Won" || a.stage === "Lost") return;
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
  const acc = await db.collection("crm_accounts").doc(accountId).get();
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
  return ds.length ? Math.max.apply(null, ds) : null;
}
