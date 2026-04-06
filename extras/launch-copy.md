# ExoClaw Launch Copy

---

## 1. Hacker News Launch Post

**Title:** ExoClaw: self-hosted Claude Code gateway with Slack, Discord, Telegram, and web UI (open source)

**Body:**

ExoClaw runs Claude Code (Anthropic's official CLI) inside a Docker container with tmux, then bridges it to whatever messaging interface you actually use — Slack, Discord, Telegram, WhatsApp, or a web dashboard. One container per user, persistent session.

The interesting technical bits:

The AI session is genuinely persistent. The tmux session stays alive between conversations, so Claude accumulates context, builds skills, and can run scheduled cron jobs. It's not stateless prompt/response — it's closer to a running process you happen to message.

Channel adapters are modular. Each platform (Slack, Discord, etc.) is an independent bridge that speaks to the same session over a lightweight internal protocol. Adding a new channel doesn't touch the core.

Safety layer is built in: a content scanner on all inbound/outbound messages, per-user rate limiting, an emergency stop (E-STOP) command that kills the session immediately, and an approvals flow for actions flagged as risky.

We built this because we wanted a single AI assistant that lived in our existing tools rather than a dedicated app we had to remember to open.

GitHub: https://github.com/exoclaw-labs/exoclaw

---

## 2. Reddit Post (r/selfhosted + r/LocalLLaMA)

**Title:** ExoClaw — self-hosted Claude Code gateway that puts your AI in Slack, Discord, Telegram, WhatsApp, and a web dashboard. One Docker container.

**Body:**

Hey r/selfhosted — built something I've wanted for a while and figured this crowd would appreciate it.

ExoClaw wraps Claude Code (Anthropic's official CLI) in a persistent Docker container and lets you talk to it from wherever you actually are — Slack at work, Discord with friends, Telegram on mobile, or a web dashboard when you want a proper interface.

What makes it different from yet another chatbot wrapper:

- **Persistent session** — the Claude process stays alive between messages. It builds up context over time, learns your preferences, and can run scheduled tasks via cron.
- **Full self-hosted isolation** — one container per user, your data never leaves your infrastructure, no vendor dashboard with visibility into your conversations.
- **Safety-first** — content scanner, rate limits, E-STOP command, and an approvals flow for anything destructive.
- **Open source** — MIT, no telemetry, no cloud dependency beyond your Anthropic API key.

If you've ever wanted an AI assistant that lives in your existing tools rather than a separate app, this is the setup.

GitHub: https://github.com/exoclaw-labs/exoclaw

---

## 3. GitHub Repo Description

Self-hosted Claude Code gateway — persistent AI sessions via Slack, Discord, Telegram, WhatsApp, and web. One Docker container.

---

## 4. Twitter/X Thread

**Tweet 1 (hook):**
I got tired of switching between apps to talk to Claude. So I built a self-hosted gateway that puts one persistent Claude session in Slack, Discord, Telegram, WhatsApp, and a web dashboard — all at once.

One Docker container. Runs 24/7.

**Tweet 2:**
The session is genuinely persistent. It's Claude Code (Anthropic's official CLI) running inside tmux — not a stateless API wrapper. It remembers your projects, builds skills over time, and can run scheduled tasks. More like a running process than a chatbot.

**Tweet 3:**
Multi-channel means you can message it from Slack at your desk and Telegram on your phone and it's the same session. Context carries across channels. The channel adapters are modular, so adding new platforms doesn't touch the core.

**Tweet 4:**
Safety isn't an afterthought. Built-in content scanner on all messages, per-user rate limiting, an E-STOP command that kills the session immediately, and an approvals flow that pauses before destructive actions and waits for your confirmation.

**Tweet 5:**
It's open source, self-hosted, and your data never leaves your infrastructure. One container per user, full isolation. The only external dependency is your Anthropic API key.

GitHub: https://github.com/exoclaw-labs/exoclaw
