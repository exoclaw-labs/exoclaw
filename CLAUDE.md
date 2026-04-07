# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Design Philosophy

**Claude-first**: If Claude Code can handle a feature effectively on its own (via prompts, skills, MCP tools, or cron jobs), let it. Only build gateway-level implementations when we can do meaningfully better — lower latency, stronger safety guarantees, structured data needs, or things Claude simply can't do from inside a session. The gateway should be thin scaffolding around Claude's capabilities, not a reimplementation of them.

## Build & Run

```bash
pnpm build             # tsc → dist/
pnpm start             # node dist/index.js
pnpm dev               # tsc --watch

# Docker (production)
docker build -t exoclaw .
docker compose up -d
docker exec -it <container> claude login   # first-time auth
```

The Dockerfile is a multi-stage build: stage 1 builds the web SPA (Vite), stage 2 compiles the TypeScript server, installs claude-code + agent-browser globally, and runs as a non-root `agent` user.

## Architecture

ExoClaw is a gateway that wraps a single persistent Claude Code session (running in tmux) and exposes it through multiple channel interfaces. One container = one human's agent.

### Core Loop

1. A message arrives via any channel (WebSocket, Slack, Discord, Telegram, iMessage)
2. The gateway pushes it to the Claude Code session through the **channel MCP server** (stdio transport bridged over HTTP on port 3200)
3. Claude Code sees the message as a `<channel>` notification from the `exoclaw-channel` plugin
4. Claude calls the `reply` tool to send responses back through the gateway
5. The gateway streams events to the originating channel, scanning outbound content for credential leaks

The key abstraction: Claude Code doesn't know it's in a gateway. It sees a standard MCP server (`channel-plugin/`) that delivers channel events and provides tools like `reply`, `session_search`, `clarify`, and `request_approval`.

### Session Management (claude.ts)

Claude Code runs in a persistent tmux session with `--remote-control` and `--continue`. Two I/O paths:

- **Primary**: MCP channel server (structured JSONL from session files in `.claude/projects/`)
- **Fallback**: tmux `send-keys` + `capture-pane` screen scraping when MCP is unavailable

A background loop auto-accepts predictable interactive prompts (login, workspace trust, permissions). Session respawns automatically on crash after a 5s delay.

### Turn Completion Pipeline

When Claude finishes a turn, `onTurnComplete()` fires (non-blocking):
- Background review spawns `claude -p` to consolidate memory and create/update skills (every N turns)
- Session indexer picks up new JSONL lines into SQLite
- Cron scheduler checks for pending jobs

### Safety Systems

- **Content scanner**: Dual-layer — inbound (prompt injection, workspace poisoning) and outbound (credential leak detection). 70+ regex patterns across 8 categories including steganography detection.
- **E-STOP**: Two levels — `freeze` (reject new messages, pause cron) and `kill` (terminate tmux session). Recovery via `resume()`.
- **Rate limiter**: Sliding window per IP, fails open at tracking limit (prefers availability).
- **Approvals**: Agent can call `request_approval` to ask the user before dangerous actions. Auto-denies after 5min timeout.
- **Audit log**: SQLite table tracking auth, config changes, cron runs, estop events, errors.

### Config System (config-store.ts)

Persistent storage in `~/.exoclaw/` (Docker volume):
- `config.json` — non-sensitive settings (model, name, channels, MCP servers)
- `secrets.json` — tokens and keys, never exposed via API

API responses mask secrets with `••••••`. `saveConfigSafe()` restores real values from disk when saving, so masked values in PUT requests don't overwrite actual secrets.

### Cron Scheduler (cron.ts)

SQLite-backed job scheduler supporting three types: `prompt` (LLM-driven via `claude -p`), `shell` (direct execution), and `agent` (named agent delegation). Standard 5-field cron, ISO datetime for one-shots, or relative expressions (`now + 30m`). Sentinel commands like `DREAMING_CONSOLIDATION` are resolved at runtime to actual prompts.

### Session Database (session-db.ts)

SQLite with WAL mode. Tables: `sessions`, `messages`, `messages_fts` (FTS5 with Porter stemmer). The session indexer incrementally parses JSONL files by tracking byte offsets per file.

## Web Dashboard (web/)

Vue 3 SPA built with Vite. Served as static files from `web/dist/` by the Hono server. Provides config editing, session history, audit logs, and live chat via WebSocket.

## Channel Plugin (channel-plugin/)

A Claude Code plugin (`.claude-plugin/`) that registers an MCP server. Tools exposed to Claude:
- `reply(request_id, text)` — send response back to channel
- `session_search(query, limit)` — search past conversations
- `clarify(question, choices)` — ask user a clarifying question
- `request_approval(action, detail, risk_level)` — request user approval for risky actions

## Default Skills (default-skills/)

Skill templates seeded into the workspace on first run. Format: `SKILL.md` with YAML frontmatter (name, description, version, author) and markdown body describing when/how to use the skill.

## Extras (extras/)

Optional integrations not needed by all users. Currently contains `imessage-bridge/` — a Python webhook server that bridges macOS iMessages to the gateway's `/webhook` endpoint.

## WebSocket Protocol

Client connects to `/ws/chat`. Auth via Bearer header, subprotocol (`bearer.*`), or query param.

Server events: `session_start`, `chunk`, `thinking`, `tool_call`, `done`, `error`
Client events: `{ type: "message", content }` or `{ prompt }`

## API Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | No | Health check |
| GET | `/api/status` | Yes | Full status |
| GET/PUT | `/api/config` | Yes | Read/write config |
| POST | `/webhook` | Yes | Send prompt |
| GET | `/api/events` | Yes | SSE status stream |
| POST | `/api/session/restart` | Yes | Restart Claude session |
| GET | `/api/session/history` | Yes | Structured message history |
| WS | `/ws/chat` | Yes | Live chat |
| GET | `/openapi.json` | No | OpenAPI 3.1 spec |
