/**
 * Heartbeat Protocol — proactive scheduled check-ins.
 *
 * Reads HEARTBEAT.md for tasks to monitor, runs as a cron job.
 * If nothing needs attention, the agent replies "HEARTBEAT_OK"
 * and the result is silently dropped. If something needs action,
 * the result is broadcast to connected clients.
 *
 * Inspired by OpenClaw's heartbeat system.
 *
 * Usage: Seeds a default cron job on first run that executes
 * the heartbeat prompt every 30 minutes.
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { CronScheduler } from "./cron.js";

const WS = join(process.env.HOME || "/home/agent", "workspace");
const HEARTBEAT_PATH = join(WS, "HEARTBEAT.md");

const HEARTBEAT_PROMPT = `Check your HEARTBEAT.md file at ~/workspace/HEARTBEAT.md for any proactive tasks that need attention.

For each task listed:
1. Check its current status
2. If it needs action, take action or report what's needed
3. If it's all clear, skip it

After checking all tasks:
- If nothing needs attention, respond with exactly: HEARTBEAT_OK
- If something needs attention, describe what you found and any actions you took

Keep responses concise. This is a background check-in, not a conversation.`;

const DEFAULT_HEARTBEAT_MD = `# Heartbeat Tasks

Proactive items to check on periodically. The agent reads this file
every 30 minutes and takes action if something needs attention.

## How to Use

Add tasks below in this format:

### Task Name
- **Check**: What to look for
- **Action**: What to do if it needs attention
- **Priority**: low / medium / high

## Active Tasks

<!-- Add your proactive monitoring tasks here -->
<!-- Example:
### Check disk space
- **Check**: Run \`df -h\` and look for partitions over 90% full
- **Action**: Report which partitions are full
- **Priority**: medium
-->
`;

/** Ensure HEARTBEAT.md exists with default content. */
export function ensureHeartbeatFile(): void {
  if (!existsSync(HEARTBEAT_PATH)) {
    mkdirSync(join(WS), { recursive: true });
    writeFileSync(HEARTBEAT_PATH, DEFAULT_HEARTBEAT_MD);
  }
}

/** Seed the default heartbeat cron job if none exists. */
export function seedHeartbeatJob(scheduler: CronScheduler): void {
  const jobs = scheduler.listJobs();
  const hasHeartbeat = jobs.some(j => j.name === "heartbeat");
  if (hasHeartbeat) return;

  scheduler.createJob({
    name: "heartbeat",
    job_type: "prompt",
    schedule: "*/30 * * * *",  // Every 30 minutes
    command: HEARTBEAT_PROMPT,
  });

  log("info", "Seeded default heartbeat cron job (every 30 minutes)");
}

/**
 * Check if a heartbeat result should be broadcast.
 * Returns false if the agent said HEARTBEAT_OK (nothing to report).
 */
export function isHeartbeatAlert(result: string): boolean {
  if (!result) return false;
  const trimmed = result.trim();
  // Drop silent heartbeats (OK response or very short non-actionable responses)
  if (trimmed === "HEARTBEAT_OK") return false;
  if (trimmed.length <= 300 && trimmed.includes("HEARTBEAT_OK")) return false;
  return true;
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "heartbeat", msg }) + "\n");
}
