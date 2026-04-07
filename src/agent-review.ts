/**
 * Agent Self-Improvement — post-run review for sub-agents.
 *
 * After each scheduled agent run completes, spawns a lightweight `claude -p`
 * review that reads the agent's CLAUDE.md + run result, and updates the
 * CLAUDE.md with lessons learned, execution plan refinements, and patterns.
 *
 * The review is fast (haiku model, max 5 turns) and non-blocking — it runs
 * in the background after the cron listener fires.
 */

import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { CronJob, CronRun } from "./cron.js";

const AGENTS_DIR = join(process.env.HOME || "/home/agent", "workspace", ".claude", "agents");

function buildReviewPrompt(agentName: string, run: CronRun, job: CronJob): string | null {
  const agentDir = join(AGENTS_DIR, agentName);
  const claudeMdPath = join(agentDir, "CLAUDE.md");

  if (!existsSync(claudeMdPath)) {
    log("debug", `No CLAUDE.md for agent '${agentName}', skipping review`);
    return null;
  }

  const claudeMd = readFileSync(claudeMdPath, "utf-8");
  const resultSnippet = (run.result || "").slice(0, 3000);

  return `You are reviewing a sub-agent's run to improve its future performance.

## Agent: ${agentName}
## Run status: ${run.status}
## Run result (truncated):
\`\`\`
${resultSnippet}
\`\`\`

## Current agent CLAUDE.md:
\`\`\`markdown
${claudeMd}
\`\`\`

## Your task

Analyze the run result and update the agent's CLAUDE.md file at \`${claudeMdPath}\` to improve future runs. Specifically:

1. **If the run succeeded**: Look for patterns worth reinforcing — commands that worked, approaches that were effective, shortcuts discovered. Add these to a "## Lessons Learned" section at the bottom of CLAUDE.md (create it if it doesn't exist, append if it does).

2. **If the run failed or errored**: Diagnose what went wrong. Add specific guidance to prevent the same failure — wrong paths, missing tools, incorrect assumptions, timeout issues. Update the execution plan if a step needs to change.

3. **If the run was routine with nothing notable**: Do NOT modify the file. Only update when there's a genuine improvement to capture.

Rules:
- Read the current CLAUDE.md file first, then use the Edit tool to make targeted updates.
- Do NOT rewrite the entire file — make surgical additions/changes.
- Keep lessons concise (1-2 lines each). Delete lessons that are no longer relevant.
- Maximum 10 lessons in the Lessons Learned section — prune the oldest/least valuable when adding new ones.
- If nothing is worth recording, respond with "No updates needed." and stop.`;
}

export function reviewAgentRun(agentName: string, job: CronJob, run: CronRun): void {
  const prompt = buildReviewPrompt(agentName, run, job);
  if (!prompt) return;

  log("info", `Starting self-improvement review for agent '${agentName}'`);

  const args = [
    "-p",
    "--output-format", "text",
    "--model", "claude-haiku-4-5-20251001",
    "--permission-mode", "bypassPermissions",
    "--max-turns", "5",
    prompt,
  ];

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    cwd: join(process.env.HOME || "/tmp", "workspace"),
  });
  proc.stdin!.end();

  let stdout = "";
  let stderr = "";
  proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
  proc.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

  proc.on("exit", (code) => {
    if (code === 0 || code === null) {
      const summary = stdout.slice(0, 200).replace(/\n/g, " ").trim();
      log("info", `Agent '${agentName}' review complete: ${summary || "(no output)"}`);
    } else {
      log("warn", `Agent '${agentName}' review failed (exit ${code}): ${(stderr || stdout).slice(0, 200)}`);
    }
  });

  proc.on("error", (err) => {
    log("warn", `Agent '${agentName}' review spawn error: ${err}`);
  });
}

/** Check if a cron job name corresponds to a registered agent with a directory */
export function isAgentJob(jobName: string): boolean {
  return existsSync(join(AGENTS_DIR, jobName, "CLAUDE.md"));
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "agent-review", msg }) + "\n");
}
