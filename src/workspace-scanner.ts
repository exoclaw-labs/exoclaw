/**
 * Workspace File Scanner — watches the agent workspace for credential leaks.
 *
 * The content scanner (content-scanner.ts) only checks inbound/outbound messages.
 * This module watches files that Claude Code creates or modifies in the workspace,
 * scanning them for credential patterns (API keys, tokens, passwords).
 *
 * When a leak is detected, it logs an audit event and broadcasts an alert.
 * Does NOT delete or modify files — only alerts.
 *
 * Inspired by OpenClaw's workspace scanning and ZeroClaw's leak_detector.rs.
 */

import { watch, readFileSync, statSync } from "fs";
import { join, extname } from "path";

// File extensions worth scanning (skip binaries, images, etc.)
const SCANNABLE_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".ts", ".js", ".py", ".sh", ".bash", ".zsh",
  ".env", ".cfg", ".conf", ".ini", ".xml",
  ".html", ".css", ".sql", ".csv",
]);

// Max file size to scan (skip large files)
const MAX_FILE_SIZE = 512 * 1024; // 512KB

export interface WorkspaceScanAlert {
  file: string;
  reason: string;
  pattern: string;
  timestamp: string;
}

type AlertListener = (alert: WorkspaceScanAlert) => void;

export class WorkspaceScanner {
  private watcher: ReturnType<typeof watch> | null = null;
  private workspacePath: string;
  private listeners: AlertListener[] = [];
  private scanForLeaks: ((text: string) => { leaked: boolean; reason?: string; pattern?: string }) | null = null;
  private recentAlerts: WorkspaceScanAlert[] = [];

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  async start(): Promise<void> {
    // Lazy import to avoid circular dependency
    const { scanForLeaks } = await import("./content-scanner.js");
    this.scanForLeaks = scanForLeaks;

    try {
      this.watcher = watch(this.workspacePath, { recursive: true }, (eventType, filename) => {
        if (!filename || eventType !== "change") return;
        this.onFileChange(filename);
      });
      log("info", `Workspace scanner started (watching ${this.workspacePath})`);
    } catch (err) {
      log("error", `Failed to start workspace scanner: ${err}`);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  onAlert(listener: AlertListener): void {
    this.listeners.push(listener);
  }

  getRecentAlerts(): WorkspaceScanAlert[] {
    return this.recentAlerts;
  }

  private onFileChange(relativePath: string): void {
    // Skip non-scannable files
    const ext = extname(relativePath).toLowerCase();
    if (!SCANNABLE_EXTENSIONS.has(ext) && !relativePath.endsWith(".env")) return;

    // Skip .git, node_modules, and other noisy directories
    if (relativePath.includes(".git/") || relativePath.includes("node_modules/")) return;

    const fullPath = join(this.workspacePath, relativePath);

    try {
      const stat = statSync(fullPath);
      if (stat.size > MAX_FILE_SIZE) return;

      const content = readFileSync(fullPath, "utf-8");
      if (!this.scanForLeaks) return;

      const result = this.scanForLeaks(content);
      if (result.leaked) {
        const alert: WorkspaceScanAlert = {
          file: relativePath,
          reason: result.reason || "Credential pattern detected",
          pattern: result.pattern || "unknown",
          timestamp: new Date().toISOString(),
        };
        this.recentAlerts.push(alert);
        if (this.recentAlerts.length > 100) this.recentAlerts.shift();

        log("warn", `Credential leak detected in workspace file: ${relativePath} — ${result.reason}`);
        for (const listener of this.listeners) {
          try { listener(alert); } catch { /* intentional */ }
        }
      }
    } catch {
      // File may have been deleted between event and read — ignore
    }
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "workspace-scanner", msg }) + "\n");
}
