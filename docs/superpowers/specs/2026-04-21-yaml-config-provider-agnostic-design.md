# Config Migration: YAML + Provider-Agnostic Session

**Date:** 2026-04-21
**Status:** Approved
**Approach:** Config-first migration (Approach 1)

## Problem

The gateway config is tightly coupled to Claude:

- `config.claude` namespace bakes in Claude-specific concepts (permissionMode, thinkingBudget, Agent SDK options)
- `config.claude.mcpServers` is bidirectionally synced to `workspace/.mcp.json` — a Claude Code-specific file
- `secrets.json` is a separate file split by hardcoded key names
- The config format is JSON, which is less readable for humans editing it directly

The goal is to make the gateway LLM-agnostic so the main session can be backed by any provider (Claude, OpenAI, Ollama, etc.), with a single YAML config file as the source of truth.

## Design

### Config File Format

**Single file:** `~/.exoclaw/config.yml` replaces both `config.json` and `secrets.json`.

**Secrets:** Inline `!secret` YAML custom tag instead of a separate file. The tag marks values for masking in API responses and protection on disk. The hardcoded `SECRET_KEYS` set is eliminated — the tag itself is the marker.

```yaml
name: agent
port: 8080
host: 0.0.0.0
apiToken: !secret abc123
setupComplete: true
browserTool: agent-browser

session:
  provider: claude
  model: claude-sonnet-4-6
  systemPrompt: "You are a helpful assistant."
  maxTurns: 25
  providers:
    claude:
      permissionMode: bypassPermissions
      thinkingBudget: 10000
      remoteControl: false
      allowedTools: []
      disallowedTools: []
    openai:
      apiKey: !secret sk-...
      temperature: 0.7
    ollama:
      baseUrl: http://localhost:11434

mcpServers:
  agent-browser:
    enabled: true
    type: stdio
    command: npx
    args: [agent-browser-mcp]
  composio:
    enabled: false
    type: http
    url: https://connect.composio.dev/mcp
    headers:
      x-consumer-api-key: !secret ""

channels:
  websocket:
    enabled: true
  slack:
    enabled: false
    botToken: !secret xoxb-...
    signingSecret: !secret abc
    appToken: !secret xapp-...
  discord:
    enabled: false
    botToken: !secret ...
  telegram:
    enabled: false
    botToken: !secret ...

peers:
  shortlived:
    url: http://shortlived:8080/mcp
    token: !secret abc123

selfImprovement:
  backgroundReview: { enabled: true, intervalTurns: 5 }
cron: { enabled: true }
rateLimit: { enabled: true, maxRequestsPerMinute: 30 }
audit: { enabled: true, retentionDays: 90 }
budget: { dailyLimitUsd: 10, monthlyLimitUsd: 100 }
tunnel: { provider: tailscale, token: !secret tskey-... }
services:
  my-indexer:
    command: node
    args: [/app/scripts/indexer.js]
    schedule: "*/15 * * * *"
```

### Key Renames from Current Config

| Current (`config.json`)       | New (`config.yml`)             |
|-------------------------------|--------------------------------|
| `claude`                      | `session`                      |
| `claude.model`                | `session.model`                |
| `claude.systemPrompt`         | `session.systemPrompt`         |
| `claude.permissionMode`       | `session.providers.claude.permissionMode` |
| `claude.thinkingBudget`       | `session.providers.claude.thinkingBudget` |
| `claude.remoteControl`        | `session.providers.claude.remoteControl`  |
| `claude.allowedTools`         | `session.providers.claude.allowedTools`   |
| `claude.disallowedTools`      | `session.providers.claude.disallowedTools`|
| `claude.extraFlags`           | `session.providers.claude.extraFlags`     |
| `claude.agents`               | `session.providers.claude.agents`         |
| `claude.mcpServers`           | `mcpServers` (top-level)       |
| `claudeApiToken`              | `session.providers.claude.apiKey` (or env) |
| *(new)*                       | `session.provider` (`"claude"`, `"openai"`, etc.) |

### Config Store (`config-store.ts`)

**Dependency:** `yaml` npm package (native custom tag support).

**`!secret` implementation:** A custom YAML tag type that produces `SecretValue` wrapper objects on parse and emits `!secret` on stringify.

