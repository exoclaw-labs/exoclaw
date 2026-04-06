/**
 * Dreaming — background consolidation of daily notes into long-term memory.
 *
 * Periodically reviews recent daily notes, scores entries by signal quality,
 * and promotes high-value items to MEMORY.md. Runs as a cron job (default: daily at 3am).
 *
 * Inspired by OpenClaw's experimental dreaming system.
 *
 * Uses claude -p to evaluate and consolidate, so the agent has full
 * context about what's worth keeping long-term.
 */

import { readFileSync } from "fs";
import { listDailyNotes } from "./daily-notes.js";
import type { CronScheduler } from "./cron.js";

const DREAMING_PROMPT = `You are consolidating recent daily notes into long-term memory.

## Instructions

1. Read the daily notes below (from the past week)
2. Identify information worth keeping long-term:
   - User preferences or behavioral patterns that were consistent across days
   - Technical decisions or conventions that are now established
   - Environment facts or tool configurations that are stable
   - Important outcomes or learnings from completed tasks
3. Check ~/workspace/MEMORY.md — don't duplicate what's already there
4. Append any new long-term facts to ~/workspace/MEMORY.md
5. Keep entries concise (one fact per line)

## What NOT to promote
- One-off tasks or temporary context
- In-progress work that may change
- Obvious facts derivable from the codebase
- Anything already in MEMORY.md

If nothing is worth promoting, just say "Nothing to consolidate." and stop.

## Recent Daily Notes

`;

/** Build the dreaming prompt with recent daily note content. */
function buildDreamingPrompt(): string | null {
  const notes = listDailyNotes(7); // Last 7 days
  if (notes.length === 0) return null;

  const notesContent = notes
    .map(n => {
      const content = readFileSync(n.path, "utf-8").trim();
      if (!content) return null;
      return `### ${n.date}\n\n${content}`;
    })
    .filter(Boolean)
    .join("\n\n---\n\n");

  if (!notesContent) return null;
  return DREAMING_PROMPT + notesContent;
}

/** Seed the default dreaming cron job if none exists. */
export function seedDreamingJob(scheduler: CronScheduler): void {
  const jobs = scheduler.listJobs();
  const hasDreaming = jobs.some(j => j.name === "dreaming");
  if (hasDreaming) return;

  // Run at 3:00 AM daily
  scheduler.createJob({
    name: "dreaming",
    job_type: "prompt",
    schedule: "0 3 * * *",
    command: "DREAMING_CONSOLIDATION",  // Sentinel — replaced at execution time
  });

  log("info", "Seeded default dreaming cron job (daily at 3:00 AM)");
}

/**
 * Get the actual dreaming prompt (called by cron when the sentinel is detected).
 * Returns null if there are no daily notes to consolidate.
 */
export function getDreamingPrompt(): string | null {
  return buildDreamingPrompt();
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "dreaming", msg }) + "\n");
}
