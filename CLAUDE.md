# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Design Philosophy

**Claude-first**: If Claude Code can handle a feature effectively on its own (via prompts, skills, MCP tools, or cron jobs), let it. Only build gateway-level implementations when we can do meaningfully better — lower latency, stronger safety guarantees, structured data needs, or things Claude simply can't do from inside a session. The gateway should be thin scaffolding around Claude's capabilities, not a reimplementation of them.

## Build & Run

```bash
pnpm build             # tsc → dist/
pnpm start             # node dist/index.js
pnpm dev               # tsc --watch
pnpm test              # vitest run
pnpm lint              # eslint src

# Docker (production)
docker build -t exoclaw .
docker compose up -d
docker exec -it <container> claude login          # first-time auth
docker exec -it <container> exoclawctl status     # list supervised services
docker exec -it <container> exoclawctl upgrade claude  # runtime Claude Code upgrade
```

The Dockerfile is a multi-stage build: stage 1 builds the web SPA (Vite), stage 2 compiles the TypeScript server, installs claude-code + agent-browser globally, and runs as a non-root `agent` user. PID 1 inside the container is the custom supervisor (`src/supervisor/`), which spawns and manages the gateway and other services.

## Architecture

ExoClaw is a gateway that wraps a persistent Claude Code session and exposes it through multiple channel interfaces. One container = one human's agent.

### Container Supervisor (`src/supervisor/`)

PID 1 in the container is the exoclaw supervisor — a small, tailored init system that manages services as "units" with a state machine, control socket, and `exoclawctl` CLI. It is NOT supervisord; it is deliberately narrow.

**Built-in units (hardcoded, not user-configurable):**
- `gateway` — `node /app/dist/index.js`. `restart: always`, readiness via `GET /health`.
- `remote-control` — `claude remote-control`. `restart: on-failure`. Auto-started when `ENABLE_REMOTE_CONTROL=true` or `config.session.providers.claude.remoteControl === true`. URL is extracted from stdout and surfaced via `GET /api/status` and `exoclawctl status remote-control`.

**Custom user-defined units** live under `config.services` in `~/.exoclaw/config.yml` (schema in [src/schemas.ts](src/schemas.ts) → `CustomServiceSpecSchema`). Full `UnitSpec` minus PID-1-dangerous fields. An optional `schedule` field (standard 5-field cron, ISO datetime, or `now + Nm`) makes the supervisor fire `start()` on the cron tick — useful for "run this indexer every 15 minutes" style jobs. Scheduled services should use `restart: "no"` and `autoStart: false`; they run to completion and the next tick restarts them.

**Control channel**: Unix socket at `~/.exoclaw/ctl.sock`, mode 0600, no auth (single-UID container). Protocol: newline-delimited JSON, one request per line. Used by both `exoclawctl` and the gateway's `SupervisorClient` ([src/supervisor/client.ts](src/supervisor/client.ts)).

**`exoclawctl`** (installed as `/usr/local/bin/exoclawctl` via a bash shim):
```
exoclawctl ping
exoclawctl status [unit]
exoclawctl start <unit>
exoclawctl stop <unit>
exoclawctl restart <unit>
exoclawctl logs <unit> [-f] [-n N]
exoclawctl upgrade claude [--no-gateway-restart]
```

**Upgrade flow** (`exoclawctl upgrade claude`): supervisor stops `remote-control` if running, runs `sudo -n /app/scripts/upgrade-claude.sh` (covered by existing sudoers `/app/scripts/*.sh` glob), verifies the new version, restarts `gateway`, then restarts `remote-control` if it was running pre-upgrade. 120s timeout, in-memory mutex prevents concurrent upgrades.

**Crash-loop quarantine**: a unit that crashes 10 times within 5 minutes enters `failed` state permanently. Auto-restart is disabled until explicit `exoclawctl start <unit>`. Prevents log-spam.

**HTTP API** (`/api/services/*`) proxies the control socket: `GET /api/services`, `GET /api/services/:unit`, `POST /api/services/:unit/{start,stop,restart}`, `POST /api/services/upgrade` (body `{target:"claude"}`). All protected by the Bearer middleware.

### Session Backends

The gateway uses a `SessionBackend` interface ([src/session-backend.ts](src/session-backend.ts)) to abstract the LLM provider. A factory function (`createSessionBackend()`) resolves the provider from `config.session.provider` at startup. Currently one adapter:

