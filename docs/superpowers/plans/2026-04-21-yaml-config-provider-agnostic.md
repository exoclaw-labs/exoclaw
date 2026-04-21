# YAML Config + Provider-Agnostic Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the gateway from a Claude-specific JSON config to a provider-agnostic YAML config with `!secret` tags, and introduce a `SessionBackend` adapter interface.

**Architecture:** Single `config.yml` file replaces `config.json` + `secrets.json`. The `claude` config namespace becomes `session` with a `provider` field and provider-specific sub-keys under `providers.*`. MCP servers are hoisted to top-level. A `SessionBackend` interface decouples the gateway from any specific LLM provider.

**Tech Stack:** TypeScript, `yaml` npm package (custom tags), Zod (schema validation), Vitest (tests), Vue 3 (frontend)

**Spec:** `docs/superpowers/specs/2026-04-21-yaml-config-provider-agnostic-design.md`

---

### Task 1: Add `yaml` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the yaml package**

Run: `pnpm add yaml`

- [ ] **Step 2: Verify installation**

Run: `pnpm ls yaml`
Expected: `yaml` appears in the dependency list.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add yaml dependency for config migration"
```

---

### Task 2: Config store — YAML read/write with `!secret` tag

**Files:**
- Create: `src/config-store.test.ts`
- Modify: `src/config-store.ts`

This is the core of the migration. We rewrite config-store.ts to use YAML with a custom `!secret` tag, while keeping the same exported API (`loadConfig`, `saveConfig`, `saveConfigSafe`, `loadConfigMasked`, `STORE_DIR`, `CONFIG_PATH`, `MASK`).

- [ ] **Step 1: Write tests for SecretValue and YAML serialization**

Create `src/config-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We'll set HOME before importing so config-store uses our temp dir
const TEST_HOME = join(tmpdir(), `exoclaw-test-${Date.now()}`);

