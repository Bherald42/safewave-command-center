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

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

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
