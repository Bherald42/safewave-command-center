/**
 * Safewave Command Center — backend functions.
 *
 * What this does, once deployed:
 *   1. ingestEmail   — every 5 min, reads the sales@ inbox (IONOS IMAP), turns
 *                      each new message into a support ticket, and, if the sender
 *                      matches a CRM account, logs it as activity on that account.
 *   2. sendReply     — callable from the app: sends a reply from sales@ (IONOS
 *                      SMTP) and logs it to the ticket + CRM account.
 *   3. scanOverdue   — daily, flags stale CRM accounts and SLA-breached tickets
 *                      into nudges/summary for the Pulse "needs attention" feed.
 *
 * Secrets/config needed (see BACKEND_SETUP.md):
 *   IONOS_PASSWORD  (secret)         — the sales@ mailbox password / app password
 *   IONOS_EMAIL     (env, optional)  — defaults to sales@safewavetech.com
 *   IMAP_HOST/SMTP_HOST (env, opt.)  — default imap.ionos.com / smtp.ionos.com
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const IONOS_PASSWORD = defineSecret("IONOS_PASSWORD");
const IONOS_EMAIL = defineString("IONOS_EMAIL", { default: "sales@safewavetech.com" });
const IMAP_HOST = defineString("IMAP_HOST", { default: "imap.ionos.com" });
const SMTP_HOST = defineString("SMTP_HOST", { default: "smtp.ionos.com" });

const REGION = "us-central1";
const SLA_HOURS = { safety: 2, high: 8, medium: 24, low: 72 };
const STALE_DAYS = 30;

/* ------------------------------------------------------------------ *
 * 1. INGEST EMAIL  →  tickets + CRM activity
 * ------------------------------------------------------------------ */
exports.ingestEmail = onSchedule(
  { schedule: "every 5 minutes", region: REGION, secrets: [IONOS_PASSWORD], timeoutSeconds: 120 },
  async () => {
    const { ImapFlow } = require("imapflow");
    const { simpleParser } = require("mailparser");
    const client = new ImapFlow({
      host: IMAP_HOST.value(),
      port: 993,
      secure: true,
      auth: { user: IONOS_EMAIL.value(), pass: IONOS_PASSWORD.value() },
      logger: false,
    });

    let processed = 0;
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Only messages that have not been seen yet.
        for await (const msg of client.fetch({ seen: false }, { source: true, envelope: true })) {
          try {
            const parsed = await simpleParser(msg.source);
            await handleIncoming(parsed);
            await client.messageFlagsAdd(msg.seq, ["\\Seen"], { uid: false });
            processed++;
          } catch (e) {
            logger.error("Failed to process a message", e);
          }
        }
      } finally {
        lock.release();
      }
    } catch (e) {
      logger.error("IMAP connect/ingest failed", e);
    } finally {
      try { await client.logout(); } catch (_) {}
    }
    logger.info(`ingestEmail: processed ${processed} new message(s)`);
    return null;
  }
);

