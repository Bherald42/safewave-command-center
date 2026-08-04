/**
 * Safewave Command Center — backend functions.
 *
 * Per-user email model: each teammate connects their OWN mailbox (address +
 * app password), stored privately in mail_credentials/{uid} (owner-only rules;
 * the backend reads it via the Admin SDK to send on their behalf).
 *
 *   sendUserEmail — callable: send an email from the signed-in user's own
 *                   address and log it to the CRM account. Human-initiated only.
 *   scanOverdue   — daily: flag stale accounts + SLA-breached tickets into
 *                   nudges/summary for the Pulse "needs attention" feed.
 *
 * Deferred (customer support tickets from a shared sales@ inbox): rebuilt later
 * once that mailbox exists — see BACKEND_SETUP.md.
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

/* ------------------------------------------------------------------ *
 * SEND EMAIL from the signed-in user's own mailbox
 * ------------------------------------------------------------------ */
exports.sendUserEmail = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to send email.");
  const { to, subject, text, accountId, ticketId, auto } = request.data || {};
  if (!to || !text) throw new HttpsError("invalid-argument", "Recipient and message are required.");

  const credSnap = await db.collection("mail_credentials").doc(request.auth.uid).get();
  const creds = credSnap.exists ? credSnap.data() : null;
  if (!creds || !creds.email || !creds.pass || !creds.smtp) {
    throw new HttpsError("failed-precondition", "Connect your email first (Account → Connect email).");
  }

  const nodemailer = require("nodemailer");
  const transport = nodemailer.createTransport({
    host: creds.smtp,
    port: Number(creds.port) || 587,
    secure: Number(creds.port) === 465,
    auth: { user: creds.email, pass: creds.pass },
  });

  try {
    await transport.sendMail({
      from: `"${(creds.name || "").replace(/"/g, "") || creds.email}" <${creds.email}>`,
      to,
      subject: subject || "(no subject)",
      text: (text || "") + signatureText(creds),
      html: buildBrandedEmail(text || "", creds),
    });
  } catch (e) {
    logger.error("sendUserEmail failed", e && e.message);
    throw new HttpsError("internal", "Send failed — check your email address and app password in Connect email.");
  }

  const stamp = new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const line = `${auto ? "🤖 Auto-email" : "✉️ Email"} from ${creds.email} to ${to}: ${text.slice(0, 300)}`;
  if (accountId) {
    const acc = await db.collection("crm_accounts").doc(accountId).get();
    if (acc.exists) {
      const notes = (acc.data().notes || []).slice();
      notes.unshift({ user: creds.email, at: stamp, text: line });
      await acc.ref.set({ notes }, { merge: true });
    }
  }
  if (ticketId) {
    await db.collection("tickets").doc(ticketId).set(
      { lastReplyAt: new Date().toISOString(), lastReplyBy: creds.email, status: "answered" },
      { merge: true }
    );
  }
  return { ok: true };
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

/* helpers */
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
        '<div style="background:#0B0C0E;padding:18px 28px"><span style="font-weight:800;font-size:20px;letter-spacing:-.5px;color:#ffffff">Safewave<span style="color:#4FD8EC">.</span></span></div>' +
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
