# exoclaw

Run Claude Code 24/7 in a container and talk to it from Slack, Discord, Telegram, WhatsApp, or a web dashboard — one container per user, fully self-hosted.

---

<!-- Screenshot placeholder: add dashboard screenshot here -->

---

## Why

Claude Code is a capable autonomous agent, but it only runs when you're in a terminal. ExoClaw keeps a persistent Claude session alive and bridges it to wherever you actually work. You message it in Slack; it reads files, runs code, updates your repo, and replies back — no terminal required.

## Features

- **Persistent session** — Claude Code runs in tmux with `--remote-control --continue`. Auto-restarts on crash.
- **Multi-channel** — Slack, Discord, Telegram, WhatsApp (via WhatsApp Web), WebSocket. One agent, all your channels.
- **Web dashboard** — Vue 3 SPA. Chat, config editor, session history, audit log. No extra setup.
- **Scheduled tasks** — SQLite-backed cron. Three job types: `prompt` (LLM-driven), `shell` (direct exec), `agent` (named agent delegation). Supports standard cron, ISO datetimes, and relative expressions (`now + 30m`).
- **Self-improvement loop** — after each conversation, Claude consolidates its own memory and creates/updates skills. No manual prompt engineering required.
- **Safety layer** — 70+ regex patterns scan inbound and outbound content for credential leaks, prompt injection, and steganography. Rate limiting, E-STOP (freeze or kill), and agent-initiated approval requests.
- **Session search** — full-text search over conversation history via SQLite FTS5 with Porter stemmer.
- **One container per user** — no shared state, no shared config. Each instance is its own entity.

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

## Channel Setup

Channel config lives in `/home/agent/.exoclaw/config.json` (editable via the web dashboard or direct file edit). Secrets (tokens, signing keys) are stored in `secrets.json` and are never returned by the API.

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

### WebSocket / Web Chat

Built-in. Connect to `ws://localhost:8080/ws/chat` with a Bearer token. The web dashboard uses this channel for live chat. No extra setup required.

### iMessage (macOS only)

An optional Python bridge is included in `extras/imessage-bridge/`. It runs on a Mac, listens for incoming iMessages, and forwards them to the gateway's `/webhook` endpoint. See `extras/imessage-bridge/README.md`.

## Configuration Reference

Configuration is stored in `~/.exoclaw/config.json` (non-sensitive) and `~/.exoclaw/secrets.json` (tokens/keys). Both are managed by the web dashboard. The following env vars can override config at startup:

| Variable | Description |
|---|---|
| `API_TOKEN` | Bearer token for all authenticated API endpoints. Unset = no auth. |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-...`). |
| `SLACK_SIGNING_SECRET` | Slack request signing secret. |
| `DISCORD_BOT_TOKEN` | Discord bot token. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather. |

These can be set in `/home/agent/.exoclaw/.env` inside the container or passed via `docker run -e`.

### Key config.json fields

| Field | Default | Description |
|---|---|---|
| `name` | `"agent"` | Instance name. Used as the Claude `--name` and in channel display names. |
| `port` | `8080` | Gateway HTTP/WS port. |
| `model` | Claude default | Claude model to use for sessions. |
| `channels.*` | disabled | Per-channel enable flag and config. |
| `rateLimit.windowMs` | `60000` | Rate limit sliding window (ms). |
| `rateLimit.max` | `20` | Max requests per window per IP. |

## Architecture

```
                    ┌──────────────────────────────────────┐
  Slack / Discord   │            exoclaw container          │
  Telegram / WA  ──►│                                       │
  WebSocket / Web   │  Hono HTTP/WS server (port 8080)      │
                    │         │                             │
                    │         ▼                             │
                    │  Channel MCP server  (port 3200)      │
                    │  stdio transport, JSONL               │
                    │         │                             │
                    │         ▼                             │
                    │  Claude Code session (tmux)           │
                    │  --remote-control --continue          │
                    │         │                             │
                    │         ▼                             │
                    │  reply / clarify / request_approval   │
                    │  session_search (SQLite FTS5)         │
                    │                                       │
                    │  Cron scheduler  ──►  claude -p       │
                    │  Session indexer ──►  SQLite WAL       │
                    │  Content scanner ──►  inbound+outbound│
                    └──────────────────────────────────────┘
```

**Message flow:**

1. Message arrives via any channel adapter.
2. Gateway pushes it to the Claude Code session through the channel MCP server (stdio bridge over HTTP).
3. Claude sees a `<channel>` notification, processes it, calls `reply` to send a response.
4. Gateway streams the response back to the originating channel, scanning outbound content before delivery.

**Claude-first design:** The gateway is thin scaffolding. If Claude Code can handle a feature via prompts, skills, or MCP tools, it does. Gateway-level implementations are reserved for things that need lower latency, stronger safety guarantees, or structured data.

**Persistence:** All state (config, secrets, session history, skills, memories) lives in the `/home/agent` volume. Wipe the volume to reset the instance completely.

## API

Full OpenAPI 3.1 spec at `/openapi.json` once the container is running.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | No | Liveness check |
| GET | `/api/status` | Yes | Session state, channel status |
| GET/PUT | `/api/config` | Yes | Read/write config (secrets masked) |
| POST | `/webhook` | Yes | Send a prompt programmatically |
| GET | `/api/events` | Yes | SSE stream of session events |
| POST | `/api/session/restart` | Yes | Restart the Claude session |
| GET | `/api/session/history` | Yes | Structured message history |
| WS | `/ws/chat` | Yes | Live bidirectional chat |

## Contributing

```bash
git clone https://github.com/exoclaw-labs/exoclaw
cd exoclaw
npm install
npm run dev          # tsc --watch
npm start            # node dist/index.js (requires a build first)
npm test             # vitest
npm run lint
```

The web dashboard is a separate Vite project in `web/`. Run `npm install && npm run dev` there for hot-reload during UI work.

**Structure:**

```
src/
  index.ts          entry point — wires channels, starts server
  server.ts         Hono app, routes, middleware
  claude.ts         tmux session management, I/O
  config-store.ts   config.json + secrets.json persistence
  cron.ts           cron scheduler
  session-db.ts     SQLite session storage + FTS5
  content-scanner.ts inbound/outbound safety scanner
  channels/         Slack, Discord, Telegram, WhatsApp, WebSocket adapters
channel-plugin/     Claude Code MCP plugin (reply, session_search, etc.)
web/                Vue 3 dashboard (Vite)
extras/             Optional integrations (iMessage bridge)
default-skills/     Skill templates seeded on first run
```

Pull requests welcome. Keep the gateway thin — if it can be a skill or a prompt, it should be.

## License

MIT — see [LICENSE](LICENSE).