async function handleIncoming(mail) {
  const from = (mail.from && mail.from.value && mail.from.value[0]) || {};
  const fromEmail = (from.address || "").toLowerCase();
  const fromName = from.name || fromEmail || "Unknown sender";
  const subject = (mail.subject || "(no subject)").trim();
  const body = (mail.text || "").trim();
  const messageId = mail.messageId || `${fromEmail}:${subject}:${(mail.date || new Date()).toISOString()}`;
  const ticketId = "EM-" + hash(messageId);

  // Dedupe: skip if we already ingested this message.
  const ref = db.collection("tickets").doc(ticketId);
  if ((await ref.get()).exists) return;

  const severity = classifySeverity(subject, body);
  await ref.set({
    id: ticketId,
    title: subject,
    customer: fromName,
    email: fromEmail,
    channel: "Email",
    product: guessProduct(subject, body),
    sev: severity,
    desc: body.slice(0, 4000),
    status: "open",
    source: "email",
    messageId,
    created: (mail.date || new Date()).toISOString(),
    by: "inbox",
  });

  // Link to a CRM account by sender email, if one exists.
  if (fromEmail) {
    const q = await db.collection("crm_accounts").where("email", "==", fromEmail).limit(1).get();
    if (!q.empty) {
      const acc = q.docs[0];
      const notes = (acc.data().notes || []).slice();
      notes.unshift({
        user: "Inbox",
        at: new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        text: `📧 Email received — "${subject}": ${body.slice(0, 300)}`,
      });
      await acc.ref.set({ notes }, { merge: true });
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. SEND REPLY  (callable from the app; requires human approval click)
 * ------------------------------------------------------------------ */
exports.sendReply = onCall(
  { region: REGION, secrets: [IONOS_PASSWORD] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to send replies.");
    const { to, subject, text, ticketId, accountId, auto } = request.data || {};
    if (!to || !text) throw new HttpsError("invalid-argument", "Recipient and message are required.");

    const nodemailer = require("nodemailer");
    const transport = nodemailer.createTransport({
      host: SMTP_HOST.value(),
      port: 587,
      secure: false, // STARTTLS on 587
      auth: { user: IONOS_EMAIL.value(), pass: IONOS_PASSWORD.value() },
    });

    try {
      await transport.sendMail({
        from: IONOS_EMAIL.value(),
        to,
        subject: subject || "Re: your message to Safewave",
        text,
      });
    } catch (e) {
      logger.error("sendReply SMTP failed", e);
      throw new HttpsError("internal", "Could not send the email — check the mailbox settings.");
    }

    const sender = request.auth.token.email || "team";
    const stamp = new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
    if (ticketId) {
      await db.collection("tickets").doc(ticketId).set(
        { lastReplyAt: new Date().toISOString(), lastReplyBy: sender, status: "answered" },
        { merge: true }
      );
    }
    if (accountId) {
      const acc = await db.collection("crm_accounts").doc(accountId).get();
      if (acc.exists) {
        const notes = (acc.data().notes || []).slice();
        notes.unshift({ user: sender, at: stamp, text: `${auto ? "🤖 Auto-reply" : "✉️ Reply"} sent to ${to}: ${text.slice(0, 300)}` });
        await acc.ref.set({ notes }, { merge: true });
      }
    }
    return { ok: true };
  }
);

/* ------------------------------------------------------------------ *
 * 3. SCAN OVERDUE  →  nudges/summary (drives Pulse "needs attention")
 * ------------------------------------------------------------------ */
exports.scanOverdue = onSchedule(
  { schedule: "every day 13:00", region: REGION },
  async () => {
    const now = Date.now();

    // Stale CRM accounts (not Won/Lost, no activity in STALE_DAYS).
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

    // SLA-breached open tickets.
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
    logger.info(`scanOverdue: ${staleAccounts.length} stale accounts, ${breached.length} breached tickets`);
    return null;
  }
);

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}
function classifySeverity(subject, body) {
  const t = (subject + " " + body).toLowerCase();
  if (/(missed|not vibrat|no alert|didn'?t (go off|alert|vibrate)|emergency|safety|not receiving)/.test(t)) return "safety";
  if (/(refund|broken|won'?t (pair|connect|charge)|urgent|not working|dead)/.test(t)) return "high";
  if (/(question|how do|help|setup|size|exchange)/.test(t)) return "medium";
  return "medium";
}
function guessProduct(subject, body) {
  const t = (subject + " " + body).toLowerCase();
  if (/(app|ios|android|bluetooth|pair|sync)/.test(t)) return "App";
  if (/(firmware|update|version)/.test(t)) return "Firmware";
  return "Band";
}
function pDate(s) {
  if (!s) return null;
  const d = Date.parse(s);
  return isNaN(d) ? null : d;
}
function lastActivity(a) {
  const ds = [];
  (a.notes || []).forEach((n) => { const d = pDate(n.at); if (d) ds.push(d); });
  const dd = pDate(a.date);
  if (dd) ds.push(dd);
  return ds.length ? Math.max.apply(null, ds) : null;
}
