/**
 * Multi-Agent System — delegation, swarm coordination, and message routing.
 *
 * Three capabilities:
 *
 * 1. Delegation: spawn sub-agent sessions with isolated context, track progress,
 *    collect results. Parent agent can delegate tasks to named agents.
 *
 * 2. Swarm: orchestrate multiple agents in parallel (fan-out) or sequence (pipeline),
 *    with configurable strategies: sequential, parallel, router.
 *
 * 3. Routing: direct inbound messages to different agents based on channel, user,
 *    or content pattern matching.
 *
 * Inspired by Hermes's delegate_tool, ZeroClaw's swarm.rs, and OpenClaw's routing.
 */

import { execSync, spawn, type ChildProcess } from "child_process";
import { join } from "path";
import type Database from "better-sqlite3";

// ── Types ──

export type DelegationStatus = "running" | "completed" | "failed" | "timeout";
export type SwarmStrategy = "sequential" | "parallel" | "router";

export interface Delegation {
  id: string;
  parentAgent: string;
  childAgent: string;
  prompt: string;
  status: DelegationStatus;
  result: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface SwarmTask {
  agent: string;
  prompt: string;
}

export interface SwarmResult {
  agent: string;
  status: "success" | "error";
  result: string;
  durationMs: number;
}

export interface RoutingRule {
  id: string;
  pattern: string;       // regex pattern for content matching
  channel?: string;      // match specific channel (slack, discord, etc.)
  agent: string;         // target agent name
  priority: number;      // lower = higher priority
}

// ── Delegation ──

export class DelegationManager {
  private running = new Map<string, { proc: ChildProcess; delegation: Delegation }>();
  private model: string;
  private permissionMode: string;

  constructor(model = "claude-sonnet-4-6", permissionMode = "bypassPermissions") {
    this.model = model;
    this.permissionMode = permissionMode;
  }

  /** Delegate a task to a named agent. Returns immediately; poll for result. */
  delegate(parentAgent: string, childAgent: string, prompt: string, timeoutMs = 300_000): Delegation {
    const id = crypto.randomUUID().slice(0, 8);
    const delegation: Delegation = {
      id,
      parentAgent,
      childAgent,
      prompt,
      status: "running",
      result: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
    };

    const args = [
      "-p", "--output-format", "text",
      "--model", this.model,
      "--permission-mode", this.permissionMode,
      "--max-turns", "15",
      `[Delegated from ${parentAgent}] ${prompt}`,
    ];

    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_CRON: "1" },
      cwd: join(process.env.HOME || "/home/agent", "workspace"),
    });
    proc.stdin!.end();

    let stdout = "";
    proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      delegation.status = "timeout";
      delegation.result = "Delegation timed out";
      delegation.finishedAt = new Date().toISOString();
      delegation.durationMs = Date.now() - new Date(delegation.startedAt).getTime();
      this.running.delete(id);
    }, timeoutMs);

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      delegation.status = code === 0 || code === null ? "completed" : "failed";
      delegation.result = stdout.slice(0, 5000);
      delegation.finishedAt = new Date().toISOString();
      delegation.durationMs = Date.now() - new Date(delegation.startedAt).getTime();
      this.running.delete(id);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      delegation.status = "failed";
      delegation.result = String(err);
      delegation.finishedAt = new Date().toISOString();
      delegation.durationMs = Date.now() - new Date(delegation.startedAt).getTime();
      this.running.delete(id);
    });

    this.running.set(id, { proc, delegation });
    return delegation;
  }

  /** Get the status of a delegation. */
  getStatus(id: string): Delegation | undefined {
    return this.running.get(id)?.delegation;
  }

  /** List all active delegations. */
  listActive(): Delegation[] {
    return Array.from(this.running.values()).map(r => r.delegation);
  }

  /** Cancel a running delegation. */
  cancel(id: string): boolean {
    const entry = this.running.get(id);
    if (!entry) return false;
    entry.proc.kill("SIGTERM");
    entry.delegation.status = "failed";
    entry.delegation.result = "Cancelled";
    entry.delegation.finishedAt = new Date().toISOString();
    this.running.delete(id);
    return true;
  }
}