- **Claude Adapter** ([src/claude-sdk.ts](src/claude-sdk.ts), `provider: "claude"`): Uses `@anthropic-ai/claude-agent-sdk`. Two sub-modes:
  - **Stable**: `query()` per message with session resume. Full MCP server support, system prompts, agents.
  - **V2** (`CLAUDE_SDK_V2=true`): `unstable_v2_createSession()` for persistent in-process session. Lower latency, limited config.
  Includes in-process MCP servers for `session_search`, `clarify`, and `request_approval`. Remote control is no longer spawned from here — the supervisor owns that subprocess.

### Core Loop

1. A message arrives via any channel (WebSocket, Slack, Discord, Telegram, WhatsApp, email, terminal)
2. The gateway pushes it to the Claude session (via SDK query or channel MCP server)
3. Claude processes the message and calls `reply` to send responses back through the gateway
4. The gateway streams events to the originating channel, scanning outbound content for credential leaks

### Channel MCP Server (channel-server.ts)

Standalone MCP server (stdio transport) bridged over HTTP on port 3200. Tools exposed to Claude:
- `reply(request_id, text)` — send response back to channel
- `session_search(query, limit)` — search past conversations
- `clarify(question, choices)` — ask user a clarifying question
- `request_approval(action, detail, risk_level)` — request user approval for risky actions

When using the SDK backend, these tools are registered as in-process MCP servers instead.

### Turn Completion Pipeline

When Claude finishes a turn, `onTurnComplete()` fires (non-blocking):
- Background review spawns `claude -p` to consolidate memory and create/update skills (every N turns)
- Session indexer picks up new JSONL lines into SQLite
- Cron scheduler checks for pending jobs
- Cost tracker records token usage from SDK results

### Safety Systems

- **Content scanner** (`content-scanner.ts`): Dual-layer — inbound (prompt injection, workspace poisoning) and outbound (credential leak detection). 70+ regex patterns across 8 categories including steganography detection.
- **E-STOP** (`estop.ts`): Two levels — `freeze` (reject new messages, pause cron) and `kill` (terminate session). Recovery via `resume()`.
- **Rate limiter** (`rate-limit.ts`): Sliding window per IP, fails open at tracking limit (prefers availability).
- **Approvals** (`approvals.ts`): Agent can call `request_approval` to ask the user before dangerous actions. Auto-denies after 5min timeout. API at `/api/approvals`.
- **Audit log** (`audit.ts`): SQLite table tracking auth, config changes, cron runs, estop events, errors.
- **Workspace scanner** (`workspace-scanner.ts`): Checks workspace for security alerts.
- **Budget enforcement** (`cost-tracker.ts`): Daily/monthly cost limits with per-model usage tracking.

### Config System (config-store.ts)

Persistent storage in `~/.exoclaw/config.yml` (Docker volume). YAML format with inline `!secret` tags for sensitive values (no separate secrets file). Key structure:

- `session.provider` — LLM provider (`"claude"`, `"openai"`, `"ollama"`, etc.)
- `session.model` — model identifier
- `session.providers.<name>` — provider-specific options (e.g., `providers.claude.permissionMode`)
- `mcpServers` — top-level MCP server definitions (injected into any provider that supports them)
- `channels`, `peers`, `services`, etc. — unchanged

Secrets are tagged with `!secret` in YAML and auto-detected by field name (`apiToken`, `botToken`, etc.). API responses mask secrets with `••••••`. `saveConfigSafe()` restores real values from disk when saving, so masked values in PUT requests don't overwrite actual secrets.

Auto-migrates from legacy `config.json` + `secrets.json` on first boot.

### Cron Scheduler (cron.ts)

SQLite-backed job scheduler supporting three types: `prompt` (LLM-driven via `claude -p`), `shell` (direct execution), and `agent` (named agent delegation). Standard 5-field cron, ISO datetime for one-shots, or relative expressions (`now + 30m`). Sentinel commands like `DREAMING_CONSOLIDATION` are resolved at runtime to actual prompts.

### SOP Engine (sop.ts)

Standard Operating Procedures loaded from `~/workspace/.claude/sops/*.md` (YAML frontmatter + markdown body). Multi-step procedures with state machine supporting `prompt`, `shell`, and `approval` step types. Persists run state in SQLite.

### Session Database (session-db.ts)

SQLite with WAL mode. Tables: `sessions`, `messages`, `messages_fts` (FTS5 with Porter stemmer). The session indexer (`session-indexer.ts`) incrementally parses JSONL files by tracking byte offsets per file. Optional hybrid search via embeddings (`embeddings.ts`).

### Memory System

- **Daily notes** (`daily-notes.ts`): Manages `~/workspace/memory/YYYY-MM-DD.md` files. Injects today's and yesterday's notes into CLAUDE.md preamble. 90-day retention with auto-pruning.
- **Dreaming** (`dreaming.ts`): Nightly consolidation (default 3am). Promotes high-value daily note entries to `MEMORY.md`, prunes stale entries. Uses Claude to evaluate what's worth keeping.

