/**
 * Audit Logger — forensic event trail for the gateway.
 *
 * Records tool executions, config changes, auth events, cron runs,
 * E-STOP events, and errors. Stored in SQLite for querying.
 *
 * Inspired by zeroclaw's audit system (src/security/audit.rs).
 */

import Database from "better-sqlite3";

export type AuditEventType =
  | "auth"           // Login, token validation, pairing
  | "config_change"  // Config updates via API
  | "cron_run"       // Scheduled job execution
  | "review"         // Background review events
  | "estop"          // Emergency stop triggered/resumed
  | "file_write"     // Workspace file writes via API
  | "skill_change"   // Skill created/updated/deleted
  | "error"          // System errors
  | "session"        // Session start/restart/close
  | "message";       // Messages sent to/from agent

export interface AuditEvent {
  id?: number;
  timestamp: string;
  event_type: AuditEventType;
  detail: string;
  source?: string;   // "api", "ws", "cron", "review", "system"
  severity?: "info" | "warn" | "error" | "critical";
}

export class AuditLogger {
  private db: Database.Database;
  private enabled: boolean;

  constructor(db: Database.Database, enabled = true) {
    this.db = db;
    this.enabled = enabled;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        event_type TEXT NOT NULL,
        detail TEXT NOT NULL,
        source TEXT,
        severity TEXT NOT NULL DEFAULT 'info'
      );

      CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type);
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(timestamp);
    `);
  }

  log(event: Omit<AuditEvent, "id" | "timestamp">): void {
    if (!this.enabled) return;
    try {
      this.db.prepare(`
        INSERT INTO audit_log (event_type, detail, source, severity)
        VALUES (?, ?, ?, ?)
      `).run(event.event_type, event.detail, event.source || null, event.severity || "info");
    } catch { /* Never let audit logging crash the gateway */ }
  }

  query(filters: {
    event_type?: AuditEventType;
    since?: string;
    until?: string;
    severity?: string;
    limit?: number;
  } = {}): AuditEvent[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.event_type) { conditions.push("event_type = ?"); params.push(filters.event_type); }
    if (filters.since) { conditions.push("timestamp >= ?"); params.push(filters.since); }
    if (filters.until) { conditions.push("timestamp <= ?"); params.push(filters.until); }
    if (filters.severity) { conditions.push("severity = ?"); params.push(filters.severity); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(filters.limit || 100);

    return this.db.prepare(`
      SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ?
    `).all(...params) as AuditEvent[];
  }

  /** Prune old entries beyond retention period. */
  prune(retentionDays = 90): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    return this.db.prepare("DELETE FROM audit_log WHERE timestamp < ?").run(cutoff).changes;
  }
}
