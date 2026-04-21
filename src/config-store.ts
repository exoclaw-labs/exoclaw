/**
 * Persistent config store — YAML with !secret tags.
 *
 * Single file: $HOME/.exoclaw/config.yml
 * Secrets are inline with !secret YAML tags (no separate secrets.json).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { Document, Scalar, parse } from "yaml";
import type { ScalarTag } from "yaml";

// ── SecretValue + YAML tag ──

export class SecretValue {
  constructor(public value: string) {}
  toString() { return this.value; }
  toJSON() { return this.value; }
}

const secretTag: ScalarTag = {
  tag: "!secret",
  identify: (value: unknown) => value instanceof SecretValue,
  resolve(value: string) { return new SecretValue(value); },
  createNode(_schema: unknown, value: unknown, _ctx: unknown) {
    const sv = value as SecretValue;
    const node = new Scalar(sv.value);
    node.tag = "!secret";
    return node;
  },
};

export function parseYaml(text: string): Record<string, any> {
  return parse(text, { customTags: [secretTag] }) || {};
}

export function stringifyYaml(obj: Record<string, any>): string {
  const doc = new Document(obj, { customTags: [secretTag] });
  return doc.toString();
}

// ── Secret helpers ──

/** Deep-walk obj, replace SecretValue -> plain string. Returns a new object. */
export function resolveSecrets(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v instanceof SecretValue) {
      out[k] = v.value;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = resolveSecrets(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item instanceof SecretValue ? item.value
          : item && typeof item === "object" ? resolveSecrets(item)
          : item
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Return dot-notation paths for every SecretValue in the object tree. */
export function trackSecretPaths(obj: Record<string, any>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v instanceof SecretValue) {
      paths.push(path);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      paths.push(...trackSecretPaths(v, path));
    }
  }
  return paths;
}

/** Field names that are auto-tagged as secrets when written for the first time. */
export const SECRET_FIELD_HINTS = new Set([
  "apiToken", "botToken", "signingSecret", "secret", "appToken", "token", "apiKey",
]);

/** Deep-walk a plain object, wrap values at secretPaths with SecretValue.
 *  Also auto-tags any field whose name matches SECRET_FIELD_HINTS. */
