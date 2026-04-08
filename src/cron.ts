/**
 * Cron Scheduler — prompt-based scheduled tasks executed by Claude Code.
 *
 * Supports three job types:
 *   - prompt: Send a prompt to Claude Code (-p) for LLM-driven tasks
 *   - shell:  Execute a shell command directly
 *   - agent:  Delegate to a named agent via Claude Code
 *
 * Jobs are stored in SQLite alongside the session DB. Results can be
 * delivered to connected WebSocket clients or logged for later retrieval.
 *
 * Inspired by zeroclaw's cron system (src/cron/).
 *
 * Claude Code first: prompt jobs use `claude -p` so the agent has full
 * access to its tools, skills, and workspace context.
 */

import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import Database from "better-sqlite3";

// ── Types ──

export type JobType = "prompt" | "shell" | "agent";

export interface CronJob {
  id: string;
  name: string;
  job_type: JobType;
  schedule: string;       // cron expression ("*/5 * * * *") or ISO datetime for one-shot
  command: string;         // prompt text, shell command, or agent name
  enabled: boolean;
  model?: string;
  created_at: string;
  last_run?: string;
  last_result?: string;
  last_status?: "success" | "error" | "timeout";
  run_count: number;
  timezone?: string;
}

export interface CronRun {
  id: number;
  job_id: string;
  started_at: string;
  finished_at?: string;
  status: "success" | "error" | "timeout" | "running";
  result?: string;
}

export interface CronConfig {
  enabled: boolean;
  maxConcurrent: number;
  pollingIntervalMs: number;
  defaultTimeoutMs: number;
  catchUpOnStartup: boolean;
}

type CronListener = (job: CronJob, run: CronRun) => void;

// ── Cron Expression Parser ──

function parseCronExpression(expr: string): { matches: (date: Date) => boolean; isOneShot: boolean } {
  // One-shot: ISO datetime or relative ("now + 30m")
  if (expr.match(/^\d{4}-\d{2}-\d{2}/) || expr.startsWith("now")) {
    let targetTime: number;
    if (expr.startsWith("now")) {
      const match = expr.match(/now\s*\+\s*(\d+)\s*(m|h|d|s)/);
      if (!match) throw new Error(`Invalid relative time: ${expr}`);
      const [, amount, unit] = match;
      const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
      targetTime = Date.now() + parseInt(amount) * ms;
    } else {
      targetTime = new Date(expr).getTime();
      if (isNaN(targetTime)) throw new Error(`Invalid datetime: ${expr}`);
    }
    let fired = false;
    return {
      isOneShot: true,
      matches: (date: Date) => {
        if (fired) return false;
        if (date.getTime() >= targetTime) {
          fired = true;
          return true;
        }
        return false;
      },
    };
  }

  // Standard cron: "min hour dom month dow"
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression (need 5 fields): ${expr}`);

  const parsers = parts.map((part, i) => {
    const max = [59, 23, 31, 12, 6][i];
    return parseCronField(part, i === 4 ? 0 : (i === 2 ? 1 : 0), max);
  });

  return {
    isOneShot: false,
    matches: (date: Date) => {
      const values = [
        date.getMinutes(),
        date.getHours(),
        date.getDate(),
        date.getMonth() + 1,
        date.getDay(),
      ];
      return parsers.every((allowed, i) => allowed.has(values[i]));
    },
  };
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr);
      const start = range === "*" ? min : parseInt(range);
      for (let i = start; i <= max; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let i = a; i <= b; i++) values.add(i);
    } else {
      values.add(parseInt(part));
    }
  }

  return values;
}

// ── Cron Store (SQLite) ──

class CronStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        job_type TEXT NOT NULL DEFAULT 'prompt',
        schedule TEXT NOT NULL,
        command TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_run TEXT,
        last_result TEXT,
        last_status TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        timezone TEXT
      );

      CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        result TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id);
    `);
  }

  listJobs(): CronJob[] {
    return this.db.prepare("SELECT * FROM cron_jobs ORDER BY created_at DESC").all() as CronJob[];
  }

  getJob(id: string): CronJob | undefined {
    return this.db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as CronJob | undefined;
  }

  createJob(job: Omit<CronJob, "created_at" | "run_count">): CronJob {
    this.db.prepare(`
      INSERT INTO cron_jobs (id, name, job_type, schedule, command, enabled, model, timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, job.name, job.job_type, job.schedule, job.command, job.enabled ? 1 : 0, job.model || null, job.timezone || null);
    return this.getJob(job.id)!;
  }

  updateJob(id: string, updates: Partial<Pick<CronJob, "name" | "schedule" | "command" | "enabled" | "model">>): CronJob | undefined {
    const fields: string[] = [];
    const values: any[] = [];
    if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
    if (updates.schedule !== undefined) { fields.push("schedule = ?"); values.push(updates.schedule); }
    if (updates.command !== undefined) { fields.push("command = ?"); values.push(updates.command); }
    if (updates.enabled !== undefined) { fields.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }
    if (updates.model !== undefined) { fields.push("model = ?"); values.push(updates.model); }
    if (fields.length === 0) return this.getJob(id);
    values.push(id);
    this.db.prepare(`UPDATE cron_jobs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getJob(id);
  }

  deleteJob(id: string): boolean {
    return this.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id).changes > 0;
  }

  recordRunStart(jobId: string): number {
    const result = this.db.prepare(`
      INSERT INTO cron_runs (job_id, status) VALUES (?, 'running')
    `).run(jobId);
    return Number(result.lastInsertRowid);
  }

  recordRunEnd(runId: number, status: "success" | "error" | "timeout", result: string): void {
    this.db.prepare(`
      UPDATE cron_runs SET finished_at = datetime('now'), status = ?, result = ? WHERE id = ?
    `).run(status, result, runId);
  }

  updateJobLastRun(jobId: string, status: string, result: string): void {
    this.db.prepare(`
      UPDATE cron_jobs SET last_run = datetime('now'), last_status = ?, last_result = ?, run_count = run_count + 1
      WHERE id = ?
    `).run(status, result.slice(0, 2000), jobId);
  }

  getJobRuns(jobId: string, limit = 20): CronRun[] {
    return this.db.prepare(`
      SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?
    `).all(jobId, limit) as CronRun[];
  }
}

