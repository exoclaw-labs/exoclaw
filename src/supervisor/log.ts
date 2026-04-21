/**
 * Tagged structured logger for the supervisor.
 *
 * Supervisor events (state transitions, starts, crashes, upgrade steps)
 * are written to stderr as:
 *   <ISO ts> [<tag>] <message>
 *
 * Unit stdout/stderr is persisted to per-unit rotated files under
 * $EXOCLAW_LOG_DIR (default ~/.exoclaw/logs/<tag>.log) — NOT forwarded
 * to stderr. Viewed via the dashboard Logs page or by tailing the file.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from "fs";
import { join } from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const HOME = process.env.HOME || "/home/agent";
const LOG_DIR = process.env.EXOCLAW_LOG_DIR || join(HOME, ".exoclaw", "logs");
const MAX_LOG_BYTES = Number(process.env.EXOCLAW_LOG_MAX_BYTES) || 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED = Number(process.env.EXOCLAW_LOG_MAX_ROTATED) || 3;

export function log(tag: string, level: LogLevel, msg: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} [${tag}] ${level === "info" ? "" : level + ": "}${msg}`;
  process.stderr.write(line + "\n");
}

class UnitLogWriter {
  private stream: WriteStream | null = null;
  private size = 0;
  private readonly path: string;

  constructor(private readonly tag: string) {
    this.path = join(LOG_DIR, `${tag}.log`);
  }

  write(chunk: string): void {
    let out = "";
    const ts = new Date().toISOString();
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      out += `${ts} ${line}\n`;
    }
    if (out.length === 0) return;

    this.ensureStream();
    this.stream!.write(out);
    this.size += Buffer.byteLength(out);
    if (this.size >= MAX_LOG_BYTES) this.rotate();
  }

  private ensureStream(): void {
    if (this.stream) return;
    mkdirSync(LOG_DIR, { recursive: true });
    this.stream = createWriteStream(this.path, { flags: "a" });
    try {
      this.size = statSync(this.path).size;
    } catch {
      this.size = 0;
    }
  }

  private rotate(): void {
    try {
      this.stream?.end();
    } catch {
      /* intentional */
    }
    this.stream = null;
    try {
      const oldest = `${this.path}.${MAX_ROTATED}`;
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = MAX_ROTATED - 1; i >= 1; i--) {
        const src = `${this.path}.${i}`;
        const dst = `${this.path}.${i + 1}`;
        if (existsSync(src)) renameSync(src, dst);
      }
      if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
    } catch (err) {
      process.stderr.write(
        `${new Date().toISOString()} [supervisor] error: log rotation failed for ${this.tag}: ${(err as Error).message}\n`
      );
    }
    this.size = 0;
  }
}

const writers = new Map<string, UnitLogWriter>();

export function forwardToFile(tag: string, chunk: string): void {
  let w = writers.get(tag);
  if (!w) {
    w = new UnitLogWriter(tag);
    writers.set(tag, w);
  }
  try {
    w.write(chunk);
  } catch (err) {
    process.stderr.write(
      `${new Date().toISOString()} [supervisor] error: log write failed for ${tag}: ${(err as Error).message}\n`
    );
  }
}
