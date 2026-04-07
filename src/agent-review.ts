/**
 * Agent Self-Improvement — post-run review for sub-agents.
 *
 * After each scheduled agent run completes, spawns a lightweight `claude -p`
 * review that reads the agent's directory files + run result, and updates
 * MEMORY.md in the agent directory with lessons learned.
 *
 * The agent directory structure (CLAUDE.md, MEMORY.md, etc.) is stitched
 * into a flat .md file by the server before the next cron run, so updates
 * to any file in the directory are automatically picked up.
 *
 * The review is fast (haiku model, max 5 turns) and non-blocking.
 */

import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { CronJob, CronRun } from "./cron.js";

const AGENTS_DIR = join(process.env.HOME || "/home/agent", "workspace", ".claude", "agents");

function buildReviewPrompt(agentName: string, run: CronRun): string | null {
  const agentDir = join(AGENTS_DIR, agentName);
  const claudeMdPath = join(agentDir, "CLAUDE.md");

  if (!existsSync(claudeMdPath)) {
    log("debug", `No CLAUDE.md for agent '${agentName}', skipping review`);
    return null;
  }

  const claudeMd = readFileSync(claudeMdPath, "utf-8");
  const memoryPath = join(agentDir, "MEMORY.md");
  const existingMemory = existsSync(memoryPath) ? readFileSync(memoryPath, "utf-8") : "";
  const resultSnippet = (run.result || "").slice(0, 3000);

  return `You are reviewing a sub-agent's run to improve its future performance.

## Agent: ${agentName}
## Agent directory: ${agentDir}
## Run status: ${run.status}
## Run result (truncated):
\`\`\`
${resultSnippet}
\`\`\`

## Current agent CLAUDE.md:
\`\`\`markdown
${claudeMd}
\`\`\`

## Current agent MEMORY.md:
\`\`\`markdown
${existingMemory || "(empty — file does not exist yet)"}
\`\`\`

## How the agent directory works

The agent directory at \`${agentDir}\` contains companion files that get **stitched** together into a single prompt before each run:
- \`CLAUDE.md\` — execution plan and rules (do NOT modify unless the plan itself needs fixing)
- \`MEMORY.md\` — lessons learned, patterns, and durable knowledge from past runs (this is where you write)
- Other optional files: IDENTITY.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md

After you make changes, the system automatically re-stitches the flat file for the next cron run.

## Your task

Analyze the run result and update \`${memoryPath}\` with lessons learned:

1. **If the run succeeded**: Note commands that worked, effective approaches, shortcuts, or environmental facts discovered (e.g., "npm ci is faster than npm install in this repo", "the lint config requires trailing newlines").

2. **If the run failed or errored**: Diagnose what went wrong. Record specific fixes — wrong paths, missing tools, incorrect assumptions, timeout issues, auth problems.

3. **If the run was routine with nothing notable**: Do NOT modify any file. Respond with "No updates needed." and stop.

4. **If the execution plan in CLAUDE.md itself is wrong** (a step references a path that doesn't exist, a command that fails every time, etc.): Fix CLAUDE.md directly.

Rules:
- Write to \`${memoryPath}\` — create it if it doesn't exist, append if it does.
- Keep each lesson to 1-2 lines. Use a bullet list under a \`## Lessons Learned\` heading.
- Maximum 15 lessons. When adding new ones, prune the oldest or least valuable.
- Do NOT duplicate lessons that are already recorded.
- If nothing is worth recording, respond with "No updates needed." and stop.`;
}

export function reviewAgentRun(
  agentName: string,
  job: CronJob,
  run: CronRun,
  onComplete?: () => void,
): void {
  const prompt = buildReviewPrompt(agentName, run);
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

    // Re-stitch the agent's flat .md file so the next cron run picks up changes
    try { onComplete?.(); } catch (err) {
      log("warn", `Agent '${agentName}' post-review stitch failed: ${err}`);
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
