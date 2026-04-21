/**
 * WhatsApp Cloud API channel.
 *
 * Receives messages via webhook (GET for verification, POST for events).
 * Sends responses back via the WhatsApp Business API.
 *
 * Env:
 *   WHATSAPP_TOKEN         — permanent access token
 *   WHATSAPP_PHONE_ID      — phone number ID
 *   WHATSAPP_VERIFY_TOKEN  — webhook verification token
 *   WHATSAPP_ALLOWED_NUMBERS — comma-separated allowed phone numbers (optional)
 *
 * Setup:
 *   1. Create a Meta app at developers.facebook.com
 *   2. Add WhatsApp product, get phone number ID + token
 *   3. Configure webhook URL: https://<your-domain>/whatsapp
 *   4. Subscribe to "messages" webhook field
 */

import type { Context } from "hono";
import type { SessionBackend } from "../session-backend.js";
import { scanForLeaks } from "../content-scanner.js";

const TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "exoclaw-verify";
const ALLOWED_NUMBERS = (process.env.WHATSAPP_ALLOWED_NUMBERS || "").split(",").filter(Boolean);
const API = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

export function startWhatsApp(): void {
  if (!TOKEN || !PHONE_ID) {
    log("warn", "WHATSAPP_TOKEN or WHATSAPP_PHONE_ID not set — WhatsApp disabled");
  } else {
    log("info", `WhatsApp channel enabled (phone: ${PHONE_ID})`);
  }
}

/** Handle webhook verification (GET /whatsapp). */
export function handleWhatsAppVerify(c: Context): Response {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log("info", "WhatsApp webhook verified");
    return c.text(challenge || "", 200);
  }
  return c.text("Forbidden", 403);
}

/** Handle incoming webhook events (POST /whatsapp). */
export async function handleWhatsAppEvent(c: Context, claude: SessionBackend): Promise<Response> {
  const body = await c.req.json();

  // Ack immediately
  const entries = body?.entry || [];
  for (const entry of entries) {
    const changes = entry?.changes || [];
    for (const change of changes) {
      if (change.field !== "messages") continue;
      const messages = change.value?.messages || [];
      for (const msg of messages) {
        // Process in background
        processMessage(msg, claude);
      }
    }
  }

  return c.json({ status: "ok" });
}

async function processMessage(msg: any, claude: SessionBackend): Promise<void> {
  if (!msg || msg.type !== "text" || !msg.text?.body) return;

  const from = msg.from;    // sender phone number
  const text = msg.text.body;
  const messageId = msg.id;

  // Optional: restrict to allowed numbers
  if (ALLOWED_NUMBERS.length > 0 && !ALLOWED_NUMBERS.includes(from)) {
    log("warn", `Rejected message from unlisted number: ${from}`);
    return;
  }

  log("info", `Message from ${from}: ${text.slice(0, 50)}...`);

  // Mark as read
  await sendReadReceipt(messageId);

  try {
    // Collect full response
    let fullText = "";
    for await (const event of claude.send(text)) {
      if (event.type === "chunk") fullText += event.content;
      if (event.type === "done") fullText = event.content || fullText;
    }

    // Scan for leaks
    const leak = scanForLeaks(fullText);
    if (leak.leaked) {
      log("warn", `Credential leak blocked in WhatsApp response: ${leak.reason}`);
      fullText = "[Response redacted — contained sensitive credentials]";
    }

    // WhatsApp has a 4096 char limit per message
    for (const chunk of splitMsg(fullText, 4096)) {
      await sendTextMessage(from, chunk);
    }
  } catch (err) {
    log("error", `WhatsApp response failed: ${err}`);
    await sendTextMessage(from, `Sorry, an error occurred: ${String(err).slice(0, 200)}`);
  }
}

async function sendTextMessage(to: string, text: string): Promise<void> {
  if (!TOKEN || !PHONE_ID) return;
  await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

async function sendReadReceipt(messageId: string): Promise<void> {
  if (!TOKEN || !PHONE_ID) return;
  try {
    await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
  } catch { /* intentional */ }
}

function splitMsg(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, max));
    remaining = remaining.slice(max);
  }
  return chunks;
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "whatsapp", msg }) + "\n");
}
