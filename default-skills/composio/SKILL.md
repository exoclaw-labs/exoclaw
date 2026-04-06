---
name: composio
description: Use when the user needs to interact with external services like Gmail, Google Sheets, Slack, GitHub, Notion, Salesforce, or any SaaS tool. Composio provides 500+ pre-built integrations via a single MCP server.
version: 1.0.0
author: Exoclaw
---

# Composio Integrations

## Overview

Composio connects you to 500+ external services through a single MCP endpoint. It handles all OAuth flows and token management — you just call the tools.

## When to Use

Reach for Composio when the task involves an **external service**, not a local file or CLI tool:

- Sending or reading email (Gmail, Outlook)
- Creating or updating issues (GitHub, Linear, Jira)
- Posting messages (Slack, Discord, Teams)
- Reading or writing spreadsheets (Google Sheets)
- Managing files (Google Drive, Dropbox)
- CRM operations (Salesforce, HubSpot)
- Project management (Notion, Asana, Trello)
- Calendar operations (Google Calendar, Outlook)
- Social media (X, Instagram, LinkedIn)
- Payment/billing (Stripe)

If the user asks you to do something with a SaaS product, check Composio's tools first.

## When NOT to Use

- Local file operations — use the filesystem directly
- Web browsing or scraping — use the browser tool instead
- API calls to services you already have direct access to
- Tasks that don't involve a third-party service

## How It Works

1. **Apps must be connected first.** The user connects services (Gmail, GitHub, etc.) through the Composio dashboard at composio.dev. You cannot initiate OAuth from here.
2. **Tools appear automatically.** Once an app is connected, its tools show up in your MCP tool list.
3. **Just call the tools.** No auth headers or tokens needed — Composio handles that.

## If a Tool Fails

- **"App not connected"** — ask the user to connect the app at composio.dev
- **"Permission denied"** — the connected account may lack the required scope; ask the user to reconnect with broader permissions
- **"Rate limited"** — back off and retry after a delay

## Tips

- List available Composio tools to see what's connected before guessing
- Composio tool names follow the pattern `{app}_{action}` (e.g., `gmail_send_email`, `github_create_issue`)
- When the user asks to "send an email" or "create an issue," prefer Composio over writing custom API code
- If the user needs a service that isn't connected, tell them to add it at composio.dev rather than trying to work around it
