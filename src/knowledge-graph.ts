/**
 * Knowledge Graph — structured relationship storage beyond flat MEMORY.md.
 *
 * SQLite-backed graph with typed nodes and directed edges:
 *   Node types: concept, decision, pattern, technology, person, project
 *   Edge types: uses, replaces, extends, related_to, authored_by, applies_to, depends_on
 *
 * Provides structured relationship traversal for the session_search MCP tool,
 * enabling queries like "what technologies does project X use?" or
 * "what patterns apply to authentication?".
 *
 * Inspired by ZeroClaw's knowledge_graph.rs.
 */

import type Database from "better-sqlite3";

// ── Types ──

export type NodeType = "concept" | "decision" | "pattern" | "technology" | "person" | "project" | "lesson";
export type EdgeType = "uses" | "replaces" | "extends" | "related_to" | "authored_by" | "applies_to" | "depends_on";

export interface KGNode {
  id: number;
  type: NodeType;
  name: string;
  description: string;
  tags: string;         // comma-separated
  created_at: string;
  updated_at: string;
}

export interface KGEdge {
  id: number;
  source_id: number;
  target_id: number;
  edge_type: EdgeType;
  weight: number;       // 0.0 - 1.0 importance
  context: string;      // why this relationship exists
  created_at: string;
}

export interface KGSearchResult {
  node: KGNode;
  score: number;
  related: { node: KGNode; edge_type: EdgeType; direction: "outgoing" | "incoming" }[];
}

// ── Store ──

export class KnowledgeGraph {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kg_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_nodes_name_type ON kg_nodes(name, type);

