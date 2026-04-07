/**
 * Agent Self-Improvement — post-run review for sub-agents.
 *
 * After each scheduled agent run completes, appends a summary to the
 * agent's MEMORY.md in its directory. The caller is responsible for
 * re-stitching the flat .md file afterwards.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { CronJob, CronRun } from "./cron.js";

const AGENTS_DIR = join(process.env.HOME || "/home/agent", "workspace", ".claude", "agents");
const MAX_LESSONS = 15;

export function reviewAgentRun(agentName: string, job: CronJob, run: CronRun): void {
  const agentDir = join(AGENTS_DIR, agentName);
  if (!existsSync(join(agentDir, "CLAUDE.md"))) return;

  const memoryPath = join(agentDir, "MEMORY.md");
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  // Build a one-line summary of the run
  const resultSnippet = (run.result || "").trim().slice(0, 300).replace(/\n/g, " ");
  const entry = `- **${now}** [${run.status}]: ${resultSnippet || "(no output)"}`;

  // Read or create MEMORY.md
  let memory = "";
  if (existsSync(memoryPath)) {
    memory = readFileSync(memoryPath, "utf-8");
  }

  if (!memory.includes("## Run History")) {
    memory = memory.trimEnd() + "\n\n## Run History\n\n";
  }

  // Append new entry
  const marker = "## Run History";
  const markerIdx = memory.indexOf(marker);
  const before = memory.slice(0, markerIdx + marker.length);
  const after = memory.slice(markerIdx + marker.length);

  // Parse existing entries (lines starting with "- **")
  const lines = after.split("\n");
  const entries: string[] = [];
  const other: string[] = [];
  for (const line of lines) {
    if (line.startsWith("- **")) entries.push(line);
    else if (line.trim()) other.push(line);
  }

  entries.push(entry);

  // Prune oldest if over limit
  while (entries.length > MAX_LESSONS) entries.shift();

  const updated = before + "\n\n" + entries.join("\n") +
    (other.length ? "\n\n" + other.join("\n") : "") + "\n";

  writeFileSync(memoryPath, updated);
  log("info", `Updated MEMORY.md for agent '${agentName}' (${run.status})`);
}

/** Check if a cron job name corresponds to a registered agent with a directory */
export function isAgentJob(jobName: string): boolean {
  return existsSync(join(AGENTS_DIR, jobName, "CLAUDE.md"));
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "agent-review", msg }) + "\n");
}
