/**
 * SOP Engine — Standard Operating Procedures with state machine execution.
 *
 * Defines multi-step procedures as YAML files in ~/workspace/.claude/sops/.
 * Each step can be:
 *   - prompt: sends a prompt to Claude Code (LLM-driven)
 *   - shell: executes a shell command (deterministic, no LLM cost)
 *   - approval: pauses and waits for user approval before continuing
 *
 * Procedures can be triggered by cron schedules, webhooks, or manual invocation.
 * State is persisted in SQLite so procedures survive restarts.
 *
 * Inspired by ZeroClaw's SOP engine (src/sop/).
 */

import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync, spawn } from "child_process";
import type Database from "better-sqlite3";

// ── Types ──

export type StepType = "prompt" | "shell" | "approval";

export interface SOPStep {
  name: string;
  type: StepType;
  command: string;  // prompt text, shell command, or approval message
  timeout_ms?: number;
  on_failure?: "stop" | "skip" | "retry";
}

export interface SOPDefinition {
  name: string;
  description: string;
  schedule?: string;      // optional cron schedule
  steps: SOPStep[];
}

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed";

export interface SOPRun {
  id: number;
  sop_name: string;
  status: RunStatus;
  current_step: number;
  started_at: string;
  finished_at: string | null;
  results: string;  // JSON array of step results
}

// ── Store ──

class SOPStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sop_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sop_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        current_step INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        results TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_sop_runs_name ON sop_runs(sop_name);
    `);
  }

  createRun(sopName: string): number {
    const r = this.db.prepare("INSERT INTO sop_runs (sop_name) VALUES (?)").run(sopName);
    return Number(r.lastInsertRowid);
  }

  getRun(id: number): SOPRun | undefined {
    return this.db.prepare("SELECT * FROM sop_runs WHERE id = ?").get(id) as SOPRun | undefined;
  }

  updateRun(id: number, updates: Partial<Pick<SOPRun, "status" | "current_step" | "finished_at" | "results">>): void {
    const fields: string[] = [];
    const values: any[] = [];
    if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
    if (updates.current_step !== undefined) { fields.push("current_step = ?"); values.push(updates.current_step); }
    if (updates.finished_at !== undefined) { fields.push("finished_at = ?"); values.push(updates.finished_at); }
    if (updates.results !== undefined) { fields.push("results = ?"); values.push(updates.results); }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE sop_runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  listRuns(sopName?: string, limit = 20): SOPRun[] {
    if (sopName) {
      return this.db.prepare("SELECT * FROM sop_runs WHERE sop_name = ? ORDER BY started_at DESC LIMIT ?").all(sopName, limit) as SOPRun[];
    }
    return this.db.prepare("SELECT * FROM sop_runs ORDER BY started_at DESC LIMIT ?").all(limit) as SOPRun[];
  }
}

// ── YAML-ish parser (minimal, avoids adding a dependency) ──

function parseSOPFile(content: string): SOPDefinition | null {
  try {
    // Extract YAML frontmatter between ---
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter = match[1];
    const body = match[2].trim();

    // Parse simple key: value from frontmatter
    const meta: Record<string, string> = {};
    for (const line of frontmatter.split("\n")) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }

    if (!meta.name) return null;

    // Parse steps from markdown body (## Step: name lines)
    const steps: SOPStep[] = [];
    const stepBlocks = body.split(/^##\s+/m).filter(Boolean);

    for (const block of stepBlocks) {
      const lines = block.trim().split("\n");
      const headerMatch = lines[0].match(/^(?:Step:\s*)?(.+)$/);
      if (!headerMatch) continue;

      const stepName = headerMatch[1].trim();
      const stepMeta: Record<string, string> = {};
      let command = "";

      for (let i = 1; i < lines.length; i++) {
        const kv = lines[i].match(/^-\s*(\w+):\s*(.+)$/);
        if (kv) {
          stepMeta[kv[1]] = kv[2].trim();
        } else if (lines[i].startsWith("```")) {
          // Capture fenced code block as command
          const codeLines: string[] = [];
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].startsWith("```")) { i = j; break; }
            codeLines.push(lines[j]);
          }
          command = codeLines.join("\n");
        }
      }

      steps.push({
        name: stepName,
        type: (stepMeta.type as StepType) || "prompt",
        command: command || stepMeta.command || stepName,
        timeout_ms: stepMeta.timeout ? parseInt(stepMeta.timeout) * 1000 : undefined,
        on_failure: (stepMeta.on_failure as "stop" | "skip" | "retry") || "stop",
      });
    }

    return {
      name: meta.name,
      description: meta.description || "",
      schedule: meta.schedule,
      steps,
    };
  } catch {
    return null;
  }
}

// ── Engine ──

type StepResultListener = (run: SOPRun, stepIdx: number, result: string, status: string) => void;

export class SOPEngine {
  private store: SOPStore;
  private sopsDir: string;
  private model: string;
  private permissionMode: string;
  private listeners: StepResultListener[] = [];

  constructor(db: Database.Database, model = "claude-sonnet-4-6", permissionMode = "bypassPermissions") {
    this.store = new SOPStore(db);
    this.sopsDir = join(process.env.HOME || "/home/agent", "workspace", ".claude", "sops");
    this.model = model;
    this.permissionMode = permissionMode;
    mkdirSync(this.sopsDir, { recursive: true });
  }

  onStepComplete(listener: StepResultListener): void {
    this.listeners.push(listener);
  }