export function retagSecrets(
  obj: Record<string, any>,
  secretPaths: Set<string>,
  prefix = "",
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v instanceof SecretValue) {
      // Already tagged — pass through as-is
      out[k] = v;
    } else if (typeof v === "string" && (secretPaths.has(path) || SECRET_FIELD_HINTS.has(k))) {
      out[k] = new SecretValue(v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = retagSecrets(v, secretPaths, path);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Paths ──

const STORE_DIR = join(process.env.HOME || "/home/agent", ".exoclaw");
const CONFIG_PATH = join(STORE_DIR, "config.yml");
const LEGACY_CONFIG_PATH = join(STORE_DIR, "config.json");
const LEGACY_SECRETS_PATH = join(STORE_DIR, "secrets.json");

const MASK = "••••••";

function ensureDir() {
  mkdirSync(STORE_DIR, { recursive: true });
}

/** Read config.yml, returning the raw parsed object (SecretValues intact). */
function readConfigRaw(): Record<string, any> {
  try {
    return parseYaml(readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    if (err instanceof SyntaxError) {
      log("warn", `Failed to parse ${CONFIG_PATH}: ${err.message}`);
    }
    return {};
  }
}

/** Write the tagged config object to config.yml. */
function writeConfigRaw(data: Record<string, any>) {
  ensureDir();
  writeFileSync(CONFIG_PATH, stringifyYaml(data));
}

/**
 * Load config. Reads config.yml, resolves !secret tags to plain strings,
 * applies env-var overlays.
 */
export function loadConfig(): Record<string, any> {
  ensureDir();

  // Migration: convert legacy JSON if YAML doesn't exist yet
  if (!existsSync(CONFIG_PATH) && existsSync(LEGACY_CONFIG_PATH)) {
    migrateFromJson();
  }

  let raw = readConfigRaw();

  // First boot — try seed config or build from env
  if (!raw.name) {
    const seedPath = process.env.CONFIG_PATH || "/app/config.json";
    try {
      const seed = JSON.parse(readFileSync(seedPath, "utf-8"));
      raw = migrateShape(seed);
    } catch {
      raw = defaultConfig();
    }
    writeConfigRaw(raw);
  }

  const config = resolveSecrets(raw);

  // Env-var overlays
  const envToken = process.env.EXOCLAW_API_TOKEN;
  if (envToken) config.apiToken = envToken;

  const peersEnv = process.env.EXOCLAW_PEERS;
  if (peersEnv) {
    try {
      const parsed = JSON.parse(peersEnv);
      if (parsed && typeof parsed === "object") {
        config.peers = { ...(config.peers || {}), ...parsed };
      }
    } catch (err) {
      log("warn", `Failed to parse EXOCLAW_PEERS env var: ${err}`);
    }
  }

  return config;
}

/** Save config. Re-tags secrets from the current file, then writes. */
export function saveConfig(merged: Record<string, any>) {
  const currentRaw = readConfigRaw();
  const secretPaths = new Set(trackSecretPaths(currentRaw));
  const tagged = retagSecrets(merged, secretPaths);
  writeConfigRaw(tagged);
}

/** Load config with secrets masked for safe display. */
export function loadConfigMasked(): Record<string, any> {
  const raw = readConfigRaw();
  return maskSecrets(raw);
}

function maskSecrets(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v instanceof SecretValue) {
      out[k] = v.value ? MASK : "";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = maskSecrets(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item instanceof SecretValue ? (item.value ? MASK : "")
          : item && typeof item === "object" ? maskSecrets(item)
          : item
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Save config, preserving existing secrets when the value is the mask placeholder.
 */
export function saveConfigSafe(incoming: Record<string, any>) {
  const existing = loadConfig();
  restoreMasked(incoming, existing);
  saveConfig(incoming);
}

/** Recursively restore masked values from existing config. */
function restoreMasked(incoming: Record<string, any>, existing: Record<string, any>) {
  for (const key of Object.keys(incoming)) {
    if (incoming[key] === MASK && existing[key]) {
      incoming[key] = existing[key];
    } else if (
      incoming[key] && typeof incoming[key] === "object" && !Array.isArray(incoming[key]) &&
      existing[key] && typeof existing[key] === "object"
    ) {
      restoreMasked(incoming[key], existing[key]);
    }
  }
}

// ── Migration ──

/** Migrate config.json + secrets.json -> config.yml */
function migrateFromJson() {
  log("info", "Migrating config.json -> config.yml");
  let config: Record<string, any>;
  try { config = JSON.parse(readFileSync(LEGACY_CONFIG_PATH, "utf-8")); } catch { return; }

  let secrets: Record<string, any> = {};
  try { secrets = JSON.parse(readFileSync(LEGACY_SECRETS_PATH, "utf-8")); } catch { /* no secrets file */ }

  // Merge secrets back
  if (secrets.apiToken) config.apiToken = secrets.apiToken;
  if (secrets.claudeApiToken) config.claudeApiToken = secrets.claudeApiToken;
  if (secrets.channels) {
    if (!config.channels) config.channels = {};
    for (const [name, sec] of Object.entries(secrets.channels as Record<string, any>)) {
      if (!config.channels[name]) config.channels[name] = {};
      Object.assign(config.channels[name], sec);
    }
  }
  if (secrets.tunnel?.token) {
    if (!config.tunnel) config.tunnel = {};
    config.tunnel.token = secrets.tunnel.token;
  }
  if (secrets.embeddings?.apiKey) {
    if (!config.embeddings) config.embeddings = {};
    config.embeddings.apiKey = secrets.embeddings.apiKey;
  }

  // Reshape claude -> session
  const shaped = migrateShape(config);

  writeConfigRaw(shaped);

  // Back up old files
  try { renameSync(LEGACY_CONFIG_PATH, LEGACY_CONFIG_PATH + ".bak"); } catch { /* best effort */ }
  try { renameSync(LEGACY_SECRETS_PATH, LEGACY_SECRETS_PATH + ".bak"); } catch { /* best effort */ }
}

/** Reshape old JSON config (claude key) into new YAML shape (session key).
 *  Tags known secrets with SecretValue. */
function migrateShape(old: Record<string, any>): Record<string, any> {
  const claude = old.claude || {};
  const { model, systemPrompt, mcpServers, permissionMode, agents, allowedTools,
    disallowedTools, thinkingBudget, extraFlags, remoteControl, name: _cName, ...claudeRest } = claude;

  const providerClaude: Record<string, any> = {};
  if (permissionMode) providerClaude.permissionMode = permissionMode;
  if (thinkingBudget !== undefined) providerClaude.thinkingBudget = thinkingBudget;
  if (remoteControl !== undefined) providerClaude.remoteControl = remoteControl;
  if (agents) providerClaude.agents = agents;
  if (allowedTools?.length) providerClaude.allowedTools = allowedTools;
  if (disallowedTools?.length) providerClaude.disallowedTools = disallowedTools;
  if (extraFlags?.length) providerClaude.extraFlags = extraFlags;
  Object.assign(providerClaude, claudeRest);

  const session: Record<string, any> = {
    provider: "claude",
    model: model || "claude-sonnet-4-6",
    providers: { claude: providerClaude },
  };
  if (systemPrompt) session.systemPrompt = systemPrompt;

  const result: Record<string, any> = { ...old };
  delete result.claude;
  delete result.claudeApiToken;
  result.session = session;

  if (mcpServers) result.mcpServers = mcpServers;

  if (old.claudeApiToken) {
    session.providers.claude.apiKey = new SecretValue(old.claudeApiToken);
  }

  return retagSecrets(result, new Set());
}

/** Default config for first boot from env vars. */
function defaultConfig(): Record<string, any> {
  return retagSecrets({
    name: process.env.AGENT_NAME || "agent",
    port: parseInt(process.env.PORT || "8080", 10),
    host: process.env.HOST || "0.0.0.0",
    session: {
      provider: "claude",
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      systemPrompt: process.env.SYSTEM_PROMPT,
      providers: {
        claude: { permissionMode: process.env.PERMISSION_MODE || "bypassPermissions" },
      },
    },
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
    channels: { websocket: { enabled: true } },
  }, new Set());
}

export { CONFIG_PATH, STORE_DIR, MASK };

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "config-store", msg }) + "\n");
}
