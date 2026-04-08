/**
 * Session Database — SQLite with FTS5 for full-text search over past conversations.
 *
 * Indexes Claude Code's JSONL session files into a structured, searchable database.
 * Used by the session search API, insights engine, and the session_search MCP tool.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";
import { RETENTION_DAYS, MS_PER_DAY } from "./constants.js";

const STORE_DIR = join(process.env.HOME || "/home/agent", ".exoclaw");
const DB_PATH = join(STORE_DIR, "sessions.db");

export interface SessionRow {
  id: number;
  file_path: string;
  started_at: string;
  ended_at: string | null;
  message_count: number;
  title: string | null;
}

export interface MessageRow {
  id: number;
  session_id: number;
  role: string;
  content: string;
  tool_name: string | null;
  timestamp: string;
}

export interface SearchResult {
  session_id: number;
  session_title: string | null;
  session_started_at: string;
  message_id: number;
  role: string;
  content: string;
  snippet: string;
  rank: number;
}

export class SessionDB {
  readonly db: Database.Database;

  constructor(dbPath?: string) {
    mkdirSync(STORE_DIR, { recursive: true });
    this.db = new Database(dbPath || DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT UNIQUE NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        title TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content=messages,
        content_rowid=id,
        tokenize='porter unicode61'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      -- Track which files have been indexed and up to what byte offset
      CREATE TABLE IF NOT EXISTS indexed_files (
        file_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        last_indexed TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /** Get or create a session for a given JSONL file path. */
  getOrCreateSession(filePath: string): number {
    const existing = this.db.prepare("SELECT id FROM sessions WHERE file_path = ?").get(filePath) as { id: number } | undefined;
    if (existing) return existing.id;

    const result = this.db.prepare("INSERT INTO sessions (file_path) VALUES (?)").run(filePath);
    return Number(result.lastInsertRowid);
  }

  /** Get the byte offset we've already indexed for a file. */
  getIndexedOffset(filePath: string): number {
    const row = this.db.prepare("SELECT byte_offset FROM indexed_files WHERE file_path = ?").get(filePath) as { byte_offset: number } | undefined;
    return row?.byte_offset ?? 0;
  }

  /** Update the indexed byte offset for a file. */
  setIndexedOffset(filePath: string, offset: number): void {
    this.db.prepare(`
      INSERT INTO indexed_files (file_path, byte_offset, last_indexed)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(file_path) DO UPDATE SET byte_offset = ?, last_indexed = datetime('now')
    `).run(filePath, offset, offset);
  }

  /** Insert a message into the database. */
  insertMessage(sessionId: number, role: string, content: string, toolName?: string, timestamp?: string): void {
    this.db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_name, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, role, content, toolName || null, timestamp || new Date().toISOString());
  }

  /** Update session metadata after indexing. */
  updateSession(sessionId: number, title?: string): void {
    const count = this.db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(sessionId) as { c: number };

    const firstMsg = this.db.prepare("SELECT timestamp FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 1").get(sessionId) as { timestamp: string } | undefined;
    const lastMsg = this.db.prepare("SELECT timestamp FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId) as { timestamp: string } | undefined;

    this.db.prepare(`
      UPDATE sessions SET message_count = ?, started_at = ?, ended_at = ?, title = COALESCE(?, title)
      WHERE id = ?
    `).run(count.c, firstMsg?.timestamp || new Date().toISOString(), lastMsg?.timestamp || null, title || null, sessionId);
  }

  /** List recent sessions. */
  listSessions(limit = 50, offset = 0): SessionRow[] {
    return this.db.prepare(`
      SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset) as SessionRow[];
  }

  /** Delete all sessions and messages. */
  clearSessions(): void {
    this.db.exec(`DELETE FROM messages_fts`);
    this.db.exec(`DELETE FROM messages`);
    this.db.exec(`DELETE FROM sessions`);
  }

  /** Full-text search across all messages. Returns grouped results with snippets. */
  search(query: string, limit = 20): SearchResult[] {
    return this.db.prepare(`
      SELECT
        m.session_id,
        s.title AS session_title,
        s.started_at AS session_started_at,
        m.id AS message_id,
        m.role,
        m.content,
        snippet(messages_fts, 0, '<mark>', '</mark>', '...', 40) AS snippet,
        rank
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as SearchResult[];
  }

  /** Get all messages for a session. */
  getSessionMessages(sessionId: number, limit = 500): MessageRow[] {
    return this.db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?
    `).all(sessionId, limit) as MessageRow[];
  }

  /** Get aggregate stats for the insights engine. */
  getStats(days = 30): {
    sessionCount: number;
    messageCount: number;
    toolUsage: { tool_name: string; count: number }[];
    messagesPerDay: { date: string; count: number }[];
    roleBreakdown: { role: string; count: number }[];
    hourlyActivity: { hour: number; count: number }[];
  } {
    const since = new Date(Date.now() - days * MS_PER_DAY).toISOString();

    const sessionCount = (this.db.prepare(`
      SELECT COUNT(*) as c FROM sessions WHERE started_at >= ?
    `).get(since) as { c: number }).c;

    const messageCount = (this.db.prepare(`
      SELECT COUNT(*) as c FROM messages WHERE timestamp >= ?
    `).get(since) as { c: number }).c;

    const toolUsage = this.db.prepare(`
      SELECT tool_name, COUNT(*) as count
      FROM messages
      WHERE tool_name IS NOT NULL AND timestamp >= ?
      GROUP BY tool_name
      ORDER BY count DESC
      LIMIT 20
    `).all(since) as { tool_name: string; count: number }[];

    const messagesPerDay = this.db.prepare(`
      SELECT date(timestamp) as date, COUNT(*) as count
      FROM messages
      WHERE timestamp >= ?
      GROUP BY date(timestamp)
      ORDER BY date ASC
    `).all(since) as { date: string; count: number }[];

    const roleBreakdown = this.db.prepare(`
      SELECT role, COUNT(*) as count
      FROM messages
      WHERE timestamp >= ?
      GROUP BY role
    `).all(since) as { role: string; count: number }[];

    const hourlyActivity = this.db.prepare(`
      SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count
      FROM messages
      WHERE timestamp >= ?
      GROUP BY hour
      ORDER BY hour ASC
    `).all(since) as { hour: number; count: number }[];

    return { sessionCount, messageCount, toolUsage, messagesPerDay, roleBreakdown, hourlyActivity };
  }

  /** Run an indexing operation inside a transaction for performance. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Memory decay — prune old messages and sessions beyond retention period.
   * Keeps sessions but removes individual messages older than the cutoff.
   * Returns the number of messages deleted.
   */
  pruneOldMessages(retentionDays = RETENTION_DAYS): number {
    const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY).toISOString();

    // Delete old messages (FTS triggers handle the FTS table)
    const deleted = this.db.prepare("DELETE FROM messages WHERE timestamp < ?").run(cutoff).changes;

    // Clean up empty sessions
    this.db.prepare(`
      DELETE FROM sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM messages)
    `).run();

    // Clean up indexed_files for deleted sessions
    this.db.prepare(`
      DELETE FROM indexed_files WHERE file_path NOT IN (SELECT file_path FROM sessions)
    `).run();

    return deleted;
  }

  /** Get database size stats for monitoring. */
  getDbStats(): { messageCount: number; sessionCount: number; dbSizeBytes: number } {
    const messageCount = (this.db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;
    const sessionCount = (this.db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;
    const dbSizeBytes = (this.db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number }).size;
    return { messageCount, sessionCount, dbSizeBytes };
  }

  close(): void {
    this.db.close();
  }
}