  /** List all SOP definitions from disk. */
  listSOPs(): SOPDefinition[] {
    try {
      return readdirSync(this.sopsDir)
        .filter(f => f.endsWith(".md"))
        .map(f => {
          const content = readFileSync(join(this.sopsDir, f), "utf-8");
          return parseSOPFile(content);
        })
        .filter((s): s is SOPDefinition => s !== null);
    } catch {
      return [];
    }
  }

  /** Get a specific SOP definition. */
  getSOP(name: string): SOPDefinition | null {
    const filePath = join(this.sopsDir, `${name}.md`);
    if (!existsSync(filePath)) return null;
    return parseSOPFile(readFileSync(filePath, "utf-8"));
  }

  /** Start executing a SOP. Returns the run ID. */
  async execute(sopName: string): Promise<number> {
    const sop = this.getSOP(sopName);
    if (!sop) throw new Error(`SOP not found: ${sopName}`);

    const runId = this.store.createRun(sopName);
    this.store.updateRun(runId, { status: "running" });

    // Execute steps sequentially in background
    this.runSteps(runId, sop).catch(err => {
      log("error", `SOP ${sopName} run ${runId} failed: ${err}`);
      this.store.updateRun(runId, { status: "failed", finished_at: new Date().toISOString() });
    });

    return runId;
  }

  private async runSteps(runId: number, sop: SOPDefinition): Promise<void> {
    const results: { step: string; status: string; output: string }[] = [];

    for (let i = 0; i < sop.steps.length; i++) {
      const step = sop.steps[i];
      this.store.updateRun(runId, { current_step: i, results: JSON.stringify(results) });

      let output: string;
      let status: string;

      try {
        switch (step.type) {
          case "shell":
            output = this.executeShellStep(step);
            status = "success";
            break;
          case "approval":
            // Approval steps pause the SOP — the API must resume it
            this.store.updateRun(runId, { status: "paused", results: JSON.stringify(results) });
            return; // Exit — will be resumed by approveStep()
          case "prompt":
          default:
            output = await this.executePromptStep(step);
            status = "success";
            break;
        }
      } catch (err) {
        output = String(err);
        status = "error";

        if (step.on_failure === "stop") {
          results.push({ step: step.name, status, output });
          this.store.updateRun(runId, {
            status: "failed",
            current_step: i,
            finished_at: new Date().toISOString(),
            results: JSON.stringify(results),
          });
          return;
        }
        // on_failure === "skip": continue to next step
      }

      results.push({ step: step.name, status, output: output.slice(0, 2000) });

      const run = this.store.getRun(runId);
      if (run) {
        for (const listener of this.listeners) {
          try { listener(run, i, output.slice(0, 500), status); } catch { /* intentional */ }
        }
      }
    }

    this.store.updateRun(runId, {
      status: "completed",
      current_step: sop.steps.length,
      finished_at: new Date().toISOString(),
      results: JSON.stringify(results),
    });
  }

  private executeShellStep(step: SOPStep): string {
    const timeout = step.timeout_ms ?? 60_000;
    return execSync(step.command, {
      encoding: "utf-8",
      timeout,
      cwd: join(process.env.HOME || "/home/agent", "workspace"),
      env: process.env,
    }).slice(0, 5000);
  }

  private executePromptStep(step: SOPStep): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("claude", [
        "-p", "--output-format", "text",
        "--model", this.model,
        "--permission-mode", this.permissionMode,
        "--max-turns", "10",
        step.command,
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        cwd: join(process.env.HOME || "/home/agent", "workspace"),
      });
      proc.stdin!.end();

      let stdout = "";
      let stderr = "";
      proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error("Step timed out"));
      }, step.timeout_ms ?? 180_000);

      proc.on("exit", (code: number | null) => {
        clearTimeout(timeout);
        if (code === 0 || code === null) resolve(stdout.slice(0, 5000));
        else reject(new Error((stderr || stdout).slice(0, 2000)));
      });
      proc.on("error", (err: Error) => { clearTimeout(timeout); reject(err); });
    });
  }

  /** Resume a paused SOP run (after approval step). */
  async resumeRun(runId: number): Promise<boolean> {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "paused") return false;

    const sop = this.getSOP(run.sop_name);
    if (!sop) return false;

    // Mark the approval step as complete and continue from the next step
    const results: any[] = JSON.parse(run.results || "[]");
    results.push({ step: sop.steps[run.current_step]?.name || "approval", status: "approved", output: "User approved" });

    this.store.updateRun(runId, { status: "running", current_step: run.current_step + 1, results: JSON.stringify(results) });

    // Continue executing remaining steps
    const remainingSOP: SOPDefinition = {
      ...sop,
      steps: sop.steps.slice(run.current_step + 1),
    };

    if (remainingSOP.steps.length === 0) {
      this.store.updateRun(runId, { status: "completed", finished_at: new Date().toISOString() });
      return true;
    }

    // Re-run remaining steps with adjusted indices
    this.runSteps(runId, remainingSOP).catch(err => {
      log("error", `SOP resume failed: ${err}`);
      this.store.updateRun(runId, { status: "failed", finished_at: new Date().toISOString() });
    });

    return true;
  }

  /** List SOP runs. */
  listRuns(sopName?: string, limit = 20): SOPRun[] {
    return this.store.listRuns(sopName, limit);
  }

  /** Get a specific run. */
  getRun(id: number): SOPRun | undefined {
    return this.store.getRun(id);
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "sop", msg }) + "\n");
}
