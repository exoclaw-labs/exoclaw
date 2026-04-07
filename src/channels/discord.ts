/**
 * Discord bot adapter — connects via Gateway WebSocket.
 *
 * Env: DISCORD_BOT_TOKEN
 */

import type { Claude } from "../claude.js";

let BOT_TOKEN = "";
const API = "https://discord.com/api/v10";
let botUserId: string | null = null;

export function startDiscord(claude: Claude): void {
  BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
  if (!BOT_TOKEN) {
    log("warn", "DISCORD_BOT_TOKEN not set");
    return;
  }
  log("info", "Discord channel enabled");
  connectGateway(claude).catch((err) => log("error", `Gateway failed: ${err}`));
}

async function connectGateway(claude: Claude): Promise<void> {
  const res = await fetch(`${API}/gateway/bot`, { headers: { authorization: `Bot ${BOT_TOKEN}` } });
  const { url } = (await res.json()) as { url: string };
  const ws = new (await import("ws")).default(`${url}?v=10&encoding=json`);

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let seq: number | null = null;

  ws.on("message", async (data: Buffer) => {
    const { op, t, s, d } = JSON.parse(data.toString());
    if (s) seq = s;

    if (op === 10) {
      heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), d.heartbeat_interval);
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: BOT_TOKEN,
          intents: (1 << 9) | (1 << 12) | (1 << 15),
          properties: { os: "linux", browser: "exoclaw", device: "exoclaw" },
        },
      }));
    }

    if (op === 0 && t === "READY") {
      botUserId = d.user.id;
      log("info", `Connected as ${d.user.username}`);
    }

    if (op === 0 && t === "MESSAGE_CREATE") {
      await handleMessage(d, claude);
    }
  });

  ws.on("close", (code: number) => {
    if (heartbeat) clearInterval(heartbeat);
    log("warn", `Disconnected (${code}), reconnecting...`);
    setTimeout(() => connectGateway(claude), 5000);
  });

  ws.on("error", (err: Error) => log("error", `WS error: ${err.message}`));
}

async function handleMessage(msg: any, claude: Claude): Promise<void> {
  if (msg.author.bot) return;
  const isDM = !msg.guild_id;
  const isMention = msg.mentions?.some((m: any) => m.id === botUserId);
  if (!isDM && !isMention) return;

  let prompt = (msg.content || "").trim();
  if (botUserId) prompt = prompt.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
  if (!prompt) return;

  const ch = msg.channel_id;
  try {
    await fetch(`${API}/channels/${ch}/typing`, { method: "POST", headers: { authorization: `Bot ${BOT_TOKEN}` } });

    let response = await claude.sendAndWait(prompt);

    // Scan for credential leaks before sending
    const { scanForLeaks } = await import("../content-scanner.js");
    const leak = scanForLeaks(response);
    if (leak.leaked) {
      log("warn", `Credential leak blocked in Discord response: ${leak.reason}`);
      response = "[Response redacted — contained sensitive credentials]";
    }

    for (const chunk of splitMsg(response, 2000)) {
      await fetch(`${API}/channels/${ch}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${BOT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ content: chunk, message_reference: { message_id: msg.id } }),
      });
    }
  } catch (err) {
    log("error", `Discord send failed: ${err}`);
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

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "discord", msg }) + "\n");
}
