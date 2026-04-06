/**
 * Background Review Loop — autonomous self-improvement via post-turn analysis.
 *
 * After every N turns, spawns a background `claude -p` process that reviews
 * the recent conversation and decides whether to:
 *   1. Save user preferences/facts to MEMORY.md or USER.md
 *   2. Create or update skills in .claude/skills/
 *
 * Adapted from hermes-agent-custom's background review system
 * (run_agent.py:1779-1900).
 *
 * Non-blocking — runs in background, never delays user responses.
 */

import { spawn } from "child_process";
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync } from "fs";
import { join } from "path";
import { scanContent } from "./content-scanner.js";
import { PROJECT_DIR_SUFFIX } from "./constants.js";

export interface ReviewConfig {
  enabled: boolean;
  intervalTurns: number;
  reviewMemory: boolean;
  reviewSkills: boolean;
}

export interface ReviewEvent {
  type: "memory_saved" | "skill_created" | "skill_updated" | "review_complete" | "review_error";
  detail: string;
}

type ReviewListener = (event: ReviewEvent) => void;

const MEMORY_REVIEW_PROMPT = `You are reviewing a recent conversation to identify things worth remembering for future sessions.

Review the conversation transcript below. Focus on:
- Has the user revealed their persona, role, expertise level, or personal preferences?
- Has the user expressed expectations about how you should behave, their work style, or communication preferences?
- Are there durable facts about their environment, tools, or conventions worth noting?

If you find something worth saving:
- For user profile information: append it to ~/workspace/USER.md
- For durable facts, tool quirks, conventions: append it to ~/workspace/MEMORY.md

Keep entries concise — one fact per line. Don't duplicate entries that already exist.
If nothing is worth saving, just say "Nothing to save." and stop.`;

const SKILL_REVIEW_PROMPT = `You are reviewing a recent conversation to identify reusable procedures worth saving as skills.

Review the conversation transcript below. Focus on:
- Was a non-trivial approach used that required trial and error?
- Did the user expect or desire a different method or outcome, revealing a preferred workflow?
- Was there a multi-step procedure that would be valuable to remember for next time?

If you find a reusable approach, create a skill file at ~/workspace/.claude/skills/<skill-name>/SKILL.md with:
- A clear title and description
- Step-by-step instructions
- Any gotchas or important notes

If a relevant skill already exists in ~/workspace/.claude/skills/, update it with what you learned.
If nothing is worth saving as a skill, just say "Nothing to save." and stop.`;

const COMBINED_REVIEW_PROMPT = `You are reviewing a recent conversation to improve yourself for future sessions.

Review the conversation transcript below and do TWO things:

## 1. Memory Check
Check if the user has revealed preferences, personal details, or expectations:
- User profile info → append to ~/workspace/USER.md
- Durable facts, tool quirks, conventions → append to ~/workspace/MEMORY.md
Keep entries concise (one fact per line). Don't duplicate existing entries.

## 2. Skill Check
Check if a reusable approach was discovered:
- Non-trivial procedures that required trial and error
- Multi-step workflows the user prefers
- Approaches worth remembering for next time

If found, create a skill at ~/workspace/.claude/skills/<name>/SKILL.md with a clear title, step-by-step instructions, and gotchas.

If NOTHING is worth saving for either category, just say "Nothing to save." and stop.
Do NOT create trivial or obvious entries.`;

export class BackgroundReviewer {
  private config: ReviewConfig;
  private turnCount = 0;
  private reviewing = false;
  private listeners: ReviewListener[] = [];
  private model: string;
  private permissionMode: string;

  constructor(config: ReviewConfig, model = "sonnet", permissionMode = "bypassPermissions") {
    this.config = config;
    this.model = model;
    this.permissionMode = permissionMode;
  }

  /** Register a listener for review events. */
  onEvent(listener: ReviewListener): void {
    this.listeners.push(listener);
  }

