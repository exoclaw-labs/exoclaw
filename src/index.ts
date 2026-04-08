#!/usr/bin/env node

import { serve } from "@hono/node-server";
import type { Server } from "http";
import { loadConfig } from "./config-store.js";
import { createApp, type GatewayConfig } from "./server.js";
import { startDiscord } from "./channels/discord.js";
import { startTelegram } from "./channels/telegram.js";
import { setupWebSocket } from "./channels/websocket.js";
import { setupTerminal } from "./channels/terminal.js";

const config = loadConfig() as GatewayConfig;

// Pass the gateway name into the claude config so it's used for --name and remote control
if (config.name && config.claude) {
  config.claude.name = config.name;
}

// Inject channel secrets into process.env so channel modules can read them.
// Secrets are merged into config by loadConfig() but channel modules read env vars.
const channels: Record<string, any> = config.channels || {};
if (channels.telegram?.botToken && !process.env.TELEGRAM_BOT_TOKEN) {
  process.env.TELEGRAM_BOT_TOKEN = channels.telegram.botToken;
}
if (channels.discord?.botToken && !process.env.DISCORD_BOT_TOKEN) {
  process.env.DISCORD_BOT_TOKEN = channels.discord.botToken;
}
if (channels.slack?.botToken && !process.env.SLACK_BOT_TOKEN) {
  process.env.SLACK_BOT_TOKEN = channels.slack.botToken;
}
if (channels.slack?.appToken && !process.env.SLACK_APP_TOKEN) {
  process.env.SLACK_APP_TOKEN = channels.slack.appToken;
}

const { app, claude, sessionDb, sessionIndexer, scheduler, rateLimiter, estop, channelHealth } = createApp(config);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log(`"${config.name}" listening on http://${info.address}:${info.port}`);
});

if (channels.discord?.enabled) {
  channelHealth.register("discord");
  startDiscord(claude);
  channelHealth.reportConnected("discord");
}
if (channels.telegram?.enabled) {
  channelHealth.register("telegram");
  startTelegram(claude);
  channelHealth.reportConnected("telegram");
}
if (channels.websocket?.enabled) {
  channelHealth.register("websocket");
  setupWebSocket(server as unknown as Server, claude, config.apiToken, estop);
  channelHealth.reportConnected("websocket");
}
channelHealth.register("terminal");
setupTerminal(server as unknown as Server, config.apiToken);
channelHealth.reportConnected("terminal");

const shutdown = () => {
  log("Shutting down");
  scheduler.stop();
  rateLimiter.stop();
  sessionIndexer.stop();
  sessionDb.close();
  claude.close();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", () => { try { claude.close(); } catch { /* best effort */ } });

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level: "info", component: "main", msg }) + "\n");
}