// ── Cron Scheduler ──

/** Tracks a running cron process for status inspection and kill support. */
interface RunningProcess {
  jobId: string;
  runId: number;
  proc: ChildProcess;
  stdout: string;
  stderr: string;
  startedAt: string;
}

export class CronScheduler {
  private store: CronStore;
  private config: CronConfig;
  private model: string;
  private permissionMode: string;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  private processes = new Map<string, RunningProcess>();
  private listeners: CronListener[] = [];
  private parsedSchedules = new Map<string, ReturnType<typeof parseCronExpression>>();
  /** Hook to resolve command sentinels (e.g., DREAMING_CONSOLIDATION). */
  commandResolver: ((command: string) => string | null) | null = null;

  constructor(db: Database.Database, config: CronConfig, model = "claude-sonnet-4-6", permissionMode = "bypassPermissions") {
    this.store = new CronStore(db);
    this.config = config;
    this.model = model;
    this.permissionMode = permissionMode;
  }

  onJobComplete(listener: CronListener): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (!this.config.enabled) return;

    log("info", `Cron scheduler started (polling every ${this.config.pollingIntervalMs}ms)`);

    // Initial tick
    this.tick();

    this.intervalHandle = setInterval(() => this.tick(), this.config.pollingIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private tick(): void {
    const now = new Date();
    const jobs = this.store.listJobs().filter(j => j.enabled);

    for (const job of jobs) {
      if (this.running.has(job.id)) continue;
      if (this.running.size >= this.config.maxConcurrent) break;

      try {
        let parsed = this.parsedSchedules.get(job.id);
        if (!parsed) {
          parsed = parseCronExpression(job.schedule);
          this.parsedSchedules.set(job.id, parsed);
        }

        if (parsed.matches(now)) {
          this.executeJob(job);

          // Disable one-shot jobs after firing
          if (parsed.isOneShot) {
            this.store.updateJob(job.id, { enabled: false });
            this.parsedSchedules.delete(job.id);
          }
        }
      } catch (err) {
        log("error", `Failed to evaluate schedule for ${job.id}: ${err}`);
      }
    }
  }

  private async executeJob(job: CronJob): Promise<void> {
    this.running.add(job.id);
    const runId = this.store.recordRunStart(job.id);
    log("info", `Executing cron job: ${job.name} (${job.id})`);

    try {
      let result: string;
      let status: "success" | "error" | "timeout";

      switch (job.job_type) {
        case "prompt":
          ({ result, status } = await this.executePrompt(job, runId));
          break;
        case "shell":
          ({ result, status } = await this.executeShell(job, runId));
          break;
        case "agent":
          ({ result, status } = await this.executeAgent(job, runId));
          break;
        default:
          result = `Unknown job type: ${job.job_type}`;
          status = "error";
      }

      this.store.recordRunEnd(runId, status, result);
      this.store.updateJobLastRun(job.id, status, result);

      const updatedJob = this.store.getJob(job.id)!;
      const run: CronRun = { id: runId, job_id: job.id, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), status, result };

      for (const listener of this.listeners) {
        try { listener(updatedJob, run); } catch { /* intentional */ }
      }

      log("info", `Cron job ${job.name} completed: ${status}`);
    } catch (err) {
      this.store.recordRunEnd(runId, "error", String(err));
      this.store.updateJobLastRun(job.id, "error", String(err));
      log("error", `Cron job ${job.name} failed: ${err}`);
    } finally {
      this.running.delete(job.id);
    }
  }