### Agent System

- **Agent registry** (`agent-registry.ts`): Loads named agents from `.claude/agents/*.md` (YAML frontmatter: name, schedule, model). Registered with the cron scheduler on first run; hot-reloaded on change.
- **Sub-agents**: Managed via API (`/api/sub-agents`). CRUD operations on agent definitions.
- **Agent review** (`agent-review.ts`): Reviews agent run outputs.

### Supporting Modules

- **Link enricher** (`link-enricher.ts`): Detects URLs in messages, fetches title/description from meta tags, prepends summaries. Max 3 URLs per message.
- **Doctor** (`doctor.ts`): Diagnostics endpoint (`GET /api/doctor`) — checks Claude auth, workspace writable, SQLite, disk space, channel configs, API token.
- **Insights** (`insights.ts`): Usage analytics — message volume, tool usage breakdown, hourly activity, role distribution.
- **Heartbeat** (`heartbeat.ts`): Scheduled check-ins every 30 minutes. Silent if nothing needs attention; broadcasts if action needed.
- **Channel health** (`channel-health.ts`): Tracks connected/disconnected/error status for each enabled channel. Exposed via `/api/channels/health`.
- **CLAUDE.md sync** (`claude-md.ts`): Syncs gateway CLAUDE.md into the workspace for Claude to reference.

## Source Files

```
src/
  index.ts              gateway entry point — spawned by the supervisor
  server.ts             Hono app with OpenAPI routes, middleware, WebSocket/terminal upgrades
  session-backend.ts    SessionBackend interface, adapter factory, shared types
  claude-sdk.ts         Claude adapter (implements SessionBackend)
  config-store.ts       YAML config.yml persistence with !secret tags
  schemas.ts            Zod schemas for config validation (GatewayConfig, SessionConfig, etc.)
  channel-server.ts     MCP server (reply, session_search, clarify, request_approval)
  channel-health.ts     per-channel health monitoring
  content-scanner.ts    inbound/outbound safety scanner
  cost-tracker.ts       token usage + budget enforcement (SQLite)
  cron.ts               cron scheduler (prompt, shell, agent job types)
  session-db.ts         SQLite session storage + FTS5
  session-indexer.ts    incremental JSONL → SQLite indexer
  embeddings.ts         optional vector embeddings for hybrid search
  estop.ts              emergency stop (freeze / kill)
  rate-limit.ts         sliding window rate limiter
  approvals.ts          agent-initiated approval requests
  audit.ts              SQLite audit log
  agent-registry.ts     named agent loader + cron registration
  agent-review.ts       agent run output review
  background-review.ts  post-turn memory/skill consolidation
  daily-notes.ts        daily memory files
  dreaming.ts           nightly memory consolidation
  insights.ts           usage analytics
  heartbeat.ts          periodic check-in scheduler
  sop.ts                standard operating procedures engine
  link-enricher.ts      URL summarization for messages
  doctor.ts             startup/on-demand diagnostics
  claude-md.ts          CLAUDE.md workspace sync
  workspace-scanner.ts  workspace security scanning
  constants.ts          shared constants

  supervisor/           custom PID 1 init — service units, control socket, exoclawctl
    index.ts              supervisor entry point (PID 1 main)
    unit.ts               Unit class, state machine, readiness probes, ring buffer
    units.ts              built-in specs (gateway, remote-control) + custom-from-config loader
    control.ts            Unix-socket control server (NDJSON protocol dispatch)
    client.ts             SupervisorClient — used by exoclawctl and the gateway
    cli.ts                exoclawctl CLI entry (compiled to dist/supervisor/cli.js)
    upgrade.ts            upgrade-claude orchestrator
    protocol.ts           shared request/response types, op names, error codes
    cron-expr.ts          standalone cron expression parser (5-field + ISO/relative)
    log.ts                tagged stderr logger + child-output forwarder

  channels/
    discord.ts          Discord bot adapter
    slack.ts            Slack bot adapter (Socket Mode)
    telegram.ts         Telegram bot adapter
    whatsapp.ts         WhatsApp via Twilio
    email.ts            async IMAP/SMTP email channel
    websocket.ts        WebSocket chat handler
    terminal.ts         persistent PTY terminal (node-pty)
```

## Web Dashboard (web/)

Vue 3 SPA built with Vite. Served as static files from `web/dist/` by the Hono server.

Views: Dashboard, Chat, Terminal, Config (with sub-sections for Agents, Channels, Skills, JSON Files), SetupWizard.

Components: TerminalPane (persistent shell via node-pty WebSocket).