```typescript
class SecretValue {
  constructor(public value: string) {}
  toString() { return this.value; }
}
```

**Load flow:**
1. Read `config.yml`, parse with custom `!secret` tag -> in-memory object with `SecretValue` at tagged paths
2. `resolveSecrets(obj)` deep-walks and replaces `SecretValue` -> plain string for app consumption
3. Env-var overlays (`EXOCLAW_API_TOKEN`, `EXOCLAW_PEERS`) apply on top

**Save flow:**
1. Receive the merged config object (plain strings)
2. Read current `config.yml` to find which paths have `!secret` tags
3. Re-tag those paths with `SecretValue` before writing
4. New secrets restored from mask placeholders also get tagged

**Masking:** `loadConfigMasked()` replaces all `SecretValue` instances with `"••••••"` before resolving.

**New secret detection:** The `!secret` tag is the source of truth for existing secrets. For new secrets added via the config API (e.g., user adds a Discord bot token for the first time), the store keeps a minimal `SECRET_FIELD_HINTS` set (`apiToken`, `botToken`, `signingSecret`, `secret`, `appToken`, `token`, `apiKey`) as a fallback — any value written to a field matching these names is auto-tagged `!secret` on save. This is a hint, not an authoritative list; users editing `config.yml` directly can tag any field. The old `SECRET_KEYS` constant is renamed and narrowed to this role.

**`saveConfigSafe()` adapts:** Same mask-restoration logic as today. It checks `!secret` tags in the current file on disk for existing secrets, and applies `SECRET_FIELD_HINTS` for new fields.

### Migration (First Boot)

1. If `config.yml` exists -> use it
2. Else if `config.json` exists -> convert:
   - Reshape `claude` -> `session` (hoist `model`, `systemPrompt`; nest provider-specific fields under `providers.claude`)
   - Hoist `claude.mcpServers` -> top-level `mcpServers`
   - Merge `secrets.json` values back in
   - Tag known secret paths with `!secret`
   - Write `config.yml`
   - Rename `config.json` -> `config.json.bak`, `secrets.json` -> `secrets.json.bak`
3. Else -> bootstrap from env vars, write `config.yml`

### Schema Changes (`schemas.ts`)

`ClaudeConfigSchema` is replaced by `SessionConfigSchema`:

```typescript
const SessionConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  systemPrompt: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  providers: z.record(z.record(z.unknown())).optional(),
}).passthrough();
```

`mcpServers` moves to top-level on `GatewayConfigSchema`:

```typescript
const GatewayConfigSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().positive(),
  host: z.string().min(1),
  apiToken: z.string().optional(),
  setupComplete: z.boolean().optional(),
  browserTool: z.enum(["browser-use", "agent-browser", "none"]).optional(),
  session: SessionConfigSchema,
  mcpServers: z.record(McpServerDefSchema).optional(),
  channels: z.record(ChannelConfigSchema).optional(),
  peers: z.record(PeerSchema).optional(),
  services: z.record(CustomServiceSpecSchema).optional(),
  // ... rest unchanged
}).passthrough();
```

The `providers` key uses `z.record(z.record(z.unknown()))` with `.passthrough()` so unknown providers don't fail validation. Typed schemas for known providers (Claude, OpenAI) can be added incrementally.

**Removed:** `ClaudeConfigSchema`, `claudeApiToken` field.

### What Gets Removed

**`.mcp.json` sync (both directions):**
- `writeMcpConfig()` in `claude-sdk.ts` (lines 139-180) — deleted. MCP servers are passed directly via SDK options in `buildQueryOptions()`.
- `.mcp.json` reverse-sync in `server.ts` (lines 741-765) — deleted.
- `updateConfig()` no longer calls `writeMcpConfig()`.
- `.mcp.json` stays in the `CLAUDE_FILES` map for GET (visibility in the web UI), but PUT returns `410 Gone` with a message directing users to edit `mcpServers` in `config.yml` or via the config API instead. The gateway never writes this file.

**`secrets.json`:**
- File eliminated. Secrets live inline in `config.yml` with `!secret` tags.
- `splitSecrets()`, `mergeSecrets()` — deleted.
- `SECRET_KEYS` constant — renamed to `SECRET_FIELD_HINTS`, narrowed to a fallback role for auto-tagging new secrets via the API.

