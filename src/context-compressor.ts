/**
 * Context Compressor — summarizes long conversation histories for cross-session context.
 *
 * When injecting prior session context into a new conversation (e.g. via CLAUDE.md
 * or system prompt), raw history can be too long. This module compresses conversation
 * history into structured summaries.
 *
 * Structure (inspired by Hermes's context_compressor.py):
 *   - Goal: what the user was trying to accomplish
 *   - Progress: what was done so far
 *   - Decisions: key choices made and their rationale
 *   - Files: important files touched
 *   - Next Steps: what remains to be done
 *
 * Uses claude -p for LLM-based compression (Claude-first approach).
 */

import { execSync } from "child_process";
import { join } from "path";
import type { SessionDB } from "./session-db.js";

export interface CompressedContext {
  session_id: number;
  title: string | null;
  summary: string;
  compressed_at: string;
}

const COMPRESSION_PROMPT = `Summarize the following conversation into a structured brief that a future AI assistant can use as context. Be concise but preserve critical details.

## Output Format

**Goal:** [What the user was trying to accomplish]
**Progress:** [What was done — completed steps, key results]
**Decisions:** [Important choices made and why]
**Files:** [Key files created/modified]
**Next Steps:** [What remains to be done, if anything]
**Key Facts:** [User preferences, environment details, or constraints learned]

Keep the summary under 500 words. Focus on information a future session would need to continue the work.

## Conversation

`;

/**
 * Compress a session's messages into a structured summary.
 * Uses claude -p to generate the summary.
 */
export async function compressSession(
  db: SessionDB,
  sessionId: number,
  model = "claude-sonnet-4-6",
): Promise<CompressedContext | null> {
  const messages = db.getSessionMessages(sessionId, 200);
  if (messages.length < 3) return null; // Too short to compress

  // Build a condensed transcript
  const transcript = messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => `[${m.role}]: ${m.content.slice(0, 1000)}`)
    .join("\n\n");

  if (transcript.length < 200) return null;

  // Truncate very long transcripts (keep head + tail)
  let prompt = COMPRESSION_PROMPT;
  if (transcript.length > 30_000) {
    const head = transcript.slice(0, 15_000);
    const tail = transcript.slice(-15_000);
    prompt += head + "\n\n[... middle of conversation omitted ...]\n\n" + tail;
  } else {
    prompt += transcript;
  }

  try {
    const result = execSync(
      `claude -p --output-format text --model ${model} --permission-mode bypassPermissions --max-turns 1`,
      {
        input: prompt,
        encoding: "utf-8",
        timeout: 120_000,
        cwd: join(process.env.HOME || "/home/agent", "workspace"),
        env: process.env,
      },
    );

    const session = db.listSessions(1, 0).find((s: any) => s.id === sessionId);

    return {
      session_id: sessionId,
      title: session?.title || null,
      summary: result.trim().slice(0, 3000),
      compressed_at: new Date().toISOString(),
    };
  } catch (err) {
    log("error", `Compression failed for session ${sessionId}: ${err}`);
    return null;
  }
}

/**
 * Compress the N most recent sessions into a combined context brief.
 * Useful for injecting into system prompts or CLAUDE.md.
 */
export async function compressRecentSessions(
  db: SessionDB,
  count = 3,
  model = "claude-sonnet-4-6",
): Promise<string> {
  const sessions = db.listSessions(count, 0);
  const summaries: CompressedContext[] = [];

  for (const session of sessions) {
    const summary = await compressSession(db, session.id, model);
    if (summary) summaries.push(summary);
  }

  if (summaries.length === 0) return "";

  return summaries
    .map(s => `## Session: ${s.title || "Untitled"}\n${s.summary}`)
    .join("\n\n---\n\n");
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "context-compressor", msg }) + "\n");
}
