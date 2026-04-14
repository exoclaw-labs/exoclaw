/**
 * Persistent config + secrets store.
 *
 * Config and secrets live in $HOME/.exoclaw/ so they persist across
 * container restarts (via the named volume).
 *
 * - config.json  — non-sensitive settings (model, name, flags, etc.)
 * - secrets.json — channel tokens, API keys (read/write only by this module)
 *
 * The API returns a merged view. On save, it splits secrets out automatically.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const STORE_DIR = join(process.env.HOME || "/home/agent", ".exoclaw");
const CONFIG_PATH = join(STORE_DIR, "config.json");
const SECRETS_PATH = join(STORE_DIR, "secrets.json");

// Keys that are secrets (nested under their parent object)
const SECRET_KEYS = new Set([
  "apiToken",
  "botToken",
  "signingSecret",
  "secret",
  "appToken",
]);

function ensureDir() {
  mkdirSync(STORE_DIR, { recursive: true });
}

function readJson(path: string): Record<string, any> {
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch (err) {
    // File not found is expected on first boot; log parse errors
    if (err instanceof SyntaxError) {
      log("warn", `Failed to parse ${path}: ${err.message}`);
    }
    return {};
  }
}

function writeJson(path: string, data: Record<string, any>) {
  ensureDir();
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Load merged config (config.json + secrets.json overlaid).
 * Falls back to the mounted /app/config.json or env vars if nothing persisted yet.
 */
export function loadConfig(): Record<string, any> {
  ensureDir();

  let config = readJson(CONFIG_PATH);

  // First boot — try the mounted seed config
  if (!config.name) {
    const seedPath = process.env.CONFIG_PATH || "/app/config.json";
    try { config = JSON.parse(readFileSync(seedPath, "utf-8")); }
    catch {
      // Build from env vars
      config = {
        name: process.env.AGENT_NAME || "agent",
        port: parseInt(process.env.PORT || "8080", 10),
        host: process.env.HOST || "0.0.0.0",
        claude: {
          model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
          permissionMode: process.env.PERMISSION_MODE || "bypassPermissions",
          systemPrompt: process.env.SYSTEM_PROMPT,
          mcpServers: {
            "agent-browser": {
              enabled: true,
              type: "stdio",
              command: "npx",
              args: ["agent-browser-mcp"],
            },
            composio: {
              enabled: false,
              type: "http",
              url: "https://connect.composio.dev/mcp",
              headers: { "x-consumer-api-key": "" },
            },
          },
        },
        channels: {
          websocket: { enabled: true },
        },
      };
    }
    // Persist immediately so it survives restart
    writeJson(CONFIG_PATH, config);
  }

  // Overlay secrets
  const secrets = readJson(SECRETS_PATH);
  return mergeSecrets(config, secrets);
}

/**
 * Save config. Splits secrets out into secrets.json, rest into config.json.
 */
export function saveConfig(merged: Record<string, any>) {
  const { config, secrets } = splitSecrets(merged);
  writeJson(CONFIG_PATH, config);
  writeJson(SECRETS_PATH, secrets);
}

/**
 * Merge secrets back into config for API responses.
 */
function mergeSecrets(config: Record<string, any>, secrets: Record<string, any>): Record<string, any> {
  const merged = structuredClone(config);

  // Top-level secrets
  if (secrets.apiToken) merged.apiToken = secrets.apiToken;

  // Channel secrets
  if (secrets.channels) {
    if (!merged.channels) merged.channels = {};
    for (const [name, sec] of Object.entries(secrets.channels as Record<string, any>)) {
      if (!merged.channels[name]) merged.channels[name] = {};
      Object.assign(merged.channels[name], sec);
    }
  }

  return merged;
}

/**
 * Split a merged config into non-secret config + secrets.
 */