describe("config-store (YAML)", () => {
  beforeEach(() => {
    process.env.HOME = TEST_HOME;
    mkdirSync(join(TEST_HOME, ".exoclaw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("should be importable", async () => {
    // Dynamic import so HOME is set first
    const mod = await import("./config-store.js");
    expect(mod.loadConfig).toBeDefined();
    expect(mod.saveConfig).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (baseline)**

Run: `pnpm test -- src/config-store.test.ts`
Expected: PASS (just verifying import works)

- [ ] **Step 3: Write test for YAML round-trip with !secret**

Add to `src/config-store.test.ts`:

```typescript
import { parseYaml, stringifyYaml, SecretValue } from "./config-store.js";

describe("YAML !secret tag", () => {
  it("should parse !secret tags into SecretValue instances", () => {
    const yaml = `
name: agent
apiToken: !secret abc123
channels:
  slack:
    botToken: !secret xoxb-test
`;
    const result = parseYaml(yaml);
    expect(result.name).toBe("agent");
    expect(result.apiToken).toBeInstanceOf(SecretValue);
    expect(result.apiToken.value).toBe("abc123");
    expect(result.channels.slack.botToken).toBeInstanceOf(SecretValue);
    expect(result.channels.slack.botToken.value).toBe("xoxb-test");
  });

  it("should stringify SecretValue back to !secret tags", () => {
    const obj = {
      name: "agent",
      apiToken: new SecretValue("abc123"),
    };
    const yaml = stringifyYaml(obj);
    expect(yaml).toContain("apiToken: !secret abc123");
    expect(yaml).not.toContain("SecretValue");
  });

  it("should round-trip without data loss", () => {
    const original = {
      name: "agent",
      port: 8080,
      apiToken: new SecretValue("tok123"),
      session: {
        provider: "claude",
        model: "claude-sonnet-4-6",
        providers: {
          openai: { apiKey: new SecretValue("sk-test") },
        },
      },
    };
    const yaml = stringifyYaml(original);
    const parsed = parseYaml(yaml);
    expect(parsed.name).toBe("agent");
    expect(parsed.port).toBe(8080);
    expect(parsed.apiToken).toBeInstanceOf(SecretValue);
    expect(parsed.apiToken.value).toBe("tok123");
    expect(parsed.session.provider).toBe("claude");
    expect(parsed.session.providers.openai.apiKey).toBeInstanceOf(SecretValue);
    expect(parsed.session.providers.openai.apiKey.value).toBe("sk-test");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test -- src/config-store.test.ts`
Expected: FAIL — `parseYaml` and `stringifyYaml` are not exported yet.

- [ ] **Step 5: Implement SecretValue, parseYaml, stringifyYaml**

Add to the top of `src/config-store.ts` (keep existing code for now — we'll swap the internals next):

```typescript
import { Document, parse, stringify, type SchemaOptions } from "yaml";
import type { CreateNodeContext } from "yaml";

export class SecretValue {
  constructor(public value: string) {}
  toString() { return this.value; }
  toJSON() { return this.value; }
}

const secretTag: SchemaOptions["customTags"] = [
  {
    tag: "!secret",
    identify: (value: unknown) => value instanceof SecretValue,
    resolve(value: string) {
      return new SecretValue(value);
    },
    createNode(schema: unknown, value: SecretValue, ctx: CreateNodeContext) {
      const node = ctx.createNode(value.value);
      node.tag = "!secret";
      return node;
    },
  },
];

export function parseYaml(text: string): Record<string, any> {
  return parse(text, { customTags: secretTag }) || {};
}

export function stringifyYaml(obj: Record<string, any>): string {
  return stringify(obj, { customTags: secretTag });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test -- src/config-store.test.ts`
Expected: PASS

- [ ] **Step 7: Write test for resolveSecrets and trackSecretPaths**

Add to `src/config-store.test.ts`:

```typescript
import { resolveSecrets, trackSecretPaths } from "./config-store.js";

describe("resolveSecrets", () => {
  it("should replace SecretValue with plain strings", () => {
    const obj = {
      name: "agent",
      apiToken: new SecretValue("tok"),
      channels: { slack: { botToken: new SecretValue("xoxb") } },
    };
    const resolved = resolveSecrets(obj);
    expect(resolved.apiToken).toBe("tok");
    expect(resolved.channels.slack.botToken).toBe("xoxb");
  });
});

describe("trackSecretPaths", () => {
  it("should return dot-notation paths of all SecretValue fields", () => {
    const obj = {
      name: "agent",
      apiToken: new SecretValue("tok"),
      session: {
        providers: {
          openai: { apiKey: new SecretValue("sk") },
        },
      },
    };
    const paths = trackSecretPaths(obj);
    expect(paths).toContain("apiToken");
    expect(paths).toContain("session.providers.openai.apiKey");
    expect(paths).not.toContain("name");
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `pnpm test -- src/config-store.test.ts`
Expected: FAIL

- [ ] **Step 9: Implement resolveSecrets and trackSecretPaths**

Add to `src/config-store.ts`:

```typescript
/** Deep-walk obj, replace SecretValue → plain string. Returns a new object. */
export function resolveSecrets(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v instanceof SecretValue) {
      out[k] = v.value;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = resolveSecrets(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item instanceof SecretValue
          ? item.value
          : item && typeof item === "object"
            ? resolveSecrets(item)
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
```

- [ ] **Step 10: Run test to verify it passes**

Run: `pnpm test -- src/config-store.test.ts`
Expected: PASS

- [ ] **Step 11: Write test for retagSecrets**

Add to `src/config-store.test.ts`:

```typescript
import { retagSecrets } from "./config-store.js";

describe("retagSecrets", () => {
  it("should wrap values at known secret paths with SecretValue", () => {
    const plain = {
      apiToken: "tok",
      name: "agent",
      session: { providers: { openai: { apiKey: "sk" } } },
    };
    const secretPaths = new Set(["apiToken", "session.providers.openai.apiKey"]);
    const tagged = retagSecrets(plain, secretPaths);
    expect(tagged.apiToken).toBeInstanceOf(SecretValue);
    expect(tagged.apiToken.value).toBe("tok");
    expect(tagged.name).toBe("agent");
    expect(tagged.session.providers.openai.apiKey).toBeInstanceOf(SecretValue);
  });

  it("should auto-tag fields matching SECRET_FIELD_HINTS", () => {
    const plain = {
      channels: { discord: { botToken: "new-token" } },
    };
    const secretPaths = new Set<string>(); // no existing secrets
    const tagged = retagSecrets(plain, secretPaths);
    expect(tagged.channels.discord.botToken).toBeInstanceOf(SecretValue);
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `pnpm test -- src/config-store.test.ts`
Expected: FAIL

- [ ] **Step 13: Implement retagSecrets**

Add to `src/config-store.ts`:

```typescript
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
    if (typeof v === "string" && (secretPaths.has(path) || SECRET_FIELD_HINTS.has(k))) {
      out[k] = new SecretValue(v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = retagSecrets(v, secretPaths, path);
    } else {
      out[k] = v;
    }
  }
  return out;
}
```

- [ ] **Step 14: Run test to verify it passes**

Run: `pnpm test -- src/config-store.test.ts`
Expected: PASS

- [ ] **Step 15: Commit core YAML utilities**

```bash
git add src/config-store.ts src/config-store.test.ts
git commit -m "feat: add YAML !secret tag utilities for config store"
```

---

### Task 3: Config store — replace JSON read/write with YAML

**Files:**
- Modify: `src/config-store.ts`
- Modify: `src/config-store.test.ts`

Now swap the internal read/write to use YAML while keeping the same public API.

- [ ] **Step 1: Write test for loadConfig from config.yml**

Add to `src/config-store.test.ts`:

```typescript
describe("loadConfig from YAML", () => {
  it("should load config.yml and resolve secrets", async () => {
    const yml = `
name: agent
port: 8080
host: 0.0.0.0
apiToken: !secret test-token
session:
  provider: claude
  model: claude-sonnet-4-6
  providers:
    claude:
      permissionMode: bypassPermissions
channels:
  websocket:
    enabled: true
`;
    writeFileSync(join(TEST_HOME, ".exoclaw", "config.yml"), yml);

    // Re-import to pick up new HOME
    const { loadConfig: load } = await import("./config-store.js");
    const config = load();
    expect(config.name).toBe("agent");
    expect(config.port).toBe(8080);
    expect(config.apiToken).toBe("test-token"); // resolved, not SecretValue
    expect(config.session.provider).toBe("claude");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/config-store.test.ts`
Expected: FAIL — loadConfig still reads JSON.

Note: Because config-store.ts uses module-level constants for paths, tests that re-import may need `vi.resetModules()` between tests. If tests fail due to cached module state, add a `beforeEach(() => { vi.resetModules(); })` and use dynamic imports.

- [ ] **Step 3: Rewrite config-store.ts internals**

Replace the JSON-based internals. Key changes:
- `CONFIG_PATH` changes from `config.json` to `config.yml`
- Remove `SECRETS_PATH` (no more secrets.json)
- `readYaml()` / `writeYamlFile()` replace `readJson()` / `writeJson()`
- `loadConfig()` reads config.yml, resolves secrets, applies env overlays
- `saveConfig()` retags secrets and writes config.yml
- `loadConfigMasked()` replaces SecretValue with MASK before resolving
- `saveConfigSafe()` restores masked values from disk, retags, writes
- Remove `splitSecrets()`, `mergeSecrets()`, `SECRET_KEYS`
- Export `CONFIG_PATH` (now points to `.yml`), `STORE_DIR`, `MASK`

The full rewrite of `src/config-store.ts`:

```typescript
/**
 * Persistent config store — YAML with !secret tags.
 *
 * Single file: $HOME/.exoclaw/config.yml
 * Secrets are inline with !secret YAML tags (no separate secrets.json).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { parse, stringify } from "yaml";
import type { SchemaOptions, CreateNodeContext } from "yaml";

// ── SecretValue + YAML tag ──

export class SecretValue {
  constructor(public value: string) {}
  toString() { return this.value; }
  toJSON() { return this.value; }
}

const secretTag: SchemaOptions["customTags"] = [
  {
    tag: "!secret",
    identify: (value: unknown) => value instanceof SecretValue,
    resolve(value: string) { return new SecretValue(value); },
    createNode(schema: unknown, value: SecretValue, ctx: CreateNodeContext) {
      const node = ctx.createNode(value.value);
      node.tag = "!secret";
      return node;
    },
  },
];

export function parseYaml(text: string): Record<string, any> {
  return parse(text, { customTags: secretTag }) || {};
}

export function stringifyYaml(obj: Record<string, any>): string {
  return stringify(obj, { customTags: secretTag });
}

// ── Secret helpers ──

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

export const SECRET_FIELD_HINTS = new Set([
  "apiToken", "botToken", "signingSecret", "secret", "appToken", "token", "apiKey",
]);

export function retagSecrets(
  obj: Record<string, any>,
  secretPaths: Set<string>,
  prefix = "",
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string" && (secretPaths.has(path) || SECRET_FIELD_HINTS.has(k))) {
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

/** Migrate config.json + secrets.json → config.yml */
function migrateFromJson() {
  log("info", "Migrating config.json → config.yml");
  let config: Record<string, any> = {};
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

  // Reshape claude → session
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
  // Spread any unknown claude fields into the provider block
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

  // Hoist mcpServers to top level
  if (mcpServers) result.mcpServers = mcpServers;

  // Move claudeApiToken into provider
  if (old.claudeApiToken) {
    session.providers.claude.apiKey = new SecretValue(old.claudeApiToken);
  }

  // Tag known secrets
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/config-store.test.ts`
Expected: All PASS

- [ ] **Step 5: Write test for JSON → YAML migration**

Add to `src/config-store.test.ts`:

```typescript
describe("migration from JSON", () => {
  it("should migrate config.json + secrets.json to config.yml", async () => {
    const configJson = {
      name: "greg",
      port: 8080,
      host: "0.0.0.0",
      claude: {
        model: "claude-sonnet-4-6",
        permissionMode: "bypassPermissions",
        systemPrompt: "Be helpful",
        mcpServers: { "agent-browser": { enabled: true, type: "stdio", command: "npx", args: ["agent-browser-mcp"] } },
        thinkingBudget: 10000,
        remoteControl: true,
      },
      channels: { websocket: { enabled: true }, slack: { enabled: false } },
    };
    const secretsJson = {
      apiToken: "secret-tok",
      channels: { slack: { botToken: "xoxb-real" } },
    };

    const storeDir = join(TEST_HOME, ".exoclaw");
    writeFileSync(join(storeDir, "config.json"), JSON.stringify(configJson));
    writeFileSync(join(storeDir, "secrets.json"), JSON.stringify(secretsJson));

    const { loadConfig: load } = await import("./config-store.js");
    const config = load();

    // Shape changed
    expect(config.session).toBeDefined();
    expect(config.claude).toBeUndefined();
    expect(config.session.provider).toBe("claude");
    expect(config.session.model).toBe("claude-sonnet-4-6");
    expect(config.session.systemPrompt).toBe("Be helpful");
    expect(config.session.providers.claude.permissionMode).toBe("bypassPermissions");
    expect(config.session.providers.claude.thinkingBudget).toBe(10000);
    expect(config.session.providers.claude.remoteControl).toBe(true);

    // mcpServers hoisted
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers["agent-browser"].enabled).toBe(true);

    // Secrets merged in
    expect(config.apiToken).toBe("secret-tok");
    expect(config.channels.slack.botToken).toBe("xoxb-real");

    // YAML file exists, JSON backed up
    expect(existsSync(join(storeDir, "config.yml"))).toBe(true);
    expect(existsSync(join(storeDir, "config.json.bak"))).toBe(true);
    expect(existsSync(join(storeDir, "secrets.json.bak"))).toBe(true);

    // YAML file contains !secret tags
    const yamlContent = readFileSync(join(storeDir, "config.yml"), "utf-8");
    expect(yamlContent).toContain("!secret");
  });
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test -- src/config-store.test.ts`
Expected: PASS (migration logic is already implemented)

- [ ] **Step 7: Write test for saveConfigSafe mask restoration**

Add to `src/config-store.test.ts`:

```typescript
describe("saveConfigSafe", () => {
  it("should preserve secrets when masked values are sent back", async () => {
    const yml = `
name: agent
apiToken: !secret real-secret
channels:
  slack:
    enabled: true
    botToken: !secret xoxb-real
`;
    writeFileSync(join(TEST_HOME, ".exoclaw", "config.yml"), yml);

    const { loadConfigMasked: masked, saveConfigSafe: saveSafe, loadConfig: load } =
      await import("./config-store.js");

    const maskedConfig = masked();
    expect(maskedConfig.apiToken).toBe("••••••");

    // Save the masked config back (simulating API PUT)
    saveSafe(maskedConfig);

    // Real secrets should be preserved
    const reloaded = load();
    expect(reloaded.apiToken).toBe("real-secret");
    expect(reloaded.channels.slack.botToken).toBe("xoxb-real");
  });
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test -- src/config-store.test.ts`
Expected: PASS

- [ ] **Step 9: Commit config store rewrite**

```bash
git add src/config-store.ts src/config-store.test.ts
git commit -m "feat: rewrite config-store to use YAML with !secret tags

Replaces config.json + secrets.json with a single config.yml file.
Secrets are inline with !secret YAML custom tags. Auto-migrates
legacy JSON config on first boot."
```

---

### Task 4: Update schemas.ts

**Files:**
- Modify: `src/schemas.ts`

- [ ] **Step 1: Replace ClaudeConfigSchema with SessionConfigSchema**

Replace `ClaudeConfigSchema` and update `GatewayConfigSchema` in `src/schemas.ts`:

```typescript
// Replace the ClaudeConfigSchema block with:
export const SessionConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  systemPrompt: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  providers: z.record(z.record(z.unknown())).optional(),
}).passthrough();
```

In `GatewayConfigSchema`, change:
- `claude: ClaudeConfigSchema` → `session: SessionConfigSchema`
- Add `mcpServers: z.record(McpServerDefSchema).optional()` at top level
- Remove `claudeApiToken` field

- [ ] **Step 2: Verify types compile**

Run: `pnpm build`
Expected: Type errors in downstream files (server.ts, claude-sdk.ts, index.ts) — this is expected and we'll fix them in the next tasks. The schemas themselves should parse cleanly.

- [ ] **Step 3: Commit**

```bash
git add src/schemas.ts
git commit -m "feat: replace ClaudeConfigSchema with SessionConfigSchema

mcpServers hoisted to top-level, claude key replaced by session
with provider field and providers.* sub-keys."
```

---

### Task 5: Update claude-sdk.ts — new config shape + remove .mcp.json sync

**Files:**
- Modify: `src/claude-sdk.ts`

- [ ] **Step 1: Replace ClaudeConfig with SessionConfig**

In `src/claude-sdk.ts`, replace the `ClaudeConfig` interface and update the `Claude` class.

Replace the `ClaudeConfig` interface (lines ~58-68):

```typescript
// Replace ClaudeConfig interface with:
export interface SessionConfig {
  provider: string;
  model: string;
  systemPrompt?: string;
  maxTurns?: number;
  providers?: Record<string, Record<string, any>>;
}

// Add a helper to read claude-specific provider config:
function claudeProvider(config: SessionConfig): Record<string, any> {
  return config.providers?.claude || {};
}
```

Update the `Claude` class constructor (line ~109):

```typescript
// Old:
constructor(config: ClaudeConfig) {
  this.config = config;
// New:
constructor(config: SessionConfig, public mcpServers: Record<string, McpServerDef> = {}) {
  this.config = config;
```

Update the config field type (line ~78):

```typescript
// Old:
private config: ClaudeConfig;
// New:
private config: SessionConfig;
```

Note: `SessionConfig` and `McpServerDef` stay in `claude-sdk.ts` for now. They'll be moved to `session-backend.ts` in Task 10.

- [ ] **Step 2: Update buildQueryOptions to read from providers.claude**

In `buildQueryOptions()`:
- MCP servers come from `this.mcpServers` instead of `this.config.mcpServers`
- `permissionMode` comes from `claudeProvider(this.config).permissionMode`
- `agents` comes from `claudeProvider(this.config).agents`
- `allowedTools` / `disallowedTools` come from `claudeProvider(this.config)`
- `thinkingBudget` comes from `claudeProvider(this.config).thinkingBudget`
- `this.config.name` — read from a `name` field we pass through, or keep reading from the session config

The updated `buildQueryOptions`:

```typescript
private buildQueryOptions(): Options {
  const cp = claudeProvider(this.config);
  const mcpServers: Record<string, McpServerConfig> = {};

  if (this.gatewayMcpServer) {
    mcpServers["exoclaw-gateway"] = this.gatewayMcpServer;
  }

  for (const [name, def] of Object.entries(this.mcpServers)) {
    if (def.enabled === false) continue;
    if (def.type === "http" && def.url) {
      mcpServers[name] = { type: "http", url: def.url, headers: def.headers };
    } else if (def.type === "sse" && def.url) {
      mcpServers[name] = { type: "sse", url: def.url, headers: def.headers };
    } else if (def.command) {
      mcpServers[name] = { type: "stdio", command: def.command, args: def.args, env: def.env };
    }
  }

  const options: Options = {
    model: this.config.model,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    mcpServers,
    maxTurns: this.config.maxTurns ?? 25,
    cwd: join(process.env.HOME || "/home/agent", "workspace"),
    settingSources: ["project", "local"],
    env: { ...process.env } as Record<string, string>,
  };

  if (this._sessionId) options.resume = this._sessionId;
  if (this.config.systemPrompt) {
    options.systemPrompt = { type: "preset", preset: "claude_code", append: this.config.systemPrompt };
  }
  if (cp.agents && Object.keys(cp.agents).length > 0) options.agents = cp.agents;
  if (cp.allowedTools?.length) options.allowedTools = cp.allowedTools;
  if (cp.disallowedTools?.length) options.disallowedTools = cp.disallowedTools;
  if (cp.thinkingBudget !== undefined) {
    options.thinking = cp.thinkingBudget === 0
      ? { type: "disabled" }
      : { type: "enabled", budgetTokens: cp.thinkingBudget };
  }
  if (this._name) {
    options.extraArgs = { ...options.extraArgs, name: this._name, "remote-control-session-name-prefix": this._name };
  }

  return options;
}
```

- [ ] **Step 3: Delete writeMcpConfig entirely**

Remove the `writeMcpConfig()` method (lines ~139-180) and the `execSync` / `unlinkSync` imports it uses (if no other code needs them).

- [ ] **Step 4: Update start() — remove writeMcpConfig call**

```typescript
start(): void {
  this._alive = true;
  this.loadSavedSessionId();
  // writeMcpConfig call removed — gateway passes MCP servers via SDK options
  if (USE_V2) this.initV2Session();
  log("info", `Claude SDK session manager started (mode=${USE_V2 ? "v2" : "stable"})`);
}
```

- [ ] **Step 5: Update updateConfig()**

```typescript
updateConfig(config: SessionConfig, mcpServers?: Record<string, McpServerDef>): void {
  this.config = config;
  if (mcpServers) this.mcpServers = mcpServers;
  // No more writeMcpConfig — MCP servers are passed through SDK options per query
  log("info", `Config updated: model=${config.model}`);
}
```

- [ ] **Step 6: Add a name setter for gateway name injection**

```typescript
private _name: string | null = null;
set name(n: string) { this._name = n; }
```

- [ ] **Step 7: Verify the file compiles in isolation**

Run: `pnpm exec tsc --noEmit src/claude-sdk.ts 2>&1 | head -20`

This will show errors from downstream files, but `claude-sdk.ts` itself should have no internal errors. If there are import issues from removed exports (`ClaudeConfig`), note them — they get fixed in the next task.

- [ ] **Step 8: Commit**

```bash
git add src/claude-sdk.ts
git commit -m "feat: update claude-sdk to accept SessionConfig, remove .mcp.json sync

MCP servers now passed via constructor arg instead of config.claude.mcpServers.
writeMcpConfig() deleted — gateway passes servers through SDK options only."
```

---

### Task 6: Update server.ts — adapt all config.claude references

**Files:**
- Modify: `src/server.ts`

This is the largest file change. Every `config.claude` reference becomes `config.session`, and `config.claude.mcpServers` becomes `config.mcpServers`.

- [ ] **Step 1: Update imports and GatewayConfig interface**

In `src/server.ts`:

Change import:
```typescript
// Old:
import { Claude, type ClaudeConfig, type McpServerDef } from "./claude-sdk.js";
// New:
import { Claude, type SessionConfig, type McpServerDef } from "./claude-sdk.js";
```

Update `GatewayConfig` interface:
```typescript
export interface GatewayConfig {
  name: string;
  port: number;
  host: string;
  apiToken?: string;
  setupComplete?: boolean;
  browserTool?: "browser-use" | "agent-browser" | "none";
  session: SessionConfig;                          // was: claude: ClaudeConfig
  mcpServers?: Record<string, McpServerDef>;       // hoisted from claude.mcpServers
  channels: {
    slack?: { enabled: boolean };
    discord?: { enabled: boolean };
    telegram?: { enabled: boolean };
    websocket?: { enabled: boolean };
    whatsapp?: { enabled: boolean };
  };
  selfImprovement?: SelfImprovementConfig;
  cron?: Partial<CronConfig>;
  rateLimit?: Partial<RateLimitConfig>;
  audit?: { enabled?: boolean; retentionDays?: number };
  embeddings?: Partial<EmbeddingConfig>;
  budget?: Partial<BudgetConfig>;
  queue?: Partial<QueueConfig>;
  tunnel?: Partial<TunnelCfg>;
  peers?: Record<string, PeerConfig>;
}
```

- [ ] **Step 2: Update createApp() — peer translation and Claude instantiation**

```typescript
export function createApp(config: GatewayConfig) {
  // Translate peers into top-level mcpServers
  if (config.peers) {
    if (!config.mcpServers) config.mcpServers = {};
    for (const [peerName, peer] of Object.entries(config.peers)) {
      if (peer.enabled === false) continue;
      const key = `peer-${peerName}`;
      const headers: Record<string, string> = {};
      if (peer.token) headers["Authorization"] = `Bearer ${peer.token}`;
      config.mcpServers[key] = { type: "http", url: peer.url, headers };
    }
  }

  const claude = new Claude(config.session, config.mcpServers || {});
  claude.name = config.name;
  claude.start();
  // ...
```

- [ ] **Step 3: Update all config.claude.model / config.claude.permissionMode references**

Search and replace throughout `server.ts`:
- `config.claude.model` → `config.session.model`
- `config.claude.permissionMode` → `config.session.providers?.claude?.permissionMode || "bypassPermissions"` (or extract a helper)

Specific lines:
- Status endpoint (~line 239): `model: config.session.model`
- BackgroundReviewer (~line 878): `config.session.model`, permission from provider
- CronScheduler (~line 1065): same
- SOPEngine (~line 1867): same
- compressSession (~line 1986): `config.session.model`
- DelegationManager / SwarmCoordinator (~line 2043): same

Add a helper near the top of `createApp`:

```typescript
const sessionModel = config.session.model;
const sessionPermMode = (config.session.providers?.claude as any)?.permissionMode || "bypassPermissions";
```

Then use `sessionModel` and `sessionPermMode` everywhere.

- [ ] **Step 4: Update config API endpoints**

PUT `/api/config` (~line 635):
```typescript
// Old: if (body.claude) { claude.updateConfig(body.claude); }
// New:
if (body.session) {
  claude.updateConfig(body.session, body.mcpServers);
}
```

Remote control check:
```typescript
// Old: const rcDesired = body?.claude?.remoteControl === true;
// New:
const rcDesired = body?.session?.providers?.claude?.remoteControl === true;
```

- [ ] **Step 5: Update setup wizard**

The setup wizard (~line 1430-1506) references `cfg.claude` and `cfg.claude.mcpServers`. Update:

```typescript
// Old: if (!cfg.claude) cfg.claude = {};
//      if (!cfg.claude.mcpServers) cfg.claude.mcpServers = {};
//      const servers = cfg.claude.mcpServers as Record<string, any>;
// New:
if (!cfg.mcpServers) cfg.mcpServers = {};
const servers = cfg.mcpServers as Record<string, any>;
```

- [ ] **Step 6: Remove .mcp.json reverse-sync**

Delete the entire `.mcp.json` reverse-sync block (~lines 737-765). Replace the PUT handler for `.mcp.json` with a 410:

```typescript
if (name === ".mcp.json") {
  return c.json({
    error: "gone",
    detail: "MCP servers are now configured in config.yml. Use PUT /api/config to update mcpServers.",
  }, 410);
}
```

- [ ] **Step 7: Verify build**

Run: `pnpm build`
Expected: May still have errors in `index.ts` and `supervisor/units.ts` — those are next.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts
git commit -m "feat: update server.ts config.claude → config.session

Peer translation targets top-level mcpServers. .mcp.json reverse-sync
removed. Setup wizard writes to config.mcpServers. All config.claude
references replaced."
```

---

### Task 7: Update index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update config references**

```typescript
const config = loadConfig() as GatewayConfig;

// Old: if (config.name && config.claude) { config.claude.name = config.name; }
// New: name is passed via claude.name setter in createApp, so remove this block.
```

Channel secret injection stays the same — it reads from `config.channels` which hasn't changed.

- [ ] **Step 2: Verify build compiles**

Run: `pnpm build`
Expected: Fewer errors now. May still fail on `supervisor/units.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix: adapt index.ts to new config shape"
```

---

### Task 8: Update supervisor/units.ts

**Files:**
- Modify: `src/supervisor/units.ts`

The supervisor reads `config.json` directly (not through config-store) at line 18 and 50-56. It needs to read `config.yml` instead.

- [ ] **Step 1: Update readConfig to parse YAML**

```typescript
// Old:
import { readFileSync } from "fs";
const CONFIG_PATH = join(HOME, ".exoclaw", "config.json");
function readConfig(): Record<string, any> {
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); }
  catch { return {}; }
}

// New:
import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
const CONFIG_PATH = join(HOME, ".exoclaw", "config.yml");
const LEGACY_CONFIG_PATH = join(HOME, ".exoclaw", "config.json");
function readConfig(): Record<string, any> {
  // Prefer YAML, fall back to legacy JSON
  try {
    if (existsSync(CONFIG_PATH)) {
      return parse(readFileSync(CONFIG_PATH, "utf-8")) || {};
    }
    if (existsSync(LEGACY_CONFIG_PATH)) {
      return JSON.parse(readFileSync(LEGACY_CONFIG_PATH, "utf-8"));
    }
  } catch { /* intentional */ }
  return {};
}
```

- [ ] **Step 2: Update remote control detection**

```typescript
// Old:
const claudeCfg = (config.claude || {}) as Record<string, unknown>;
const wantsRemoteControl =
  process.env.ENABLE_REMOTE_CONTROL === "true" || claudeCfg.remoteControl === true;

// New:
const sessionCfg = (config.session || {}) as Record<string, any>;
const claudeProvider = (sessionCfg.providers?.claude || {}) as Record<string, unknown>;
const wantsRemoteControl =
  process.env.ENABLE_REMOTE_CONTROL === "true" || claudeProvider.remoteControl === true;
```

- [ ] **Step 3: Update the comment at file top**

Change `~/.exoclaw/config.json` references to `~/.exoclaw/config.yml`.

- [ ] **Step 4: Verify full build**

Run: `pnpm build`
Expected: PASS — all TypeScript compiles.

- [ ] **Step 5: Run all tests**

Run: `pnpm test`
Expected: All existing tests pass. The supervisor test may need updating if it mocks config reads.

- [ ] **Step 6: Commit**

```bash
git add src/supervisor/units.ts
git commit -m "fix: supervisor reads config.yml instead of config.json

Falls back to legacy config.json if YAML not found yet.
Remote control check reads from session.providers.claude."
```

---

### Task 9: Update web dashboard

**Files:**
- Modify: `web/src/views/Config.vue`
- Modify: `web/src/views/Chat.vue`

- [ ] **Step 1: Update Config.vue — config.claude → config.session**

All references to `config.claude` become `config.session`, and provider-specific fields go through `config.session.providers.claude`:

Key replacements:
- `config.value.claude.model` → `config.value.session.model`
- `config.value.claude.thinkingBudget` → `config.value.session.providers?.claude?.thinkingBudget`
- `config.value.claude.remoteControl` → `config.value.session.providers?.claude?.remoteControl`
- `config.value.claude.systemPrompt` → `config.value.session.systemPrompt`
- `if (!config.value.claude) config.value.claude = {}` → `if (!config.value.session) config.value.session = { provider: "claude", model: "claude-sonnet-4-6" }`
- When writing provider-specific fields, ensure `config.value.session.providers` and `config.value.session.providers.claude` exist.

Add a helper in the `<script setup>`:

```typescript
function ensureClaudeProvider() {
  if (!config.value.session) config.value.session = { provider: "claude", model: "claude-sonnet-4-6" };
  if (!config.value.session.providers) config.value.session.providers = {};
  if (!config.value.session.providers.claude) config.value.session.providers.claude = {};
  return config.value.session.providers.claude;
}
```

Then e.g. for remote control toggle:
```typescript
// Old: config.value.claude.remoteControl = desired;
// New:
ensureClaudeProvider().remoteControl = desired;
```

- [ ] **Step 2: Update Chat.vue**

Add the same `ensureClaudeProvider()` helper in `<script setup>`:

```typescript
function ensureClaudeProvider() {
  if (!config.value.session) config.value.session = { provider: "claude", model: "claude-sonnet-4-6" };
  if (!config.value.session.providers) config.value.session.providers = {};
  if (!config.value.session.providers.claude) config.value.session.providers.claude = {};
  return config.value.session.providers.claude;
}
```

Specific replacements in Chat.vue:
- Line ~296: `config.value?.claude?.thinkingBudget` → `config.value?.session?.providers?.claude?.thinkingBudget`
- Line ~301: `config.value.claude.model = value` → `config.value.session.model = value`
- Line ~310: `config.value.claude.thinkingBudget = value ? ...` → `ensureClaudeProvider().thinkingBudget = value ? ...`
- Lines ~343-344: `if (!config.value.claude) config.value.claude = {}; config.value.claude.remoteControl = desired` → `ensureClaudeProvider().remoteControl = desired`

- [ ] **Step 3: Verify frontend builds**

Run: `cd web && pnpm build`
Expected: PASS — Vue compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/views/Config.vue web/src/views/Chat.vue
git commit -m "feat: update web dashboard for session config shape

config.claude → config.session, provider-specific fields under
session.providers.claude."
```

---

### Task 10: SessionBackend interface + ClaudeAdapter

**Files:**
- Create: `src/session-backend.ts`
- Modify: `src/claude-sdk.ts`
- Modify: `src/server.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Move shared types to session-backend.ts and create the interface**

Create `src/session-backend.ts`. This file becomes the canonical home for provider-agnostic types. Import `SessionConfig` and `McpServerDef` from `claude-sdk.ts` initially, then re-export them:

```typescript
/**
 * Provider-agnostic session backend interface.
 *
 * Each LLM provider implements this interface. The gateway only references
 * SessionBackend — never a provider class directly.
 *
 * SessionConfig and McpServerDef are re-exported from claude-sdk.ts (their
 * original home). Future refactors may move the canonical definitions here.
 */

// Re-export shared types so consumers can import from one place
export type { SessionConfig, McpServerDef } from "./claude-sdk.js";
import type { SessionConfig, McpServerDef } from "./claude-sdk.js";

export interface SendOptions {
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
}

export type SessionEvent =
  | { type: "chunk"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "done"; content: string }
  | { type: "error"; message: string };

export type McpServerMap = Record<string, McpServerDef>;

export type ClarifyHandler = (question: string, choices?: string[]) => Promise<string>;
export type ApprovalHandler = (action: string, detail?: string, riskLevel?: string) => Promise<string>;

export interface SessionBackend {
  start(): void;
  close(): void;
  send(requestId: string, message: string, opts?: SendOptions): AsyncGenerator<SessionEvent>;
  updateConfig(config: SessionConfig, mcpServers?: McpServerMap): void;
  restart(): void;
  freshSession(): void;

  /** Called after each turn completes. */
  onTurnComplete: (() => void) | null;
  /** Called with usage data after each query. */
  onUsage: ((data: {
    sessionId: string | null;
    costUsd: number;
    usage: Record<string, number>;
    modelUsage: Record<string, any>;
    durationMs: number;
    numTurns: number;
  }) => void) | null;
  onClarify: ClarifyHandler | null;
  onApproval: ApprovalHandler | null;

  set name(n: string);

  readonly alive: boolean;
  readonly busy: boolean;
  readonly usingChannel: boolean;
  readonly activeSessionId: string | null;
}
```

- [ ] **Step 2: Make Claude class implement SessionBackend**

In `src/claude-sdk.ts`, add the import and `implements` clause:

```typescript
import type { SessionBackend } from "./session-backend.js";

export class Claude implements SessionBackend {
  // ... existing implementation — already conforms to the interface
  // The send() method is the existing generator method
  // Ensure the method signature matches SessionBackend.send()
}
```

`SessionConfig`, `McpServerDef`, `ClarifyHandler`, and `ApprovalHandler` stay exported from `claude-sdk.ts` (they're also re-exported from `session-backend.ts` so consumers can import from either).

- [ ] **Step 3: Add adapter factory to session-backend.ts**

Append to `src/session-backend.ts`:

```typescript
import { Claude } from "./claude-sdk.js";

export function createSessionBackend(
  config: SessionConfig,
  mcpServers: McpServerMap = {},
): SessionBackend {
  switch (config.provider) {
    case "claude":
      return new Claude(config, mcpServers);
    default:
      throw new Error(`Unknown session provider: ${config.provider}`);
  }
}
```

- [ ] **Step 4: Update server.ts to use SessionBackend**

In `src/server.ts`:

```typescript
// Old (from Task 6):
import { Claude, type SessionConfig, type McpServerDef } from "./claude-sdk.js";
// New:
import { createSessionBackend, type SessionBackend } from "./session-backend.js";
import type { SessionConfig, McpServerDef } from "./session-backend.js";

// In createApp:
// Old: const claude = new Claude(config.session, config.mcpServers || {});
// New:
const claude = createSessionBackend(config.session, config.mcpServers || {});
claude.name = config.name;
claude.start();
```

The variable name `claude` can stay (or be renamed to `session` — either works). The type is now `SessionBackend`.

- [ ] **Step 5: Update index.ts**

```typescript
// The return type from createApp already exposes `claude` — its type is now SessionBackend.
// No changes needed unless index.ts references the Claude class directly.
```

- [ ] **Step 6: Verify full build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 7: Run all tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/session-backend.ts src/claude-sdk.ts src/server.ts src/index.ts
git commit -m "feat: introduce SessionBackend interface with ClaudeAdapter

Provider-agnostic session abstraction. Claude class implements
SessionBackend. Factory function resolves provider from config.
Gateway only references the interface."
```

---

### Task 11: Final verification and cleanup

**Files:**
- Possibly modify: any files with lingering `config.claude` or `ClaudeConfig` references

- [ ] **Step 1: Search for remaining config.claude references**

Run: `grep -rn "config\.claude\b" src/ web/src/ --include="*.ts" --include="*.vue" | grep -v ".bak" | grep -v "node_modules"`

Expected: Zero matches. If any remain, fix them.

- [ ] **Step 2: Search for remaining ClaudeConfig references**

Run: `grep -rn "ClaudeConfig" src/ --include="*.ts" | grep -v "node_modules"`

Expected: Zero matches (all replaced by SessionConfig).

- [ ] **Step 3: Search for remaining config.json references in code**

Run: `grep -rn "config\.json" src/ --include="*.ts" | grep -v ".bak" | grep -v "node_modules"`

Expected: Only `supervisor/units.ts` fallback reference (legacy compat). All other references should say `config.yml`.

- [ ] **Step 4: Full build**

Run: `pnpm build`
Expected: PASS — zero errors.

- [ ] **Step 5: Full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 6: Lint**

Run: `pnpm lint`
Expected: No new lint errors.

- [ ] **Step 7: Update CLAUDE.md references**

In `CLAUDE.md`, update:
- `config.json` → `config.yml` throughout
- `secrets.json` → removed (secrets inline with `!secret` tag)
- `claude:` config references → `session:` references
- Add note about YAML format and `!secret` tags
- Document `session.provider`, `session.providers.*`, top-level `mcpServers`

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: final cleanup — update CLAUDE.md, remove stale references"
```
