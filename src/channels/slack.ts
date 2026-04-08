/**
 * Slack Events API adapter.
 *
 * Env: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { Context } from "hono";
import type { Claude } from "../claude-sdk.js";

let BOT_TOKEN = "";
let SIGNING_SECRET = "";

export function startSlack(): void {
  BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
  SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
  if (!BOT_TOKEN) log("warn", "SLACK_BOT_TOKEN not set");
  else log("info", "Slack channel enabled");
}

export async function handleSlackEvent(c: Context, claude: Claude): Promise<Response> {
  const body = await c.req.text();
  if (!body) return c.text("Bad request", 400);

  if (SIGNING_SECRET) {
    const ts = c.req.header("x-slack-request-timestamp") || "";
    const sig = c.req.header("x-slack-signature") || "";
    if (!verify(ts, sig, body)) return c.text("Invalid signature", 401);
  }

  const payload = JSON.parse(body);

  if (payload.type === "url_verification") {
    return c.text(payload.challenge, 200);
  }

  // Ack immediately, process in background
  if (payload.type === "event_callback") {
    processEvent(payload.event, claude);
  }
  return c.text("", 200);
}

async function processEvent(event: any, claude: Claude): Promise<void> {
  if (!event || event.bot_id) return;
  if (event.type !== "message" && event.type !== "app_mention") return;

  const prompt = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!prompt) return;

  const channel = event.channel;
  try {
    const chunks: string[] = [];
    let doneText = "";
    for await (const ev of claude.send(prompt)) {
      if (ev.type === "chunk") chunks.push(ev.content);
      if (ev.type === "done") doneText = ev.content;
    }
    let response = doneText || chunks.join("");

    // Scan for credential leaks before sending
    const { scanForLeaks } = await import("../content-scanner.js");
    const leak = scanForLeaks(response);
    if (leak.leaked) {
      log("warn", `Credential leak blocked in Slack response: ${leak.reason}`);
      response = "[Response redacted — contained sensitive credentials]";
    }

    await postMessage(channel, response, event.ts);
  } catch (err) {
    log("error", `Slack message failed: ${err}`);
    await postMessage(channel, `Error: ${err}`, event.ts);
  }
}

async function postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
  if (!BOT_TOKEN) return;
  const body: Record<string, string> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BOT_TOKEN}` },
    body: JSON.stringify(body),
  });
}

function verify(timestamp: string, signature: string, body: string): boolean {
  if (!SIGNING_SECRET || !timestamp || !signature) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp)) > 300) return false;
  const expected = "v0=" + createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex");
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); } catch { return false; }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "slack", msg }) + "\n");
}
