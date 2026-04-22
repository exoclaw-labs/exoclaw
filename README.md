# exoclaw

Run Claude Code 24/7 in a container and talk to it from Slack, Discord, Telegram, WhatsApp, email, or a web dashboard — one container per user, fully self-hosted.

---

## Why

Claude Code is a capable autonomous agent, but it only runs when you're in a terminal. ExoClaw keeps a persistent Claude session alive and bridges it to wherever you actually work. You message it in Slack; it reads files, runs code, updates your repo, and replies back — no terminal required.

## Features

- **Persistent session** — Claude Code runs continuously via the Agent SDK. Auto-restarts on crash. Session history is preserved across restarts.
- **Container supervisor + `exoclawctl`** — Tiny custom init runs as PID 1 and manages the gateway, remote-control, and user-defined services as systemd-like units. `exoclawctl status`, `start`, `stop`, `restart`, `logs -f`, and `upgrade claude` (live upgrade without rebuilding the image).
- **Multi-channel** — Slack, Discord, Telegram, WhatsApp (via Twilio), email (IMAP/SMTP), WebSocket, and a built-in web terminal. One agent, all your channels.
- **Web dashboard** — Vue 3 SPA with 13 themes. Chat, config editor, session history, terminal, audit log, skills management, agent management, and a setup wizard. No extra setup.
- **Scheduled tasks** — SQLite-backed cron. Three job types: `prompt` (LLM-driven), `shell` (direct exec), `agent` (named agent delegation). Standard cron, ISO datetimes, and relative expressions (`now + 30m`).
- **Self-improvement loop** — After each conversation, Claude consolidates its own memory and creates/updates skills. Daily notes are promoted to long-term memory via nightly "dreaming" consolidation.
- **Safety layer** — 70+ regex patterns scan inbound and outbound content for credential leaks, prompt injection, and steganography. Rate limiting, E-STOP (freeze or kill), workspace scanning, and agent-initiated approval requests with 5-minute auto-deny timeout.
- **Cost tracking** — Per-model token usage tracking with daily and monthly budget enforcement. Usage analytics via the dashboard.
- **Session search** — Full-text search over conversation history via SQLite FTS5 with Porter stemmer. Optional hybrid mode adds vector embeddings for semantic search (OpenAI-compatible endpoint).
- **Agent registry** — Define named agents in `.claude/agents/*.md` with YAML frontmatter (name, schedule, model). Loaded on first run, hot-reloaded on change, integrated with the cron scheduler.
- **SOPs** — Standard Operating Procedures: multi-step automations with prompt, shell, and approval gates. Defined in `.claude/sops/*.md`, managed via API.
- **Diagnostics** — Built-in doctor endpoint checks Claude auth, workspace health, disk space, channel configs, and API token status.
- **One container per user** — No shared state, no shared config. Each instance is its own entity.

## Quick Start

**Prerequisites:** Docker, a Claude subscription (no API key needed — auth via `claude login`).

**1. Pull and run:**

```bash
docker run -d \
  -p 8080:8080 \
  -v exoclaw-data:/home/agent \
  --shm-size=2g \
  --name exoclaw \
  ghcr.io/exoclaw-labs/exoclaw:latest
```

**2. Authenticate Claude:**

```bash
docker exec -it exoclaw claude login
```

Follow the browser prompt. Credentials are stored in the volume and persist across restarts.

**3. Open the setup wizard:**

