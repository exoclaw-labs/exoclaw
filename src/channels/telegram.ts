/**
 * Telegram bot adapter — long-polling, no webhook setup needed.
 * Uses claude.send() which sends via tmux keystrokes and reads
 * structured responses from the JSONL session file.
 *
 * Env: TELEGRAM_BOT_TOKEN
 */

import type { SessionBackend } from "../session-backend.js";

let API = "";

export function startTelegram(claude: SessionBackend): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log("warn", "TELEGRAM_BOT_TOKEN not set");
    return;
  }
  API = `https://api.telegram.org/bot${token}`;
  log("info", "Telegram channel enabled");
  poll(claude);
}

async function poll(claude: SessionBackend): Promise<void> {
  let offset = 0;
  while (true) {
    try {
      const res = await fetch(
        `${API}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message"]`,
        { signal: AbortSignal.timeout(35_000) },
      );
      const data = (await res.json()) as { ok: boolean; result: any[] };
      if (!data.ok) { await sleep(5000); continue; }

      for (const u of data.result) {
        offset = u.update_id + 1;
        if (u.message?.text) {
          log("info", `Message from ${u.message.chat.id}: "${u.message.text.slice(0, 50)}"`);
          handleMessage(u.message, claude).catch((e) => log("error", `handleMessage: ${e}`));
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "TimeoutError")) {
        log("error", `Poll error: ${err}`);
        await sleep(5000);
      }
    }
  }
}

async function handleMessage(msg: any, claude: SessionBackend): Promise<void> {
  const chatId = msg.chat.id;
  const prompt = (msg.text || "").trim();
  if (!prompt || prompt.startsWith("/start")) return;

  try {
    // Send typing indicator and refresh every 4s (Telegram typing lasts 5s)
    const sendTyping = () => fetch(`${API}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    }).catch(() => {});
    await sendTyping();
    const typingInterval = setInterval(sendTyping, 4000);

    // Collect response from structured JSONL stream
    const chunks: string[] = [];
    let doneText = "";
    try {
      for await (const ev of claude.send(prompt)) {
        if (ev.type === "chunk") chunks.push(ev.content);
        if (ev.type === "done") doneText = ev.content;
      }
    } finally {
      clearInterval(typingInterval);
    }
    let response = doneText || chunks.join("");

    // Scan for credential leaks before sending
    const { scanForLeaks } = await import("../content-scanner.js");
    const leak = scanForLeaks(response);
    if (leak.leaked) {
      log("warn", `Credential leak blocked in Telegram response: ${leak.reason}`);
      response = "[Response redacted — contained sensitive credentials]";
    }

    if (!response) response = "[No response]";
    log("debug", `Sending ${response.length} chars to chat ${chatId}`);

    for (const chunk of splitMsg(response, 4096)) {
      await fetch(`${API}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, reply_to_message_id: msg.message_id }),
      });
    }
  } catch (err) {
    log("error", `Telegram send failed: ${err}`);
    try {
      await fetch(`${API}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: `Error: ${err}`, reply_to_message_id: msg.message_id }),
      });
    } catch { /* best effort */ }
  }
}

function splitMsg(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  while (text.length > 0) {
    let end = max;
    if (text.length > max) { const nl = text.lastIndexOf("\n", max); if (nl > max * 0.5) end = nl; }
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  return chunks;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "telegram", msg }) + "\n");
}