function splitSecrets(merged: Record<string, any>): { config: Record<string, any>; secrets: Record<string, any> } {
  const config = structuredClone(merged);
  const secrets: Record<string, any> = {};

  // Top-level
  if (config.apiToken) {
    secrets.apiToken = config.apiToken;
    delete config.apiToken;
  }

  // Channel secrets
  if (config.channels) {
    secrets.channels = {};
    for (const [name, ch] of Object.entries(config.channels as Record<string, any>)) {
      secrets.channels[name] = {};
      for (const key of Object.keys(ch)) {
        if (SECRET_KEYS.has(key)) {
          secrets.channels[name][key] = ch[key];
          delete ch[key];
        }
      }
      if (Object.keys(secrets.channels[name]).length === 0) {
        delete secrets.channels[name];
      }
    }
    if (Object.keys(secrets.channels).length === 0) {
      delete secrets.channels;
    }
  }

  return { config, secrets };
}

const MASK = "••••••";

/**
 * Load config with secrets masked for safe display.
 */
export function loadConfigMasked(): Record<string, any> {
  const full = loadConfig();
  return maskSecrets(full);
}

function maskSecrets(obj: Record<string, any>): Record<string, any> {
  const masked = structuredClone(obj);

  if (masked.apiToken) masked.apiToken = MASK;

  if (masked.channels) {
    for (const ch of Object.values(masked.channels as Record<string, any>)) {
      for (const key of Object.keys(ch)) {
        if (SECRET_KEYS.has(key) && ch[key]) ch[key] = MASK;
      }
    }
  }

  // Mask peer tokens
  if (masked.peers) {
    for (const peer of Object.values(masked.peers as Record<string, any>)) {
      if (peer && peer.token) peer.token = MASK;
    }
  }

  // Mask MCP server env vars and headers that look like keys/tokens
  if (masked.claude?.mcpServers) {
    for (const srv of Object.values(masked.claude.mcpServers as Record<string, any>)) {
      if (srv.env) {
        for (const key of Object.keys(srv.env)) {
          if ((key.includes("KEY") || key.includes("TOKEN") || key.includes("SECRET")) && srv.env[key] && srv.env[key] !== MASK) {
            srv.env[key] = MASK;
          }
        }
      }
      if (srv.headers) {
        for (const key of Object.keys(srv.headers)) {
          if ((key.toLowerCase().includes("key") || key.toLowerCase().includes("token") || key.toLowerCase().includes("auth")) && srv.headers[key] && srv.headers[key] !== MASK) {
            srv.headers[key] = MASK;
          }
        }
      }
    }
  }

  return masked;
}

/**
 * Save config, preserving existing secrets when the value is the mask placeholder.
 */
export function saveConfigSafe(incoming: Record<string, any>) {
  const existing = loadConfig();

  // Restore masked values from existing secrets
  if (incoming.apiToken === MASK) incoming.apiToken = existing.apiToken;

  if (incoming.channels && existing.channels) {
    for (const [name, ch] of Object.entries(incoming.channels as Record<string, any>)) {
      const prev = (existing.channels as Record<string, any>)[name];
      if (!prev) continue;
      for (const key of Object.keys(ch)) {
        if (SECRET_KEYS.has(key) && ch[key] === MASK) {
          ch[key] = prev[key];
        }
      }
    }
  }

  // Restore masked peer tokens
  if (incoming.peers && existing.peers) {
    for (const [name, peer] of Object.entries(incoming.peers as Record<string, any>)) {
      const prev = (existing.peers as Record<string, any>)[name];
      if (!prev) continue;
      if (peer && peer.token === MASK && prev.token) peer.token = prev.token;
    }
  }

  // Restore masked MCP server env vars and headers
  if (incoming.claude?.mcpServers && existing.claude?.mcpServers) {
    for (const [name, srv] of Object.entries(incoming.claude.mcpServers as Record<string, any>)) {
      const prev = (existing.claude.mcpServers as Record<string, any>)[name];
      if (!prev) continue;
      if (srv.env && prev.env) {
        for (const key of Object.keys(srv.env)) {
          if (srv.env[key] === MASK && prev.env[key]) srv.env[key] = prev.env[key];
        }
      }
      if (srv.headers && prev.headers) {
        for (const key of Object.keys(srv.headers)) {
          if (srv.headers[key] === MASK && prev.headers[key]) srv.headers[key] = prev.headers[key];
        }
      }
    }
  }

  saveConfig(incoming);
}

export { CONFIG_PATH, SECRETS_PATH, STORE_DIR, MASK };

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "config-store", msg }) + "\n");
}