      CREATE TABLE IF NOT EXISTS kg_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
        edge_type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        context TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS kg_fts USING fts5(
        name, description, tags,
        content=kg_nodes,
        content_rowid=id,
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS kg_nodes_ai AFTER INSERT ON kg_nodes BEGIN
        INSERT INTO kg_fts(rowid, name, description, tags)
        VALUES (new.id, new.name, new.description, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS kg_nodes_ad AFTER DELETE ON kg_nodes BEGIN
        INSERT INTO kg_fts(kg_fts, rowid, name, description, tags)
        VALUES ('delete', old.id, old.name, old.description, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS kg_nodes_au AFTER UPDATE ON kg_nodes BEGIN
        INSERT INTO kg_fts(kg_fts, rowid, name, description, tags)
        VALUES ('delete', old.id, old.name, old.description, old.tags);
        INSERT INTO kg_fts(rowid, name, description, tags)
        VALUES (new.id, new.name, new.description, new.tags);
      END;
    `);
  }

  // ── Node operations ──

  upsertNode(type: NodeType, name: string, description = "", tags = ""): KGNode {
    this.db.prepare(`
      INSERT INTO kg_nodes (type, name, description, tags)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name, type) DO UPDATE SET
        description = excluded.description,
        tags = excluded.tags,
        updated_at = datetime('now')
    `).run(type, name, description, tags);

    return this.db.prepare("SELECT * FROM kg_nodes WHERE name = ? AND type = ?").get(name, type) as KGNode;
  }

  getNode(id: number): KGNode | undefined {
    return this.db.prepare("SELECT * FROM kg_nodes WHERE id = ?").get(id) as KGNode | undefined;
  }

  findNode(name: string, type?: NodeType): KGNode | undefined {
    if (type) {
      return this.db.prepare("SELECT * FROM kg_nodes WHERE name = ? AND type = ?").get(name, type) as KGNode | undefined;
    }
    return this.db.prepare("SELECT * FROM kg_nodes WHERE name = ?").get(name) as KGNode | undefined;
  }

  deleteNode(id: number): boolean {
    return this.db.prepare("DELETE FROM kg_nodes WHERE id = ?").run(id).changes > 0;
  }

  listNodes(type?: NodeType, limit = 100): KGNode[] {
    if (type) {
      return this.db.prepare("SELECT * FROM kg_nodes WHERE type = ? ORDER BY updated_at DESC LIMIT ?").all(type, limit) as KGNode[];
    }
    return this.db.prepare("SELECT * FROM kg_nodes ORDER BY updated_at DESC LIMIT ?").all(limit) as KGNode[];
  }

  // ── Edge operations ──

  addEdge(sourceId: number, targetId: number, edgeType: EdgeType, weight = 0.5, context = ""): KGEdge {
    this.db.prepare(`
      INSERT INTO kg_edges (source_id, target_id, edge_type, weight, context)
      VALUES (?, ?, ?, ?, ?)
    `).run(sourceId, targetId, edgeType, weight, context);

    return this.db.prepare("SELECT * FROM kg_edges WHERE source_id = ? AND target_id = ? AND edge_type = ? ORDER BY id DESC LIMIT 1")
      .get(sourceId, targetId, edgeType) as KGEdge;
  }

  removeEdge(id: number): boolean {
    return this.db.prepare("DELETE FROM kg_edges WHERE id = ?").run(id).changes > 0;
  }

  /** Get all edges from/to a node. */
  getEdges(nodeId: number): { outgoing: (KGEdge & { target: KGNode })[]; incoming: (KGEdge & { source: KGNode })[] } {
    const outgoing = this.db.prepare(`
      SELECT e.*, n.id as n_id, n.type as n_type, n.name as n_name, n.description as n_description, n.tags as n_tags
      FROM kg_edges e JOIN kg_nodes n ON e.target_id = n.id
      WHERE e.source_id = ?
    `).all(nodeId).map((row: any) => ({
      ...row,
      target: { id: row.n_id, type: row.n_type, name: row.n_name, description: row.n_description, tags: row.n_tags } as KGNode,
    }));

    const incoming = this.db.prepare(`
      SELECT e.*, n.id as n_id, n.type as n_type, n.name as n_name, n.description as n_description, n.tags as n_tags
      FROM kg_edges e JOIN kg_nodes n ON e.source_id = n.id
      WHERE e.target_id = ?
    `).all(nodeId).map((row: any) => ({
      ...row,
      source: { id: row.n_id, type: row.n_type, name: row.n_name, description: row.n_description, tags: row.n_tags } as KGNode,
    }));

    return { outgoing, incoming };
  }

  // ── Search ──

  /** Full-text search across nodes. */
  search(query: string, limit = 20): KGSearchResult[] {
    const rows = this.db.prepare(`
      SELECT n.*, f.rank
      FROM kg_fts f
      JOIN kg_nodes n ON f.rowid = n.id
      WHERE kg_fts MATCH ?
      ORDER BY f.rank
      LIMIT ?
    `).all(query, limit) as (KGNode & { rank: number })[];

    return rows.map(row => {
      const edges = this.getEdges(row.id);
      return {
        node: row,
        score: -row.rank, // FTS5 rank is negative (lower = better)
        related: [
          ...edges.outgoing.map(e => ({ node: e.target, edge_type: e.edge_type as EdgeType, direction: "outgoing" as const })),
          ...edges.incoming.map(e => ({ node: e.source, edge_type: e.edge_type as EdgeType, direction: "incoming" as const })),
        ],
      };
    });
  }

  /** Traverse the graph starting from a node, following edges up to N hops. */
  traverse(startId: number, maxHops = 2): Map<number, { node: KGNode; hops: number }> {
    const visited = new Map<number, { node: KGNode; hops: number }>();
    const queue: { id: number; hops: number }[] = [{ id: startId, hops: 0 }];

    while (queue.length > 0) {
      const { id, hops } = queue.shift()!;
      if (visited.has(id) || hops > maxHops) continue;

      const node = this.getNode(id);
      if (!node) continue;
      visited.set(id, { node, hops });

      if (hops < maxHops) {
        const edges = this.getEdges(id);
        for (const e of edges.outgoing) queue.push({ id: e.target_id, hops: hops + 1 });
        for (const e of edges.incoming) queue.push({ id: e.source_id, hops: hops + 1 });
      }
    }

    return visited;
  }

  /** Get graph statistics. */
  stats(): { nodeCount: number; edgeCount: number; byType: { type: string; count: number }[] } {
    const nodeCount = (this.db.prepare("SELECT COUNT(*) as c FROM kg_nodes").get() as { c: number }).c;
    const edgeCount = (this.db.prepare("SELECT COUNT(*) as c FROM kg_edges").get() as { c: number }).c;
    const byType = this.db.prepare("SELECT type, COUNT(*) as count FROM kg_nodes GROUP BY type ORDER BY count DESC").all() as { type: string; count: number }[];
    return { nodeCount, edgeCount, byType };
  }
}