**`config.json`:**
- Migrated to `config.yml` on first boot, renamed to `config.json.bak`.

**Claude-specific naming:**
- `ClaudeConfig` type -> `SessionConfig`
- `config.claude` references -> `config.session`
- `config.claude.mcpServers` -> `config.mcpServers`
- The `Claude` class name stays temporarily — becomes `ClaudeAdapter` in phase 2.

### What Stays Unchanged

- **CLAUDE.md sync** (`claude-md.ts`) — workspace content management, not config.
- **`settings.json`** in workspace files API — user-editable for Claude Code project settings. Gateway doesn't generate or sync it.
- **Peer -> MCP translation** — peers still convert to HTTP MCP servers at runtime, targeting top-level `config.mcpServers`.
- **Supervisor, channels, cron, audit, all feature modules** — unchanged structurally.

### SessionBackend Interface (Phase 2)

After the config migration lands, extract a provider-agnostic session abstraction.

```typescript
interface SessionBackend {
  start(): void;
  close(): void;
  send(
    requestId: string,
    message: string,
    opts?: SendOptions,
  ): AsyncGenerator<SessionEvent>;
  updateConfig(session: SessionConfig, mcpServers: McpServerMap): void;
  restart(): void;
  freshSession(): void;

  readonly alive: boolean;
  readonly busy: boolean;
  readonly activeSessionId: string | null;
}

interface SendOptions {
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
}

type SessionEvent =
  | { type: "chunk"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "done"; content: string }
  | { type: "error"; message: string };

type McpServerMap = Record<string, McpServerDef>;
```

**Adapter resolution** at startup:

```typescript
function createSessionBackend(config: GatewayConfig): SessionBackend {
  const { session, mcpServers } = config;
  switch (session.provider) {
    case "claude":
      return new ClaudeAdapter(session, mcpServers);
    default:
      throw new Error(`Unknown session provider: ${session.provider}`);
  }
}
```

**`ClaudeAdapter`** is the existing `Claude` class renamed and made to implement `SessionBackend`. It reads Claude-specific options from `session.providers.claude` and translates top-level `mcpServers` into the Agent SDK's `McpServerConfig` format.

**All consumers** (`server.ts`, `index.ts`, channel adapters) reference `SessionBackend` — never the Claude class directly.

**MCP server injection:** Each adapter decides how to handle MCP servers. Claude adapter passes them to the Agent SDK's `mcpServers` option. Future adapters translate as appropriate or skip if unsupported. Per-provider MCP overrides are deferred.

## Implementation Order

Six steps, each independently shippable:

1. **Add `yaml` dep + new config store** — YAML read/write with `!secret` tag, migration from `config.json`/`secrets.json` -> `config.yml`. Old `loadConfig()`/`saveConfig()` API preserved.

2. **New schema** — `SessionConfigSchema` replaces `ClaudeConfigSchema`, `mcpServers` hoisted. `GatewayConfig` interface updated.

3. **Adapt consumers** — `server.ts`, `index.ts`, channels: `config.claude` -> `config.session`, `config.claude.mcpServers` -> `config.mcpServers`. Peer translation targets top-level `mcpServers`.

4. **Remove .mcp.json sync** — Delete `writeMcpConfig()`, delete reverse-sync, make `.mcp.json` read-only in files API.

5. **Web dashboard** — Config view adapts to `session` key, MCP servers get own section.

6. **SessionBackend interface** — Extract interface, wrap `Claude` as `ClaudeAdapter`, adapter factory in `createApp()`.

## Files Affected

| File | Change |
|------|--------|
| `package.json` | Add `yaml` dependency |
| `src/config-store.ts` | Rewrite: YAML, `!secret` tag, migration logic |
| `src/schemas.ts` | `ClaudeConfigSchema` -> `SessionConfigSchema`, hoist `mcpServers` |
| `src/server.ts` | `config.claude` -> `config.session`, remove .mcp.json sync, update GatewayConfig interface |
| `src/index.ts` | `config.claude` -> `config.session` |
| `src/claude-sdk.ts` | Remove `writeMcpConfig()`, accept new config shape, later rename to `ClaudeAdapter` |
| `web/src/views/Config.vue` | Adapt to `session` key |
| `web/src/views/Chat.vue` | Any references to `config.claude` |
| `web/src/composables/useApi.ts` | If it references config shape |
