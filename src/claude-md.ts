/**
 * CLAUDE.md Manager — ensures Claude Code reads companion workspace files.
 *
 * Claude Code only auto-reads CLAUDE.md, .mcp.json, settings.json, and skills/.
 * Other workspace files (SOUL.md, USER.md, MEMORY.md, etc.) are an ecosystem
 * convention shared by OpenClaw, ZeroClaw, and Hermes — agents are expected
 * to read them as standalone files.
 *
 * Strategy: inject strong directives into CLAUDE.md telling Claude to read
 * these files at session start. This preserves migration compatibility
 * (files stay standalone, same format as other platforms) while ensuring
 * Claude Code actually uses them.
 *
 * Content is injected between sentinel HTML comments so user-written
 * sections of CLAUDE.md are preserved across refreshes.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const WS = join(process.env.HOME || "/home/agent", "workspace");
const CLAUDE_MD_PATH = join(WS, "CLAUDE.md");

const EXOCLAW_START = "<!-- exoclaw:managed-start -->";
const EXOCLAW_END = "<!-- exoclaw:managed-end -->";

/** Check which companion files actually exist. */
function existingFiles(): string[] {
  const files = [
    "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md",
    "AGENTS.md", "TOOLS.md", "HEARTBEAT.md",
  ];
  return files.filter(f => {
    try { return readFileSync(join(WS, f), "utf-8").trim().length > 0; } catch { return false; }
  });
}

/** Check if daily notes directory has any content. */
function hasDailyNotes(): boolean {
  try {
    const memDir = join(WS, "memory");
    const { readdirSync } = require("fs");
    return readdirSync(memDir).some((f: string) => f.match(/^\d{4}-\d{2}-\d{2}\.md$/));
  } catch { return false; }
}

function buildManagedSection(): string {
  const lines: string[] = [];
  const present = existingFiles();
  const today = new Date().toISOString().slice(0, 10);

  lines.push(EXOCLAW_START);
  lines.push("");
  lines.push("## Session Startup");
  lines.push("");
  lines.push("**At the start of every conversation, you MUST read these workspace files before responding to the user:**");
  lines.push("");

  // Session-start files — always read
  const startupFiles = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"].filter(f => present.includes(f));
  if (startupFiles.length > 0) {
    for (const f of startupFiles) {
      lines.push(`- \`~/workspace/${f}\``);
    }
    lines.push("");
    lines.push("These files contain your personality, your user's profile, and your persistent memory. They are your context across sessions. Do NOT skip them.");
  } else {
    lines.push("No companion files exist yet. Create them as you learn about your user and environment.");
  }
  lines.push("");

  // Daily notes
  if (hasDailyNotes()) {
    lines.push(`Also read today's daily note if it exists: \`~/workspace/memory/${today}.md\``);
    lines.push("");
  }

  // On-demand files — read when relevant
  const onDemand = ["AGENTS.md", "TOOLS.md", "HEARTBEAT.md"].filter(f => present.includes(f));
  if (onDemand.length > 0) {
    lines.push("**Read these on-demand when relevant:**");
    lines.push("");
    if (present.includes("AGENTS.md")) lines.push("- `~/workspace/AGENTS.md` — when delegating to subagents or acting autonomously");
    if (present.includes("TOOLS.md")) lines.push("- `~/workspace/TOOLS.md` — when unsure how to use a specific tool");
    if (present.includes("HEARTBEAT.md")) lines.push("- `~/workspace/HEARTBEAT.md` — when a heartbeat check-in runs");
    lines.push("");
  }

  // Persistence instructions
  lines.push("## Persistence");
  lines.push("");
  lines.push("When you learn something worth remembering across sessions:");
  lines.push("- Durable facts, tool quirks, conventions → append to `~/workspace/MEMORY.md`");
  lines.push("- User preferences, profile, communication style → append to `~/workspace/USER.md`");
  lines.push("- Daily observations, progress, decisions → write to `~/workspace/memory/${today}.md`");
  lines.push("");
  lines.push("After completing complex tasks or discovering a non-trivial workflow, save it as a skill in `~/workspace/.claude/skills/<name>/SKILL.md`.");
  lines.push("");

  lines.push(EXOCLAW_END);

  return lines.join("\n");
}

/**
 * Ensure CLAUDE.md exists and contains our managed section.
 * Preserves any user-written content (persona wizard, custom instructions).
 */
export function syncClaudeMd(): void {
  mkdirSync(WS, { recursive: true });

  const managed = buildManagedSection();

  if (!existsSync(CLAUDE_MD_PATH)) {
    writeFileSync(CLAUDE_MD_PATH, managed + "\n");
    log("info", "Created CLAUDE.md with companion file directives");
    return;
  }

  const existing = readFileSync(CLAUDE_MD_PATH, "utf-8");

  if (existing.includes(EXOCLAW_START) && existing.includes(EXOCLAW_END)) {
    const before = existing.slice(0, existing.indexOf(EXOCLAW_START));
    const after = existing.slice(existing.indexOf(EXOCLAW_END) + EXOCLAW_END.length);
    const updated = before + managed + after;

    if (updated !== existing) {
      writeFileSync(CLAUDE_MD_PATH, updated);
      log("info", "Refreshed companion file directives in CLAUDE.md");
    }
  } else {
    writeFileSync(CLAUDE_MD_PATH, existing.trimEnd() + "\n\n" + managed + "\n");
    log("info", "Appended companion file directives to existing CLAUDE.md");
  }
}

export function refreshDailyNotes(): void {
  syncClaudeMd();
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "claude-md", msg }) + "\n");
}
