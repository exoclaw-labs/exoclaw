/**
 * Session Indexer — scans Claude Code's JSONL session files and indexes them into SessionDB.
 *
 * On startup, scans all existing JSONL files. Then periodically re-indexes
 * the active session to pick up new messages.
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { SessionDB } from "./session-db.js";
import { PROJECT_DIR_SUFFIX } from "./constants.js";

const PROJECT_DIR = join(
  process.env.HOME || "/home/agent",
  ".claude",
  "projects",
  PROJECT_DIR_SUFFIX
);

export class SessionIndexer {
  private db: SessionDB;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private indexIntervalMs: number;

  constructor(db: SessionDB, indexIntervalMs = 30_000) {
    this.db = db;
    this.indexIntervalMs = indexIntervalMs;
  }

  /** Run initial full index, then start periodic re-indexing. */
  start(): void {
    // Index all existing files on startup
    try {
      this.indexAll();
    } catch (err) {
      log("warn", `Initial index failed: ${err}`);
    }

    // Periodic re-index for active session
    this.intervalHandle = setInterval(() => {
      try {
        this.indexAll();
      } catch (err) {
        log("warn", `Periodic index failed: ${err}`);
      }
    }, this.indexIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Scan all JSONL files and index new content. */
  indexAll(): void {
    let files: string[];
    try {
      files = readdirSync(PROJECT_DIR)
        .filter(f => f.endsWith(".jsonl") && !f.includes("/"));
    } catch (err) {
      log("debug", `Project dir not accessible: ${err}`);
      return; // Project dir doesn't exist yet
    }

    for (const filename of files) {
      const filePath = join(PROJECT_DIR, filename);
      this.indexFile(filePath);
    }
  }

  /** Index a single JSONL file from where we left off. */
  private indexFile(filePath: string): void {
    let fileSize: number;
    try {
      fileSize = statSync(filePath).size;
    } catch {
      return;
    }

    const indexedOffset = this.db.getIndexedOffset(filePath);
    if (fileSize <= indexedOffset) return; // No new data

    // Read only the new bytes
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(fileSize - indexedOffset);
    readSync(fd, buf, 0, buf.length, indexedOffset);
    closeSync(fd);

    const newContent = buf.toString("utf-8");
    const lines = newContent.split("\n").filter(Boolean);

    if (lines.length === 0) {
      this.db.setIndexedOffset(filePath, fileSize);
      return;
    }

    const sessionId = this.db.getOrCreateSession(filePath);
    let firstUserMessage: string | null = null;
    let messageCount = 0;

    this.db.transaction(() => {
      for (const line of lines) {
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        const msg = entry.message || {};
        const content = msg.content;
        const entryType = entry.type;
        const timestamp = entry.timestamp || new Date().toISOString();

        // User text messages
        if (entryType === "user" && typeof content === "string") {
          this.db.insertMessage(sessionId, "user", content, undefined, timestamp);
          if (!firstUserMessage) firstUserMessage = content.slice(0, 100);
          messageCount++;
        } else if (entryType === "user" && Array.isArray(content)) {
          const text = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          if (text) {
            this.db.insertMessage(sessionId, "user", text, undefined, timestamp);
            if (!firstUserMessage) firstUserMessage = text.slice(0, 100);
            messageCount++;
          }
        }

        // Tool results from user messages
        if (entryType === "user" && entry.toolUseResult?.stdout) {
          this.db.insertMessage(sessionId, "tool_result", entry.toolUseResult.stdout.slice(0, 2000), undefined, timestamp);
          messageCount++;
        }

        // Assistant messages
        if (entryType === "assistant" && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              this.db.insertMessage(sessionId, "assistant", block.text, undefined, timestamp);
              messageCount++;
            }
            if (block.type === "tool_use") {
              const toolContent = `${block.name}: ${JSON.stringify(block.input || {}).slice(0, 500)}`;
              this.db.insertMessage(sessionId, "tool_use", toolContent, block.name, timestamp);
              messageCount++;
            }
          }
        }
      }

      this.db.setIndexedOffset(filePath, fileSize);

      // Use first user message as session title if we don't have one yet
      if (messageCount > 0) {
        this.db.updateSession(sessionId, firstUserMessage || undefined);
      }
    });

    if (messageCount > 0) {
      log("info", `Indexed ${messageCount} messages from ${filePath.split("/").pop()}`);
    }
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "session-indexer", msg }) + "\n");
}
