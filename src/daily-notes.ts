/**
 * Daily Notes — structured temporal memory using daily markdown files.
 *
 * Manages `~/workspace/memory/YYYY-MM-DD.md` files that the agent
 * reads and writes to track daily context. Today's and yesterday's
 * notes are auto-injected into the CLAUDE.md preamble so the agent
 * always has recent temporal context.
 *
 * Inspired by OpenClaw's daily memory files.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const WS = join(process.env.HOME || "/home/agent", "workspace");
const MEMORY_DIR = join(WS, "memory");

/** Get today's date as YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Get yesterday's date as YYYY-MM-DD. */
function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Ensure the memory directory exists. */
export function ensureMemoryDir(): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
}

/** Get the path for a daily note. */
export function dailyNotePath(date?: string): string {
  return join(MEMORY_DIR, `${date || today()}.md`);
}

/** Read a daily note. Returns empty string if doesn't exist. */
export function readDailyNote(date?: string): string {
  try {
    return readFileSync(dailyNotePath(date), "utf-8");
  } catch {
    return "";
  }
}

/** Read today's and yesterday's notes for context injection. */
export function getRecentNotes(): { today: string; yesterday: string; todayDate: string; yesterdayDate: string } {
  const t = today();
  const y = yesterday();
  return {
    today: readDailyNote(t),
    yesterday: readDailyNote(y),
    todayDate: t,
    yesterdayDate: y,
  };
}

/** List all daily note files, sorted newest first. */
export function listDailyNotes(limit = 30): { date: string; path: string; size: number }[] {
  ensureMemoryDir();
  try {
    return readdirSync(MEMORY_DIR)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit)
      .map(f => ({
        date: f.replace(".md", ""),
        path: join(MEMORY_DIR, f),
        size: readFileSync(join(MEMORY_DIR, f), "utf-8").length,
      }));
  } catch {
    return [];
  }
}

/** Prune daily notes older than retention period. */
export function pruneDailyNotes(retentionDays = 90): number {
  ensureMemoryDir();
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().slice(0, 10);
  let pruned = 0;
  try {
    const { rmSync } = require("fs");
    for (const f of readdirSync(MEMORY_DIR)) {
      if (f.match(/^\d{4}-\d{2}-\d{2}\.md$/) && f.replace(".md", "") < cutoff) {
        rmSync(join(MEMORY_DIR, f));
        pruned++;
      }
    }
  } catch {}
  return pruned;
}

/**
 * Generate CLAUDE.md preamble section for daily notes context.
 * This gets appended to CLAUDE.md so the agent knows about recent context.
 */
export function generateDailyNotesContext(): string {
  const notes = getRecentNotes();
  const lines: string[] = [];

  lines.push("## Daily Notes");
  lines.push("");
  lines.push(`You keep daily notes in ~/workspace/memory/YYYY-MM-DD.md files.`);
  lines.push(`Write observations, progress, decisions, and context worth remembering tomorrow.`);
  lines.push(`Today's file: ~/workspace/memory/${notes.todayDate}.md`);
  lines.push("");

  if (notes.yesterday) {
    lines.push(`### Yesterday (${notes.yesterdayDate})`);
    lines.push("");
    lines.push(notes.yesterday.trim());
    lines.push("");
  }

  if (notes.today) {
    lines.push(`### Today (${notes.todayDate})`);
    lines.push("");
    lines.push(notes.today.trim());
    lines.push("");
  }

  return lines.join("\n");
}