  private emit(event: ReviewEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  /**
   * Called after each turn completes. Increments the turn counter
   * and triggers a background review when the interval is reached.
   */
  onTurnComplete(): void {
    if (!this.config.enabled) return;

    this.turnCount++;

    if (this.turnCount >= this.config.intervalTurns) {
      this.turnCount = 0;
      this.triggerReview();
    }
  }

  /** Manually trigger a review (e.g., from API). */
  triggerReview(): void {
    if (this.reviewing) {
      log("info", "Review already in progress, skipping");
      return;
    }

    // Run in background — don't await
    this.runReview().catch(err => {
      log("error", `Review failed: ${err}`);
      this.emit({ type: "review_error", detail: String(err) });
    });
  }

  private async runReview(): Promise<void> {
    this.reviewing = true;

    try {
      // Build transcript from recent session JSONL
      const transcript = this.getRecentTranscript();
      if (!transcript) {
        log("info", "No recent conversation to review");
        this.emit({ type: "review_complete", detail: "No conversation to review" });
        return;
      }

      // Snapshot workspace files before the review to detect changes
      const snapshotBefore = this.snapshotWorkspaceFiles();

      // Build the review prompt
      let reviewPrompt: string;
      if (this.config.reviewMemory && this.config.reviewSkills) {
        reviewPrompt = COMBINED_REVIEW_PROMPT;
      } else if (this.config.reviewMemory) {
        reviewPrompt = MEMORY_REVIEW_PROMPT;
      } else {
        reviewPrompt = SKILL_REVIEW_PROMPT;
      }

      const fullPrompt = `${reviewPrompt}\n\n## Recent Conversation Transcript\n\n${transcript}`;

      // Spawn claude -p to do the review
      log("info", "Starting background review");
      const result = await this.spawnClaudeReview(fullPrompt);

      // Check what changed
      const snapshotAfter = this.snapshotWorkspaceFiles();
      const changes = this.detectChanges(snapshotBefore, snapshotAfter);

      // Scan any modified files for injection
      for (const change of changes) {
        if (change.type === "modified" || change.type === "created") {
          try {
            const content = readFileSync(change.path, "utf-8");
            const scan = scanContent(content);
            if (scan.blocked) {
              log("warn", `Background review wrote suspicious content to ${change.path}: ${scan.reason}. Reverting.`);
              // Revert to before
              const original = snapshotBefore.get(change.path);
              if (original !== undefined) {
                const { writeFileSync } = await import("fs");
                writeFileSync(change.path, original);
              }
              this.emit({ type: "review_error", detail: `Blocked suspicious write to ${change.name}: ${scan.reason}` });
              continue;
            }
          } catch {}
        }

        // Emit events for changes
        if (change.name.endsWith("MEMORY.md") || change.name.endsWith("USER.md")) {
          this.emit({ type: "memory_saved", detail: `Updated ${change.name}` });
        } else if (change.path.includes(".claude/skills/")) {
          const eventType = change.type === "created" ? "skill_created" : "skill_updated";
          this.emit({ type: eventType, detail: `${change.type === "created" ? "Created" : "Updated"} skill: ${change.name}` });
        }
      }

      if (changes.length === 0 && result.includes("Nothing to save")) {
        log("info", "Background review: nothing to save");
      }

      this.emit({ type: "review_complete", detail: `Review complete. ${changes.length} file(s) changed.` });
      log("info", `Background review complete. ${changes.length} change(s).`);

    } finally {
      this.reviewing = false;
    }
  }

  /** Read recent conversation from the most recent session JSONL file. */
  private getRecentTranscript(maxMessages = 30): string | null {
    const projectDir = join(
      process.env.HOME || "/home/agent",
      ".claude", "projects", PROJECT_DIR_SUFFIX
    );

    let sessionFile: string;
    try {
      const files = readdirSync(projectDir)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (!files.length) return null;
      sessionFile = join(projectDir, files[0].name);
    } catch {
      return null;
    }

    const lines = readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean);
    // Take last N messages
    const recentLines = lines.slice(-maxMessages * 2); // Take extra since not all lines are messages

    const transcript: string[] = [];

    for (const line of recentLines) {
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }

      const msg = entry.message || {};
      const content = msg.content;

      if (entry.type === "user" && typeof content === "string") {
        transcript.push(`USER: ${content}`);
      } else if (entry.type === "user" && Array.isArray(content)) {
        const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        if (text) transcript.push(`USER: ${text}`);
      }

      if (entry.type === "assistant" && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            transcript.push(`ASSISTANT: ${block.text}`);
          }
          if (block.type === "tool_use") {
            transcript.push(`ASSISTANT [tool: ${block.name}]: ${JSON.stringify(block.input || {}).slice(0, 300)}`);
          }
        }
      }
    }

    // Limit total transcript size
    const result = transcript.slice(-maxMessages).join("\n\n");
    return result || null;
  }

  /** Spawn a claude -p process for the review. Returns the output text. */
  private spawnClaudeReview(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "-p",
        "--output-format", "text",
        "--model", this.model,
        "--permission-mode", this.permissionMode,
        "--max-turns", "8",
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

      proc.stdout!.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

      // Timeout after 3 minutes
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error("Review process timed out"));
      }, 3 * 60 * 1000);

      proc.on("exit", (code) => {
        clearTimeout(timeout);
        if (code !== 0 && code !== null) {
          log("warn", `Review process exited with code ${code}: ${stderr.slice(0, 200)}`);
        }
        resolve(stdout);
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /** Snapshot key workspace files to detect changes after review. */
  private snapshotWorkspaceFiles(): Map<string, string> {
    const ws = join(process.env.HOME || "/home/agent", "workspace");
    const snapshot = new Map<string, string>();

    // Memory/config files
    for (const name of ["MEMORY.md", "USER.md", "IDENTITY.md", "SOUL.md"]) {
      const path = join(ws, name);
      try { snapshot.set(path, readFileSync(path, "utf-8")); } catch { snapshot.set(path, ""); }
    }

    // Skill files
    const skillsDir = join(ws, ".claude", "skills");
    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = join(skillsDir, entry.name, "SKILL.md");
          try { snapshot.set(skillPath, readFileSync(skillPath, "utf-8")); } catch {}
        }
      }
    } catch {}

    return snapshot;
  }

  /** Detect which files changed between two snapshots. */
  private detectChanges(before: Map<string, string>, after: Map<string, string>): { path: string; name: string; type: "created" | "modified" }[] {
    const changes: { path: string; name: string; type: "created" | "modified" }[] = [];

    // Also check for new files not in the before snapshot
    const ws = join(process.env.HOME || "/home/agent", "workspace");
    const skillsDir = join(ws, ".claude", "skills");

    // Re-scan skill files (new skills may have been created)
    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = join(skillsDir, entry.name, "SKILL.md");
          try {
            const content = readFileSync(skillPath, "utf-8");
            if (!before.has(skillPath)) {
              after.set(skillPath, content);
            }
          } catch {}
        }
      }
    } catch {}

    // Check memory/config files that might have been created
    for (const name of ["MEMORY.md", "USER.md"]) {
      const path = join(ws, name);
      if (!before.has(path) || before.get(path) === "") {
        try {
          const content = readFileSync(path, "utf-8");
          if (content) after.set(path, content);
        } catch {}
      }
    }

    for (const [path, afterContent] of after) {
      const beforeContent = before.get(path);
      if (beforeContent === undefined) {
        if (afterContent) {
          changes.push({ path, name: path.split("/").pop() || path, type: "created" });
        }
      } else if (beforeContent !== afterContent) {
        changes.push({ path, name: path.split("/").pop() || path, type: "modified" });
      }
    }

    return changes;
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "background-review", msg }) + "\n");
}
