/**
 * Agent Registry — file-based agent definitions.
 *
 * Reads agent definition files from ~/.exoclaw/agents/*.md
 * Parses YAML frontmatter + markdown body.
 * Registers agents with the cron scheduler (idempotent).
 * Watches directory for changes and hot-reloads (500ms debounce).
 *
 * Agent file format:
 * ---
 * name: engineering
 * description: Daily feature work and issue resolution
 * schedule: 0 8 * * *
 * model: claude-sonnet-4-6
 * ---
 * Prompt body here...
 */

import { watch, mkdirSync, readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import type { CronScheduler } from "./cron.js";

export interface AgentDefinition {
  /** Unique agent name (from frontmatter) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Cron expression for scheduled runs */
  schedule?: string;
  /** Model override */
  model?: string;
  /** Whether the prompt body is non-empty */
  hasPrompt: boolean;
  /** The full prompt body */
  prompt: string;
  /** Cron job ID if registered with scheduler */
  cronJobId?: string;
  /** Source file path */
  filePath: string;
}

const AGENTS_DIR = join(process.env.HOME || "/home/agent", ".exoclaw", "agents");

/** Parse YAML frontmatter + markdown body from an agent file */
function parseAgentFile(filePath: string): AgentDefinition | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  // Match frontmatter: ---\n...\n---\n
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    log("warn", `Agent file missing frontmatter: ${filePath}`);
    return null;
  }

  const [, yamlBlock, body] = fmMatch;
  const prompt = body.trim();

  // Parse YAML fields with simple regex (no extra deps)
  const getString = (key: string): string | undefined => {
    const m = yamlBlock.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : undefined;
  };

  const name = getString("name");
  if (!name) {
    log("warn", `Agent file missing required 'name' field: ${filePath}`);
    return null;
  }

  return {
    name,
    description: getString("description"),
    schedule: getString("schedule"),
    model: getString("model"),
    hasPrompt: prompt.length > 0,
    prompt,
    filePath,
  };
}

export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>();
  private scheduler: CronScheduler;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(scheduler: CronScheduler) {
    this.scheduler = scheduler;

    // Ensure the agents directory exists
    mkdirSync(AGENTS_DIR, { recursive: true });

    // Initial load
    this.loadAll();

    // Watch for changes
    this.startWatcher();
  }

  /** Load all agent files from the agents directory */
  private loadAll(): void {
    if (!existsSync(AGENTS_DIR)) return;

    let files: string[];
    try {
      files = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md"));
    } catch {
      return;
    }

    for (const file of files) {
      this.loadFile(join(AGENTS_DIR, file));
    }
  }

  /** Parse and register a single agent file */
  private loadFile(filePath: string): void {
    const def = parseAgentFile(filePath);
    if (!def) return;

    // Check if it was previously registered to clean up
    const existing = this.agents.get(def.name);

    // Register with cron scheduler (idempotent — skip if job already exists)
    if (def.schedule && def.hasPrompt) {
      const existingJobs = this.scheduler.listJobs();
      const existingJob = existingJobs.find(j => j.name === def.name);

      if (existingJob) {
        // Already registered — preserve the job ID
        def.cronJobId = existingJob.id;
        log("info", `Agent '${def.name}' already scheduled (job ${existingJob.id}), skipping`);
      } else {
        try {
          const job = this.scheduler.createJob({
            name: def.name,
            job_type: "prompt",
            schedule: def.schedule,
            command: def.prompt,
            model: def.model,
          });
          def.cronJobId = job.id;
          log("info", `Registered agent '${def.name}' with schedule '${def.schedule}' (job ${job.id})`);
        } catch (err) {
          log("error", `Failed to register agent '${def.name}': ${err}`);
        }
      }
    } else if (existing?.cronJobId && !def.schedule) {
      // Schedule was removed — leave the cron job but unlink it from this def
      log("info", `Agent '${def.name}' schedule removed; leaving existing cron job intact`);
    }

    this.agents.set(def.name, def);
    log("info", `Loaded agent: ${def.name}${def.schedule ? ` (${def.schedule})` : " (on-demand)"}`);
  }

  /** Remove an agent from the registry (does NOT delete the cron job) */
  private unloadByPath(filePath: string): void {
    for (const [name, def] of this.agents) {
      if (def.filePath === filePath) {
        this.agents.delete(name);
        log("info", `Unloaded agent: ${name}`);
        break;
      }
    }
  }

  /** Start watching the agents directory for changes */
  private startWatcher(): void {
    try {
      this.watcher = watch(AGENTS_DIR, { persistent: false }, (_event, filename) => {
        if (!filename || !filename.endsWith(".md")) return;

        // Debounce — 500ms
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          const filePath = join(AGENTS_DIR, filename);
          if (existsSync(filePath)) {
            log("info", `Hot-reloading agent file: ${filename}`);
            this.unloadByPath(filePath);
            this.loadFile(filePath);
          } else {
            log("info", `Agent file removed: ${filename}`);
            this.unloadByPath(filePath);
          }
        }, 500);
      });

      log("info", `Watching ${AGENTS_DIR} for agent definition changes`);
    } catch (err) {
      log("warn", `Could not watch agents directory: ${err}`);
    }
  }

  /** Get a single agent by name */
  getAgent(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  /** List all registered agents */
  listAgents(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /** Clean up watcher */
  close(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.watcher) this.watcher.close();
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "agent-registry", msg }) + "\n");
}