Navigate to [http://localhost:8080](http://localhost:8080). The wizard walks you through naming your instance, setting an API token, and enabling channels.

**4. (Optional) Set a gateway API token:**

```bash
docker exec exoclaw sh -c 'echo API_TOKEN=your-secret >> /home/agent/.exoclaw/.env'
docker restart exoclaw
```

Without an API token the API is unauthenticated — fine for local use, not for internet-facing deployments.

**5. Verify:**

```bash
curl http://localhost:8080/health
```

### Docker Compose

```bash
git clone https://github.com/exoclaw-labs/exoclaw
cd exoclaw
docker compose up -d
docker exec -it exoclaw claude login
```

The `docker-compose.override.yml` demonstrates running multiple named instances (e.g. different agents on different ports) with separate data volumes.

## Channel Setup

Channel config lives in `/home/agent/.exoclaw/config.yml` (editable via the web dashboard or direct file edit). Sensitive values (tokens, signing keys) are stored inline using `!secret` YAML tags and are never returned by the API.

### Slack

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Enable **Socket Mode**. Add the `app_mentions:read`, `chat:write`, and `channels:history` scopes.
3. In the dashboard, set `SLACK_BOT_TOKEN` (starts `xoxb-`) and `SLACK_SIGNING_SECRET`.
4. Invite the bot to a channel and mention it: `@exoclaw hello`.

### Discord

1. Create an application at [discord.com/developers](https://discord.com/developers/applications).
2. Add a Bot, enable **Message Content Intent**.
3. Set `DISCORD_BOT_TOKEN` in the dashboard.
4. Invite the bot with the `bot` scope and `Send Messages` + `Read Message History` permissions.

### Telegram

1. Create a bot via [@BotFather](https://t.me/botfather). Copy the token.
2. Set `TELEGRAM_BOT_TOKEN` in the dashboard.
3. Message your bot directly or add it to a group.

### WhatsApp

WhatsApp support uses [Twilio](https://www.twilio.com/whatsapp). Set up a Twilio WhatsApp sandbox or approved sender, then:

1. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_WHATSAPP_NUMBER` in the dashboard.
2. Point your Twilio webhook to `https://your-host/webhook/whatsapp`.

### Email

Async email channel via IMAP polling and SMTP replies:

1. Configure IMAP/SMTP credentials in the dashboard.
2. Set allowed sender addresses to filter incoming mail.
3. The agent polls the inbox, processes new messages, and sends replies via SMTP.

### WebSocket / Web Chat

Built-in. Connect to `ws://localhost:8080/ws/chat` with a Bearer token. The web dashboard uses this channel for live chat. No extra setup required.

### Terminal

Built-in persistent PTY terminal at `ws://localhost:8080/ws/terminal`. Accessible from the web dashboard. Session persists across reconnects with a 50KB output buffer.

### iMessage (macOS only)

An optional Python bridge is included in `extras/imessage-bridge/`. It runs on a Mac, listens for incoming iMessages, and forwards them to the gateway's `/webhook` endpoint.

## Managing services inside the container

PID 1 in the container is the exoclaw supervisor — a small custom init that manages services as units. You talk to it via the `exoclawctl` CLI (pre-installed at `/usr/local/bin/exoclawctl`).

```bash
docker exec exoclaw exoclawctl status              # list all units
docker exec exoclaw exoclawctl status gateway      # detailed view of one unit
docker exec exoclaw exoclawctl start remote-control
docker exec exoclaw exoclawctl stop remote-control
docker exec exoclaw exoclawctl restart gateway
docker exec exoclaw exoclawctl logs gateway -n 500  # tail ring-buffered logs
docker exec exoclaw exoclawctl logs gateway -f      # follow new lines
docker exec exoclaw exoclawctl upgrade claude       # upgrade Claude Code + restart gateway
```

All commands accept `--json` for scripting.

**Built-in units:**
- **`gateway`** — the HTTP/WS server. Always started. `restart: always`. Readiness checked via `/health`.
- **`remote-control`** — `claude remote-control` relay. Optional. Start with `exoclawctl start remote-control` or set `claude.remoteControl: true` in config. The URL is extracted from stdout and surfaced via `exoclawctl status remote-control` and `GET /api/status`.

**Custom services:** add entries under `services` in `~/.exoclaw/config.json` — they become first-class units controllable via `exoclawctl`. An optional `schedule` field (5-field cron, ISO datetime, or `now + Nm`) makes the supervisor fire the unit on a schedule.

```jsonc
{
  "services": {
    "my-backup": {
      "description": "Nightly rsync of workspace to /backup",
      "command": "/bin/sh",
      "args": ["-c", "rsync -a /home/agent/workspace/ /backup/"],
      "restart": "no",
      "autoStart": false,
      "schedule": "0 3 * * *"
    }
  }
}
```

The same controls are exposed via HTTP for the web dashboard:
- `GET /api/services` — list all units
- `GET /api/services/:unit` — one unit's full status
- `POST /api/services/:unit/{start,stop,restart}` — lifecycle
- `POST /api/services/upgrade` with `{"target":"claude"}` — upgrade Claude Code

## Configuration Reference

Configuration is stored in `~/.exoclaw/config.yml`. Sensitive values are tagged with `!secret` inline — there is no separate secrets file. Both plain and secret values are managed by the web dashboard.

### Key config.yml fields

| Field | Default | Description |
|---|---|---|
| `name` | `"agent"` | Instance name. Used as the Claude `--name` and in channel display names. |
| `port` | `8080` | Gateway HTTP/WS port. |
| `claude.model` | Claude default | Claude model to use for sessions. |
| `claude.permissionMode` | — | Permission mode for Claude Code. |
| `claude.systemPrompt` | — | System prompt injected into sessions. |
| `claude.mcpServers` | — | MCP server definitions passed to Claude. |
| `channels.*` | disabled | Per-channel enable flag and config. |
| `rateLimit.maxRequestsPerMinute` | `20` | Max requests per minute per IP. |
| `budget.dailyLimitUsd` | — | Daily cost limit in USD. |
| `budget.monthlyLimitUsd` | — | Monthly cost limit in USD. |
| `cron.enabled` | `true` | Enable/disable the cron scheduler. |
| `selfImprovement.backgroundReview.enabled` | `true` | Enable post-turn memory/skill consolidation. |
| `embeddings.enabled` | `false` | Enable vector embeddings for hybrid search. |

## Architecture

```
                    ┌──────────────────────────────────────────────┐
  Slack / Discord   │              exoclaw container                │
  Telegram / WA  ──►│                                               │
  Email / Web       │  PID 1: exoclaw supervisor                    │
                    │    ├── gateway   (node /app/dist/index.js)    │
                    │    │     Hono HTTP/WS server on port 8080     │
                    │    │     Claude Agent SDK (in-process)        │
                    │    │     reply / clarify / request_approval   │
                    │    │     session_search (SQLite FTS5)         │
                    │    │                                          │
                    │    └── remote-control (optional)              │
                    │          claude remote-control relay          │
                    │                                               │
                    │    control socket: ~/.exoclaw/ctl.sock        │
                    │    CLI: /usr/local/bin/exoclawctl             │
                    │                                               │
                    │  Cron scheduler  ──►  claude -p                │
                    │  SOP engine     ──►  multi-step procedures     │
                    │  Cost tracker   ──►  budget enforcement        │
                    │  Session indexer ──►  SQLite WAL               │
                    │  Content scanner ──►  inbound + outbound       │
                    │  Daily notes    ──►  dreaming → MEMORY.md      │
                    └──────────────────────────────────────────────┘
```

**Message flow:**

1. Message arrives via any channel adapter.
2. Gateway sends it to the Claude session via the Agent SDK `query()` / V2 session.
3. Claude processes the message, calls `reply` to send a response.
4. Gateway streams the response back to the originating channel, scanning outbound content before delivery.

**Supervisor flow:**

1. Container boots. PID 1 is the supervisor.
2. Supervisor spawns the `gateway` unit as its first child and waits for `/health` to pass.
3. If `config.claude.remoteControl === true` or `ENABLE_REMOTE_CONTROL=true`, the `remote-control` unit is spawned in parallel.
4. Any user-defined services in `config.services` are loaded and spawned (if `autoStart: true`) or queued for their `schedule`.
5. Crashes trigger exponential backoff restarts (1s → 30s, reset after 60s healthy). 10 crashes in 5 minutes → quarantine (manual `exoclawctl start` required).
6. `docker stop` sends SIGTERM to PID 1; supervisor forwards SIGTERM to all unit process groups and waits up to `stop_grace_period` (30s) before SIGKILL.

**Claude-first design:** The gateway is thin scaffolding. If Claude Code can handle a feature via prompts, skills, or MCP tools, it does. Gateway-level implementations are reserved for things that need lower latency, stronger safety guarantees, or structured data.

**Persistence:** All state (config, secrets, session history, skills, memories, daily notes) lives in the `/home/agent` volume. Wipe the volume to reset the instance completely.

## API

Full OpenAPI 3.1 spec at `/openapi.json` once the container is running.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | No | Liveness check |
| GET | `/api/doctor` | Yes | Diagnostics report |
| GET | `/api/status` | Yes | Session state, channel status |
| GET/PUT | `/api/config` | Yes | Read/write config (secrets masked) |
| GET/PUT | `/api/claude-files` | Yes | Read/write CLAUDE.md and workspace files |
| POST | `/webhook` | Yes | Send a prompt programmatically |
| GET | `/api/events` | Yes | SSE stream of session events |
| POST | `/api/session/restart` | Yes | Restart the Claude session |
| POST | `/api/session/fresh` | Yes | Start a fresh session |
| GET | `/api/session/history` | Yes | Structured message history |
| GET | `/api/sessions` | Yes | List all sessions |
| GET | `/api/sessions/search` | Yes | Full-text search sessions |
| GET/PUT/DELETE | `/api/skills/:name` | Yes | CRUD skills |
| GET | `/api/agents` | Yes | List registered agents |
| POST | `/api/agents/:name/run` | Yes | Trigger agent run |
| GET/PUT/DELETE | `/api/sub-agents/:name` | Yes | CRUD sub-agents |
| GET | `/api/insights` | Yes | Usage analytics |
| GET | `/api/usage` | Yes | Cost/token usage |
| GET | `/api/usage/budget` | Yes | Budget status |
| GET/POST/DELETE | `/api/cron/*` | Yes | CRUD cron jobs, run/kill |
| GET/POST | `/api/estop` | Yes | Emergency stop |
| GET/POST | `/api/approvals` | Yes | Approval requests |
| GET | `/api/channels/health` | Yes | Channel connection status |
| GET/POST | `/api/sops/*` | Yes | SOPs and runs |
| GET | `/api/audit` | Yes | Audit log |
| GET | `/api/daily-notes` | Yes | Daily memory notes |
| WS | `/ws/chat` | Yes | Live bidirectional chat |
| WS | `/ws/terminal` | Yes | Persistent terminal |

## Contributing

```bash
git clone https://github.com/exoclaw-labs/exoclaw
cd exoclaw
pnpm install
pnpm dev               # tsc --watch
pnpm start             # node dist/index.js (requires a build first)
pnpm test              # vitest
pnpm lint
```

The web dashboard is a separate Vite project in `web/`. Run `pnpm install && pnpm dev` there for hot-reload during UI work.

**Structure:**

```
src/
  index.ts              entry point — loads config, starts server, registers channels
  server.ts             Hono app, OpenAPI routes, middleware
  claude.ts             tmux session backend
  claude-sdk.ts         Agent SDK session backend (default)
  config-store.ts       config.json + secrets.json persistence
  schemas.ts            Zod schemas for config validation
  channel-server.ts     MCP server (reply, session_search, clarify, request_approval)
  channel-health.ts     per-channel health monitoring
  content-scanner.ts    inbound/outbound safety scanner
  cost-tracker.ts       token usage + budget enforcement
  cron.ts               cron scheduler
  session-db.ts         SQLite session storage + FTS5
  sop.ts                standard operating procedures engine
  daily-notes.ts        daily memory files
  dreaming.ts           nightly memory consolidation
  doctor.ts             diagnostics
  channels/             Slack, Discord, Telegram, WhatsApp, email, WebSocket, terminal adapters
channel-plugin/         Claude Code MCP plugin (tmux backend)
web/                    Vue 3 dashboard (Vite)
extras/                 Optional integrations (iMessage bridge)
default-skills/         Skill templates seeded on first run
```

Pull requests welcome. Keep the gateway thin — if it can be a skill or a prompt, it should be.

## License

MIT — see [LICENSE](LICENSE).