  /** Execute a prompt job via claude -p */
  private executePrompt(job: CronJob, runId?: number): Promise<{ result: string; status: "success" | "error" | "timeout" }> {
    // Resolve command sentinels (e.g., dreaming prompt built dynamically)
    let command = job.command;
    if (this.commandResolver) {
      const resolved = this.commandResolver(command);
      if (resolved !== null) command = resolved;
      else if (command === "DREAMING_CONSOLIDATION") {
        return Promise.resolve({ result: "Nothing to consolidate.", status: "success" });
      }
    }

    return new Promise((resolve) => {
      const args = [
        "-p",
        "--output-format", "text",
        "--model", job.model || this.model,
        "--permission-mode", this.permissionMode,
        "--max-turns", "15",
        command,
      ];

      const proc = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        cwd: join(process.env.HOME || "/tmp", "workspace"),
      });
      proc.stdin!.end();

      // Register in process registry
      const rp: RunningProcess = {
        jobId: job.id,
        runId: runId ?? 0,
        proc,
        stdout: "",
        stderr: "",
        startedAt: new Date().toISOString(),
      };
      this.processes.set(job.id, rp);

      proc.stdout!.on("data", (d: Buffer) => {
        const chunk = d.toString();
        rp.stdout += chunk;
        // Cap buffered output at 50KB
        if (rp.stdout.length > 50_000) rp.stdout = rp.stdout.slice(-50_000);
      });
      proc.stderr!.on("data", (d: Buffer) => {
        rp.stderr += d.toString();
        if (rp.stderr.length > 10_000) rp.stderr = rp.stderr.slice(-10_000);
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        this.processes.delete(job.id);
        resolve({ result: "Job timed out", status: "timeout" });
      }, this.config.defaultTimeoutMs);

      proc.on("exit", (code) => {
        clearTimeout(timeout);
        this.processes.delete(job.id);
        if (code === 0 || code === null) {
          resolve({ result: rp.stdout.slice(0, 5000), status: "success" });
        } else {
          resolve({ result: (rp.stderr || rp.stdout).slice(0, 5000), status: "error" });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        this.processes.delete(job.id);
        resolve({ result: String(err), status: "error" });
      });
    });
  }

  /** Execute a shell job */
  private executeShell(job: CronJob, runId?: number): Promise<{ result: string; status: "success" | "error" | "timeout" }> {
    return new Promise((resolve) => {
      const proc = spawn("sh", ["-c", job.command], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        cwd: join(process.env.HOME || "/tmp", "workspace"),
        timeout: this.config.defaultTimeoutMs,
      });
      proc.stdin!.end();

      // Register in process registry
      const rp: RunningProcess = {
        jobId: job.id,
        runId: runId ?? 0,
        proc,
        stdout: "",
        stderr: "",
        startedAt: new Date().toISOString(),
      };
      this.processes.set(job.id, rp);

      proc.stdout!.on("data", (d: Buffer) => {
        const chunk = d.toString();
        rp.stdout += chunk;
        if (rp.stdout.length > 50_000) rp.stdout = rp.stdout.slice(-50_000);
      });
      proc.stderr!.on("data", (d: Buffer) => {
        rp.stderr += d.toString();
        if (rp.stderr.length > 10_000) rp.stderr = rp.stderr.slice(-10_000);
      });

      proc.on("exit", (code) => {
        this.processes.delete(job.id);
        if (code === 0 || code === null) {
          resolve({ result: rp.stdout.slice(0, 5000), status: "success" });
        } else {
          resolve({ result: (rp.stderr || rp.stdout).slice(0, 5000), status: "error" });
        }
      });

      proc.on("error", (err) => {
        this.processes.delete(job.id);
        resolve({ result: String(err), status: "error" });
      });
    });
  }

  /** Execute an agent job — delegates to a named Claude Code agent */
  private executeAgent(job: CronJob, runId?: number): Promise<{ result: string; status: "success" | "error" | "timeout" }> {
    // Agent jobs are prompt jobs that specify an agent name in the command
    // Format: "agent-name: prompt text"
    const colonIdx = job.command.indexOf(":");
    const agentPrompt = colonIdx > 0 ? job.command.slice(colonIdx + 1).trim() : job.command;

    return this.executePrompt({ ...job, command: agentPrompt }, runId);
  }

  // ── Public API for HTTP endpoints ──

  listJobs(): CronJob[] { return this.store.listJobs(); }
  getJob(id: string): CronJob | undefined { return this.store.getJob(id); }

  createJob(input: { name: string; job_type?: JobType; schedule: string; command: string; model?: string; timezone?: string }): CronJob {
    // Validate schedule
    parseCronExpression(input.schedule);

    const job = this.store.createJob({
      id: crypto.randomUUID().slice(0, 8),
      name: input.name,
      job_type: input.job_type || "prompt",
      schedule: input.schedule,
      command: input.command,
      enabled: true,
      model: input.model,
      timezone: input.timezone,
    });

    // Cache parsed schedule
    this.parsedSchedules.set(job.id, parseCronExpression(job.schedule));
    return job;
  }

  updateJob(id: string, updates: Partial<Pick<CronJob, "name" | "schedule" | "command" | "enabled" | "model">>): CronJob | undefined {
    if (updates.schedule) {
      parseCronExpression(updates.schedule);
      this.parsedSchedules.delete(id);
    }
    return this.store.updateJob(id, updates);
  }

  deleteJob(id: string): boolean {
    this.parsedSchedules.delete(id);
    return this.store.deleteJob(id);
  }

  getJobRuns(jobId: string, limit = 20): CronRun[] {
    return this.store.getJobRuns(jobId, limit);
  }

  /** Run a job immediately, regardless of schedule */
  runNow(id: string): boolean {
    const job = this.store.getJob(id);
    if (!job || this.running.has(id)) return false;
    this.executeJob(job);
    return true;
  }

  /** Get the status and partial output of a running job. */
  getRunningStatus(jobId: string): { running: boolean; stdout: string; stderr: string; startedAt: string; elapsedMs: number } | null {
    const rp = this.processes.get(jobId);
    if (!rp) return null;
    return {
      running: true,
      stdout: rp.stdout.slice(-5000),
      stderr: rp.stderr.slice(-2000),
      startedAt: rp.startedAt,
      elapsedMs: Date.now() - new Date(rp.startedAt).getTime(),
    };
  }

  /** Kill a running job process. Returns true if a process was killed. */
  killJob(jobId: string): boolean {
    const rp = this.processes.get(jobId);
    if (!rp) return false;
    try {
      rp.proc.kill("SIGTERM");
      log("info", `Killed running job: ${jobId}`);
      return true;
    } catch {
      return false;
    }
  }

  /** List all currently running jobs with their status. */
  listRunning(): { jobId: string; runId: number; startedAt: string; elapsedMs: number; outputSize: number }[] {
    return Array.from(this.processes.entries()).map(([jobId, rp]) => ({
      jobId,
      runId: rp.runId,
      startedAt: rp.startedAt,
      elapsedMs: Date.now() - new Date(rp.startedAt).getTime(),
      outputSize: rp.stdout.length,
    }));
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "cron", msg }) + "\n");
}