// ── Swarm Coordination ──

export class SwarmCoordinator {
  private model: string;
  private permissionMode: string;

  constructor(model = "claude-sonnet-4-6", permissionMode = "bypassPermissions") {
    this.model = model;
    this.permissionMode = permissionMode;
  }

  /** Execute tasks with the given strategy. */
  async execute(tasks: SwarmTask[], strategy: SwarmStrategy): Promise<SwarmResult[]> {
    switch (strategy) {
      case "sequential":
        return this.runSequential(tasks);
      case "parallel":
        return this.runParallel(tasks);
      case "router":
        return this.runRouter(tasks);
      default:
        throw new Error(`Unknown swarm strategy: ${strategy}`);
    }
  }

  private async runSequential(tasks: SwarmTask[]): Promise<SwarmResult[]> {
    const results: SwarmResult[] = [];
    for (const task of tasks) {
      results.push(await this.runSingle(task));
    }
    return results;
  }

  private async runParallel(tasks: SwarmTask[]): Promise<SwarmResult[]> {
    return Promise.all(tasks.map(t => this.runSingle(t)));
  }

  /** Router: first task is the router, subsequent tasks are candidates. Router picks which to run. */
  private async runRouter(tasks: SwarmTask[]): Promise<SwarmResult[]> {
    if (tasks.length < 2) return this.runSequential(tasks);

    // Use the first task as the routing decision
    const routerResult = await this.runSingle(tasks[0]);
    const results = [routerResult];

    // Parse router output to determine which subsequent tasks to execute
    const output = routerResult.result.toLowerCase();
    for (let i = 1; i < tasks.length; i++) {
      if (output.includes(tasks[i].agent.toLowerCase()) || output.includes(`task ${i}`)) {
        results.push(await this.runSingle(tasks[i]));
      }
    }

    return results;
  }

  private runSingle(task: SwarmTask): Promise<SwarmResult> {
    const start = Date.now();
    return new Promise((resolve) => {
      const proc = spawn("claude", [
        "-p", "--output-format", "text",
        "--model", this.model,
        "--permission-mode", this.permissionMode,
        "--max-turns", "10",
        task.prompt,
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_CRON: "1" },
        cwd: join(process.env.HOME || "/home/agent", "workspace"),
      });
      proc.stdin!.end();

      let stdout = "";
      proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });

      proc.on("exit", (code) => {
        resolve({
          agent: task.agent,
          status: code === 0 || code === null ? "success" : "error",
          result: stdout.slice(0, 5000),
          durationMs: Date.now() - start,
        });
      });
      proc.on("error", (err) => {
        resolve({ agent: task.agent, status: "error", result: String(err), durationMs: Date.now() - start });
      });
    });
  }
}

// ── Message Router ──

export class MessageRouter {
  private rules: RoutingRule[] = [];
  private defaultAgent = "main";

  addRule(rule: Omit<RoutingRule, "id">): RoutingRule {
    const full: RoutingRule = { id: crypto.randomUUID().slice(0, 8), ...rule };
    this.rules.push(full);
    this.rules.sort((a, b) => a.priority - b.priority);
    return full;
  }

  removeRule(id: string): boolean {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx < 0) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /** Determine which agent should handle a message. */
  route(content: string, channel?: string): string {
    for (const rule of this.rules) {
      // Check channel match
      if (rule.channel && rule.channel !== channel) continue;

      // Check content pattern
      try {
        if (new RegExp(rule.pattern, "i").test(content)) {
          return rule.agent;
        }
      } catch {
        // Invalid regex — skip
      }
    }
    return this.defaultAgent;
  }

  listRules(): RoutingRule[] {
    return [...this.rules];
  }

  setDefault(agent: string): void {
    this.defaultAgent = agent;
  }
}
