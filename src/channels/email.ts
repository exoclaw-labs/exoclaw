/**
 * Email channel — asynchronous IMAP polling + SMTP sending.
 *
 * Polls an IMAP inbox for new messages, sends them to Claude,
 * and replies via SMTP. Designed for async interaction where
 * response time is measured in minutes, not seconds.
 *
 * Uses shell commands (`curl`) for IMAP/SMTP to avoid adding
 * npm dependencies. Requires `curl` with IMAP/SMTP support.
 *
 * Env:
 *   EMAIL_IMAP_URL       — IMAP server URL (imaps://imap.gmail.com:993)
 *   EMAIL_SMTP_URL       — SMTP server URL (smtps://smtp.gmail.com:465)
 *   EMAIL_USER           — email address
 *   EMAIL_PASSWORD        — app password or OAuth token
 *   EMAIL_POLL_INTERVAL  — polling interval in seconds (default: 60)
 *   EMAIL_ALLOWED_SENDERS — comma-separated allowed sender addresses (optional)
 *
 * Inspired by Hermes's email.py and ZeroClaw's email_channel.rs.
 */

import { execSync } from "child_process";
import type { Claude } from "../claude-sdk.js";
import { scanForLeaks } from "../content-scanner.js";

const IMAP_URL = process.env.EMAIL_IMAP_URL || "";
const SMTP_URL = process.env.EMAIL_SMTP_URL || "";
const USER = process.env.EMAIL_USER || "";
const PASSWORD = process.env.EMAIL_PASSWORD || "";
const POLL_INTERVAL = parseInt(process.env.EMAIL_POLL_INTERVAL || "60") * 1000;
const ALLOWED_SENDERS = (process.env.EMAIL_ALLOWED_SENDERS || "").split(",").filter(Boolean);

let lastSeenUid = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startEmail(claude: Claude): void {
  if (!IMAP_URL || !SMTP_URL || !USER || !PASSWORD) {
    log("warn", "Email channel not configured (missing IMAP/SMTP/USER/PASSWORD env vars)");
    return;
  }

  log("info", `Email channel enabled (user: ${USER}, polling every ${POLL_INTERVAL / 1000}s)`);

  // Initialize last seen UID by checking current mailbox state
  try {
    lastSeenUid = getHighestUid();
    log("info", `Starting from UID ${lastSeenUid}`);
  } catch (err) {
    log("warn", `Failed to get initial UID: ${err}`);
  }

  // Start polling
  poll(claude);
  pollTimer = setInterval(() => poll(claude), POLL_INTERVAL);
}

export function stopEmail(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function poll(claude: Claude): void {
  try {
    const messages = fetchNewMessages();
    for (const msg of messages) {
      if (ALLOWED_SENDERS.length > 0 && !ALLOWED_SENDERS.some(s => msg.from.includes(s))) {
        log("info", `Skipping email from unlisted sender: ${msg.from}`);
        continue;
      }
      handleMessage(msg, claude).catch(err => log("error", `Email handle error: ${err}`));
    }
  } catch (err) {
    log("error", `Email poll error: ${err}`);
  }
}

interface EmailMessage {
  uid: number;
  from: string;
  subject: string;
  body: string;
  messageId: string;
}

function getHighestUid(): number {
  try {
    const result = execSync(
      `curl -s --url "${IMAP_URL}/INBOX" -u "${USER}:${PASSWORD}" --request "SEARCH UNSEEN" 2>/dev/null`,
      { encoding: "utf-8", timeout: 15_000 },
    );
    const uids = result.match(/\d+/g)?.map(Number) || [];
    return uids.length > 0 ? Math.max(...uids) : 0;
  } catch {
    return 0;
  }
}

function fetchNewMessages(): EmailMessage[] {
  const messages: EmailMessage[] = [];

  try {
    // Search for unseen messages
    const searchResult = execSync(
      `curl -s --url "${IMAP_URL}/INBOX" -u "${USER}:${PASSWORD}" --request "SEARCH UNSEEN" 2>/dev/null`,
      { encoding: "utf-8", timeout: 15_000 },
    );

    const uids = searchResult.match(/\d+/g)?.map(Number).filter(u => u > lastSeenUid) || [];
    if (uids.length === 0) return [];

    for (const uid of uids.slice(0, 5)) { // Process max 5 new messages per poll
      try {
        const raw = execSync(
          `curl -s --url "${IMAP_URL}/INBOX;UID=${uid}" -u "${USER}:${PASSWORD}" 2>/dev/null`,
          { encoding: "utf-8", timeout: 15_000 },
        );

        const from = raw.match(/^From:\s*(.+)$/mi)?.[1]?.trim() || "unknown";
        const subject = raw.match(/^Subject:\s*(.+)$/mi)?.[1]?.trim() || "(no subject)";
        const messageId = raw.match(/^Message-ID:\s*(.+)$/mi)?.[1]?.trim() || "";

        // Extract plain text body (simple heuristic: content after empty line)
        const headerEnd = raw.indexOf("\r\n\r\n");
        const body = headerEnd > 0 ? raw.slice(headerEnd + 4).trim() : raw;

        messages.push({ uid, from, subject, body: body.slice(0, 10_000), messageId });
        lastSeenUid = Math.max(lastSeenUid, uid);
      } catch (err) {
        log("warn", `Failed to fetch UID ${uid}: ${err}`);
      }
    }
  } catch (err) {
    log("error", `IMAP fetch error: ${err}`);
  }

  return messages;
}

async function handleMessage(msg: EmailMessage, claude: Claude): Promise<void> {
  log("info", `Email from ${msg.from}: "${msg.subject}"`);

  const prompt = `[Email from ${msg.from}]\nSubject: ${msg.subject}\n\n${msg.body}`;

  try {
    const chunks: string[] = [];
    let doneText = "";
    for await (const ev of claude.send(prompt)) {
      if (ev.type === "chunk") chunks.push(ev.content);
      if (ev.type === "done") doneText = ev.content;
    }
    let response = doneText || chunks.join("");

    // Scan for leaks
    const leak = scanForLeaks(response);
    if (leak.leaked) {
      log("warn", `Credential leak blocked in email response: ${leak.reason}`);
      response = "[Response redacted — contained sensitive credentials]";
    }

    await sendReply(msg, response);
  } catch (err) {
    log("error", `Email response failed: ${err}`);
  }
}

async function sendReply(original: EmailMessage, body: string): Promise<void> {
  const replySubject = original.subject.startsWith("Re:") ? original.subject : `Re: ${original.subject}`;

  // Build RFC 2822 email
  const email = [
    `From: ${USER}`,
    `To: ${original.from}`,
    `Subject: ${replySubject}`,
    original.messageId ? `In-Reply-To: ${original.messageId}` : "",
    original.messageId ? `References: ${original.messageId}` : "",
    `Date: ${new Date().toUTCString()}`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    body,
  ].filter(Boolean).join("\r\n");

  try {
    execSync(
      `curl -s --url "${SMTP_URL}" --mail-from "${USER}" --mail-rcpt "${original.from}" -u "${USER}:${PASSWORD}" -T - 2>/dev/null`,
      { input: email, timeout: 30_000 },
    );
    log("info", `Reply sent to ${original.from}: "${replySubject}"`);
  } catch (err) {
    log("error", `SMTP send failed: ${err}`);
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "email", msg }) + "\n");
}
