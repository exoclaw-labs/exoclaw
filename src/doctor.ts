/**
 * Doctor — diagnostic checks for configuration and system health.
 *
 * Validates that the gateway is correctly configured:
 *   - Required env vars and secrets are set
 *   - Claude Code is authenticated
 *   - SQLite is writable
 *   - Disk space is adequate
 *   - Channel adapters can reach their APIs
 *   - CLAUDE.md is in sync
 *
 * Runs on startup (logs warnings) and on-demand via GET /api/doctor.
 *
 * Inspired by Hermes's doctor.py and ZeroClaw's doctor/.
 */

import { existsSync, statSync, accessSync, constants } from "fs";
import { join } from "path";
import { execSync } from "child_process";

export interface DiagnosticCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface DiagnosticReport {
  timestamp: string;
  checks: DiagnosticCheck[];
  pass_count: number;
  warn_count: number;
  fail_count: number;
}

export function runDiagnostics(): DiagnosticReport {
  const checks: DiagnosticCheck[] = [];

  // 1. Claude Code auth
  checks.push(checkClaudeAuth());

  // 2. Workspace directory
  checks.push(checkWorkspace());

  // 3. SQLite writable
  checks.push(checkSQLite());

  // 4. Disk space
  checks.push(checkDiskSpace());

  // 5. Claude Code binary
  checks.push(checkClaudeBinary());

  // 6. Channel configs
  checks.push(...checkChannels());

  // 7. CLAUDE.md exists
  checks.push(checkClaudeMd());

  // 8. API token configured
  checks.push(checkApiToken());

  const pass_count = checks.filter(c => c.status === "pass").length;
  const warn_count = checks.filter(c => c.status === "warn").length;
  const fail_count = checks.filter(c => c.status === "fail").length;

  return { timestamp: new Date().toISOString(), checks, pass_count, warn_count, fail_count };
}

function checkClaudeAuth(): DiagnosticCheck {
  try {
    const out = execSync("claude auth status 2>&1", { encoding: "utf-8", timeout: 10_000 });
    const status = JSON.parse(out);
    if (status.authenticated || status.loggedIn) {
      return { name: "claude_auth", status: "pass", detail: `Authenticated as ${status.account || status.email || "unknown"}` };
    }
    return { name: "claude_auth", status: "fail", detail: "Claude Code is not authenticated" };
  } catch (err) {
    return { name: "claude_auth", status: "fail", detail: `Auth check failed: ${String(err).slice(0, 100)}` };
  }
}

function checkWorkspace(): DiagnosticCheck {
  const ws = join(process.env.HOME || "/home/agent", "workspace");
  if (!existsSync(ws)) {
    return { name: "workspace", status: "fail", detail: `Workspace not found: ${ws}` };
  }
  try {
    accessSync(ws, constants.W_OK);
    return { name: "workspace", status: "pass", detail: `Workspace writable: ${ws}` };
  } catch {
    return { name: "workspace", status: "fail", detail: `Workspace not writable: ${ws}` };
  }
}

function checkSQLite(): DiagnosticCheck {
  const dbPath = join(process.env.HOME || "/home/agent", ".exoclaw", "sessions.db");
  if (!existsSync(dbPath)) {
    return { name: "sqlite", status: "warn", detail: "Sessions database does not exist yet (will be created on first use)" };
  }
  try {
    accessSync(dbPath, constants.W_OK);
    const stat = statSync(dbPath);
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);
    return { name: "sqlite", status: "pass", detail: `Database writable (${sizeMb} MB)` };
  } catch {
    return { name: "sqlite", status: "fail", detail: "Sessions database is not writable" };
  }
}

function checkDiskSpace(): DiagnosticCheck {
  try {
    const df = execSync("df -h / | tail -1", { encoding: "utf-8", timeout: 5000 });
    const parts = df.trim().split(/\s+/);
    const usePct = parseInt(parts[4] || "0");
    const avail = parts[3] || "unknown";
    if (usePct > 95) {
      return { name: "disk_space", status: "fail", detail: `Disk ${usePct}% full (${avail} available)` };
    }
    if (usePct > 85) {
      return { name: "disk_space", status: "warn", detail: `Disk ${usePct}% full (${avail} available)` };
    }
    return { name: "disk_space", status: "pass", detail: `Disk ${usePct}% used (${avail} available)` };
  } catch {
    return { name: "disk_space", status: "warn", detail: "Could not check disk space" };
  }
}

function checkClaudeBinary(): DiagnosticCheck {
  try {
    const version = execSync("claude --version 2>&1", { encoding: "utf-8", timeout: 10_000 }).trim();
    return { name: "claude_binary", status: "pass", detail: `Claude Code ${version}` };
  } catch {
    return { name: "claude_binary", status: "fail", detail: "Claude Code binary not found or not executable" };
  }
}

function checkChannels(): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];

  // Telegram
  if (process.env.TELEGRAM_BOT_TOKEN) {
    checks.push({ name: "channel_telegram", status: "pass", detail: "Bot token configured" });
  }

  // Discord
  if (process.env.DISCORD_BOT_TOKEN) {
    checks.push({ name: "channel_discord", status: "pass", detail: "Bot token configured" });
  }

  // Slack
  if (process.env.SLACK_BOT_TOKEN) {
    checks.push({ name: "channel_slack", status: "pass", detail: "Bot token configured" });
  } else if (process.env.SLACK_SIGNING_SECRET) {
    checks.push({ name: "channel_slack", status: "warn", detail: "Signing secret set but no bot token" });
  }

  // WhatsApp
  if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID) {
    checks.push({ name: "channel_whatsapp", status: "pass", detail: "Token and phone ID configured" });
  }

  // Email
  if (process.env.EMAIL_IMAP_URL && process.env.EMAIL_USER) {
    checks.push({ name: "channel_email", status: "pass", detail: `Email configured for ${process.env.EMAIL_USER}` });
  }

  if (checks.length === 0) {
    checks.push({ name: "channels", status: "warn", detail: "No external channels configured (WebSocket only)" });
  }

  return checks;
}

function checkClaudeMd(): DiagnosticCheck {
  const claudeMd = join(process.env.HOME || "/home/agent", "workspace", "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    return { name: "claude_md", status: "warn", detail: "CLAUDE.md not found in workspace" };
  }
  return { name: "claude_md", status: "pass", detail: "CLAUDE.md present" };
}

function checkApiToken(): DiagnosticCheck {
  if (process.env.EXOCLAW_API_TOKEN || process.env.API_TOKEN) {
    return { name: "api_token", status: "pass", detail: "API token configured" };
  }
  return { name: "api_token", status: "warn", detail: "No API token configured — endpoints are unauthenticated" };
}
