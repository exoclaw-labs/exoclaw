/**
 * Embeddings — optional vector search for session memory.
 *
 * When an embedding API key is configured, generates vector embeddings
 * for messages and enables semantic search alongside FTS5 keyword search.
 * Results are merged using weighted hybrid scoring (default: 70% vector, 30% keyword).
 *
 * Supports: OpenAI text-embedding-3-small (default), or any OpenAI-compatible endpoint.
 *
 * Falls back gracefully to keyword-only search when no API key is configured.
 */

import Database from "better-sqlite3";

export interface EmbeddingConfig {
  enabled: boolean;
  apiKey?: string;
  apiUrl?: string;     // default: https://api.openai.com/v1/embeddings
  model?: string;      // default: text-embedding-3-small
  dimensions?: number; // default: 256 (small for efficiency)
  vectorWeight?: number; // default: 0.7
  keywordWeight?: number; // default: 0.3
}

export interface HybridSearchResult {
  message_id: number;
  session_id: number;
  role: string;
  content: string;
  score: number;
  source: "vector" | "keyword" | "hybrid";
}

export class EmbeddingStore {
  private db: Database.Database;
  private config: EmbeddingConfig;
  private cache = new Map<string, Float32Array>();

  constructor(db: Database.Database, config: EmbeddingConfig) {
    this.db = db;
    this.config = config;
    if (config.enabled) this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS embedding_cache (
        text_hash TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  get isEnabled(): boolean {
    return this.config.enabled && !!this.config.apiKey;
  }

  /** Generate embedding for text via the configured API. */
  async embed(text: string): Promise<Float32Array | null> {
    if (!this.isEnabled) return null;

    // Check in-memory cache
    const hash = simpleHash(text);
    if (this.cache.has(hash)) return this.cache.get(hash)!;

    // Check DB cache
    const cached = this.db.prepare("SELECT embedding FROM embedding_cache WHERE text_hash = ?").get(hash) as { embedding: Buffer } | undefined;
    if (cached) {
      const vec = new Float32Array(cached.embedding.buffer, cached.embedding.byteOffset, cached.embedding.byteLength / 4);
      this.cache.set(hash, vec);
      return vec;
    }

    // Call API
    const apiUrl = this.config.apiUrl || "https://api.openai.com/v1/embeddings";
    const model = this.config.model || "text-embedding-3-small";
    const dimensions = this.config.dimensions || 256;

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          input: text.slice(0, 8000), // Limit input size
          model,
          dimensions,
        }),
      });

      if (!response.ok) return null;

      const data = await response.json() as { data: { embedding: number[] }[] };
      const vec = new Float32Array(data.data[0].embedding);

      // Cache in DB
      const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      this.db.prepare("INSERT OR REPLACE INTO embedding_cache (text_hash, embedding) VALUES (?, ?)").run(hash, buf);

      this.cache.set(hash, vec);
      return vec;
    } catch {
      return null;
    }
  }

  /** Store embedding for a message. */
  async indexMessage(messageId: number, content: string): Promise<void> {
    if (!this.isEnabled) return;

    const vec = await this.embed(content);
    if (!vec) return;

    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (message_id, embedding, model)
      VALUES (?, ?, ?)
    `).run(messageId, buf, this.config.model || "text-embedding-3-small");
  }

  /** Search by vector similarity. Returns message IDs with cosine similarity scores. */
  async searchVector(query: string, limit = 20): Promise<{ message_id: number; score: number }[]> {
    if (!this.isEnabled) return [];

    const queryVec = await this.embed(query);
    if (!queryVec) return [];

    // Load all embeddings (for small datasets this is fine; for large ones we'd need an index)
    const rows = this.db.prepare("SELECT message_id, embedding FROM embeddings").all() as { message_id: number; embedding: Buffer }[];

    const results: { message_id: number; score: number }[] = [];
    for (const row of rows) {
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const score = cosineSimilarity(queryVec, vec);
      if (score > 0.3) { // Minimum similarity threshold
        results.push({ message_id: row.message_id, score });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Hybrid search: combines FTS5 keyword results with vector similarity.
   * Falls back to keyword-only when embeddings aren't available.
   */
  async hybridSearch(query: string, limit = 20): Promise<HybridSearchResult[]> {
    const vectorWeight = this.config.vectorWeight ?? 0.7;
    const keywordWeight = this.config.keywordWeight ?? 0.3;

    // Keyword search via FTS5 (always available)
    const keywordResults = this.db.prepare(`
      SELECT m.id as message_id, m.session_id, m.role, m.content,
             rank as raw_score
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit * 2) as { message_id: number; session_id: number; role: string; content: string; raw_score: number }[];

    if (!this.isEnabled) {
      // Keyword-only mode
      return keywordResults.slice(0, limit).map(r => ({
        ...r,
        score: Math.abs(r.raw_score), // FTS5 rank is negative (lower = better)
        source: "keyword" as const,
      }));
    }

    // Vector search
    const vectorResults = await this.searchVector(query, limit * 2);

    // Merge results
    const merged = new Map<number, HybridSearchResult>();

    // Normalize keyword scores (0-1 range)
    const maxKeyword = Math.max(...keywordResults.map(r => Math.abs(r.raw_score)), 1);
    for (const r of keywordResults) {
      const normalizedScore = Math.abs(r.raw_score) / maxKeyword;
      merged.set(r.message_id, {
        message_id: r.message_id,
        session_id: r.session_id,
        role: r.role,
        content: r.content,
        score: normalizedScore * keywordWeight,
        source: "keyword",
      });
    }

    // Merge vector scores
    for (const v of vectorResults) {
      const existing = merged.get(v.message_id);
      if (existing) {
        existing.score += v.score * vectorWeight;
        existing.source = "hybrid";
      } else {
        // Need to fetch message details
        const msg = this.db.prepare("SELECT session_id, role, content FROM messages WHERE id = ?").get(v.message_id) as { session_id: number; role: string; content: string } | undefined;
        if (msg) {
          merged.set(v.message_id, {
            message_id: v.message_id,
            session_id: msg.session_id,
            role: msg.role,
            content: msg.content,
            score: v.score * vectorWeight,
            source: "vector",
          });
        }
      }
    }

    return Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/** Cosine similarity between two vectors. */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Simple string hash for caching. */
function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}
