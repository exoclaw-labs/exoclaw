/**
 * Dreaming — background consolidation of daily notes into long-term memory.
 *
 * Two phases run nightly (default: 3am):
 *   1. Consolidation: promote high-value daily note entries to MEMORY.md
 *   2. Decay: review MEMORY.md for stale/low-importance entries and prune them
 *
 * Entries marked with `[core]` are exempt from decay (permanent facts).
 * All other entries are evaluated for continued relevance.
 *
 * Inspired by OpenClaw's experimental dreaming system.
 * Memory decay inspired by ZeroClaw's memory hygiene system.
 *
 * Uses claude -p so the agent has full context about what's worth keeping.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { listDailyNotes } from "./daily-notes.js";
import type { CronScheduler } from "./cron.js";

const WS = join(process.env.HOME || "/home/agent", "workspace");
const MEMORY_PATH = join(WS, "MEMORY.md");

const DREAMING_PROMPT = `You are consolidating recent daily notes into long-term memory AND pruning stale entries.

## Phase 1: Promote new facts

1. Read the daily notes below (from the past week)
2. Identify information worth keeping long-term:
   - User preferences or behavioral patterns that were consistent across days
   - Technical decisions or conventions that are now established
   - Environment facts or tool configurations that are stable
   - Important outcomes or learnings from completed tasks
3. Check ~/workspace/MEMORY.md — don't duplicate what's already there
4. Append any new long-term facts to ~/workspace/MEMORY.md
5. Keep entries concise (one fact per line)

## Phase 2: Prune stale entries

After consolidation, review ALL existing entries in ~/workspace/MEMORY.md:

1. Entries marked with \`[core]\` are **permanent** — never remove them
2. For all other entries, evaluate:
   - Is this still true/relevant? (projects end, tools change, preferences evolve)
   - Is this contradicted by a newer entry? If so, remove the older one
   - Is this a fact about in-progress work that has since completed?
   - Has this been superseded by a more specific or accurate entry?
3. Remove entries that are clearly stale or contradicted
4. If you remove entries, add a brief comment at the top: \`<!-- Dreaming: pruned N stale entries on YYYY-MM-DD -->\`

## What NOT to promote
- One-off tasks or temporary context
- In-progress work that may change
- Obvious facts derivable from the codebase
- Anything already in MEMORY.md

## Scoring guide
High importance (keep): user identity, recurring preferences, established conventions, stable environment facts
Medium importance (keep if recent): project-specific decisions, tool configurations, team conventions
Low importance (prune if >14 days old): one-off task context, temporary workarounds, debug findings

If nothing is worth promoting or pruning, just say "Nothing to consolidate." and stop.

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

  let prompt = DREAMING_PROMPT + notesContent;

  // Append current MEMORY.md contents so Claude can review for staleness
  try {
    if (existsSync(MEMORY_PATH)) {
      const memory = readFileSync(MEMORY_PATH, "utf-8").trim();
      if (memory) {
        const lineCount = memory.split("\n").filter(l => l.trim()).length;
        prompt += `\n\n---\n\n## Current MEMORY.md (${lineCount} entries — review for stale/contradicted entries)\n\n${memory}`;
      }
    }
  } catch { /* intentional */ }

  return prompt;
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
