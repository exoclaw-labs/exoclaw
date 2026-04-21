/**
 * Session Pruner — automatic cleanup of old sessions, messages, and daily notes.
 *
 * Runs as a startup task and optionally on a cron schedule:
 *   - Prunes messages older than retention period (default 90 days)
 *   - Removes empty sessions with no messages
 *   - Cleans up old daily notes (default: keep 30 days)
 *   - Enforces disk budget for the sessions database
 *
 * Inspired by OpenClaw's session pruning policies.
 */

import type { SessionDB } from "./session-db.js";
import { pruneDailyNotes } from "./daily-notes.js";
import type { CronScheduler } from "./cron.js";
import type { AuditLogger } from "./audit.js";

export interface PruneConfig {
  messageRetentionDays: number;
  dailyNoteRetentionDays: number;
  maxDbSizeMb: number;          // 0 = unlimited
  autoSchedule: boolean;        // seed a daily cron job
}

const DEFAULTS: PruneConfig = {
  messageRetentionDays: 90,
  dailyNoteRetentionDays: 30,
  maxDbSizeMb: 500,
  autoSchedule: true,
};

export function runPrune(db: SessionDB, config?: Partial<PruneConfig>, audit?: AuditLogger): {
  messagesDeleted: number;
  sessionsDeleted: number;
  dailyNotesPruned: number;
} {
  const cfg = { ...DEFAULTS, ...config };

  // 1. Prune old messages
  let messagesDeleted = db.pruneOldMessages(cfg.messageRetentionDays);

  // 2. Remove empty sessions (no messages left)
  let sessionsDeleted = db.db.prepare(`
    DELETE FROM sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM messages)
  `).run().changes;

  // 3. Prune old daily notes
  const dailyNotesPruned = pruneDailyNotes(cfg.dailyNoteRetentionDays);

  // 4. Enforce disk budget
  if (cfg.maxDbSizeMb > 0) {
    const stats = db.getDbStats();
    const sizeMb = stats.dbSizeBytes / (1024 * 1024);
    if (sizeMb > cfg.maxDbSizeMb) {
      // Aggressive prune: halve the retention period and try again
      const aggressiveDays = Math.max(7, Math.floor(cfg.messageRetentionDays / 2));
      messagesDeleted += db.pruneOldMessages(aggressiveDays);
      sessionsDeleted += db.db.prepare(`
        DELETE FROM sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM messages)
      `).run().changes;

      // Vacuum to reclaim space
      try { db.db.exec("VACUUM"); } catch { /* may fail if WAL readers active */ }

      log("warn", `DB exceeded ${cfg.maxDbSizeMb}MB — aggressive prune to ${aggressiveDays} days`);
    }
  }

  if (messagesDeleted > 0 || sessionsDeleted > 0 || dailyNotesPruned > 0) {
    const detail = `Pruned: ${messagesDeleted} messages, ${sessionsDeleted} empty sessions, ${dailyNotesPruned} daily notes`;
    log("info", detail);
    audit?.log({ event_type: "session", detail, source: "system" });
  }

  return { messagesDeleted, sessionsDeleted, dailyNotesPruned };
}

/** Seed a daily prune cron job if none exists. */
export function seedPruneJob(scheduler: CronScheduler): void {
  const jobs = scheduler.listJobs();
  if (jobs.some(j => j.name === "session-prune")) return;

  scheduler.createJob({
    name: "session-prune",
    job_type: "shell",
    schedule: "30 4 * * *", // 4:30 AM daily (after dreaming at 3 AM)
    command: "echo SESSION_PRUNE", // Sentinel — resolved by the gateway
  });

  log("info", "Seeded session-prune cron job (daily at 4:30 AM)");
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "session-pruner", msg }) + "\n");
}