Features: 13 themes (dark/light), setup wizard for first run, live chat via WebSocket, config editing, session history.

## Channel Plugin (channel-plugin/)

Claude Code plugin (`.claude-plugin/`) registering the channel MCP server. Used by the tmux backend to give Claude access to `reply`, `session_search`, `clarify`, and `request_approval` tools.

## Default Skills (default-skills/)

Skill templates seeded into the workspace on first run: browser-automation, code-review, composio, daily-notes, self-improvement, systematic-debugging, web-app-testing, writing-plans.

## Extras (extras/)

Optional integrations: `imessage-bridge/` — Python webhook server bridging macOS iMessages to the gateway's `/webhook` endpoint.

## WebSocket Protocol

Client connects to `/ws/chat`. Auth via Bearer header, subprotocol (`bearer.*`), or query param.

Server events: `session_start`, `chunk`, `thinking`, `tool_call`, `done`, `error`
Client events: `{ type: "message", content }` or `{ prompt }`

Terminal WebSocket at `/ws/terminal` — persistent PTY session with `{ type: "resize", cols, rows }` support.

## API Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | No | Liveness check |
| GET | `/api/doctor` | Yes | Diagnostics report |
| GET | `/api/status` | Yes | Session state, channel status |
| GET/PUT | `/api/config` | Yes | Read/write config (secrets masked) |
| GET/PUT | `/api/claude-files` | Yes | Read/write CLAUDE.md and other claude files |
| POST | `/webhook` | Yes | Send a prompt programmatically |
| GET | `/api/events` | Yes | SSE stream of session events |
| POST | `/api/session/restart` | Yes | Restart Claude session |
| POST | `/api/session/fresh` | Yes | Start fresh session |
| POST | `/api/session/switch` | Yes | Switch to a different session |
| DELETE | `/api/sessions` | Yes | Delete sessions |
| GET | `/api/session/history` | Yes | Structured message history |
| GET | `/api/session/pane` | Yes | Raw tmux pane capture |
| POST | `/api/session/keys` | Yes | Send keys to tmux session |
| GET | `/api/sessions` | Yes | List all sessions |
| GET | `/api/sessions/search` | Yes | Full-text search sessions |
| GET | `/api/sessions/hybrid-search` | Yes | Hybrid FTS + vector search |
| GET | `/api/sessions/:id/messages` | Yes | Messages for a session |
| GET | `/api/skills` | Yes | List skills |
| GET/PUT/DELETE | `/api/skills/:name` | Yes | CRUD individual skill |
| GET | `/api/agents` | Yes | List registered agents |
| POST | `/api/agents/:name/run` | Yes | Trigger agent run |
| GET | `/api/sub-agents` | Yes | List sub-agent definitions |
| PUT/DELETE | `/api/sub-agents/:name` | Yes | CRUD sub-agents |
| GET | `/api/insights` | Yes | Usage analytics |
| GET | `/api/usage` | Yes | Cost/token usage |
| GET | `/api/usage/budget` | Yes | Budget status |
| GET/POST | `/api/review/*` | Yes | Background review events/trigger |
| GET | `/api/audit` | Yes | Audit log |
| GET/POST/DELETE | `/api/cron/*` | Yes | CRUD cron jobs, run/kill |
| GET/POST | `/api/estop` | Yes | Emergency stop status/trigger |
| POST | `/api/estop/resume` | Yes | Resume from estop |
| GET/POST | `/api/approvals` | Yes | List/resolve approval requests |
| GET | `/api/channels/health` | Yes | Channel connection status |
| GET | `/api/workspace/alerts` | Yes | Workspace security alerts |
| GET | `/api/services` | Yes | List all supervisor units |
| GET | `/api/services/:unit` | Yes | Unit status + extras (remote-control URL, etc.) |
| POST | `/api/services/:unit/start` | Yes | Start a unit |
| POST | `/api/services/:unit/stop` | Yes | Stop a unit |
| POST | `/api/services/:unit/restart` | Yes | Restart a unit |
| POST | `/api/services/upgrade` | Yes | Run `upgrade claude` through the supervisor |
| GET/POST | `/api/sops/*` | Yes | SOP definitions and runs |
| GET | `/api/daily-notes` | Yes | Daily memory notes |
| GET | `/api/auth/status` | No | Auth check |
| POST | `/api/auth/setup-token` | No | Set initial API token |
| GET | `/api/setup/status` | No | Setup wizard state |
| POST | `/api/setup/complete` | No | Complete setup wizard |
| WS | `/ws/chat` | Yes | Live bidirectional chat |
| WS | `/ws/terminal` | Yes | Persistent terminal |
| GET | `/openapi.json` | No | OpenAPI 3.1 spec |
