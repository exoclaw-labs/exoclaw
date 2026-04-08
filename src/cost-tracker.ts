/**
 * Cost Tracker — accumulates token usage and cost data from Agent SDK queries.
 *
 * Stores per-query usage in SQLite and provides:
 *   - Aggregate cost/token reports (daily, monthly, all-time)
 *   - Per-model usage breakdown
 *   - Budget enforcement with configurable daily/monthly limits
 *
 * Inspired by zeroclaw's cost tracking (src/cost/) and hermes's usage_pricing.py.
 */

import type Database from "better-sqlite3";

// ── Types ──

export interface UsageRecord {
  id?: number;
  timestamp: string;
  session_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  model: string;
  duration_ms: number;
  num_turns: number;
}

export interface UsageSummary {
  period: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  query_count: number;
  by_model: { model: string; cost_usd: number; input_tokens: number; output_tokens: number; queries: number }[];
  by_day: { date: string; cost_usd: number; queries: number }[];
}

export interface BudgetConfig {
  enabled: boolean;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
}

export interface BudgetStatus {
  daily_spent_usd: number;
  daily_limit_usd: number;
  daily_remaining_usd: number;
  monthly_spent_usd: number;
  monthly_limit_usd: number;
  monthly_remaining_usd: number;
  exceeded: boolean;
  exceeded_reason: string | null;
}

// ── Store ──

class CostStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        session_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        num_turns INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_records(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records(model);
    `);
  }

  record(usage: Omit<UsageRecord, "id">): void {
    this.db.prepare(`
      INSERT INTO usage_records (timestamp, session_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, model, duration_ms, num_turns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      usage.timestamp,
      usage.session_id,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_tokens,
      usage.cache_creation_tokens,
      usage.cost_usd,
      usage.model,
      usage.duration_ms,
      usage.num_turns,
    );
  }

  /** Get total cost for today (UTC). */
  dailySpent(): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_records
      WHERE date(timestamp) = date('now')
    `).get() as { total: number };
    return row.total;
  }

  /** Get total cost for the current month (UTC). */
  monthlySpent(): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_records
      WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
    `).get() as { total: number };
    return row.total;
  }

  /** Get usage summary for the last N days. */
  summary(days: number): UsageSummary {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const totals = this.db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens,
        COUNT(*) as query_count
      FROM usage_records WHERE timestamp >= ?
    `).get(since) as any;

    const byModel = this.db.prepare(`
      SELECT
        model,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COUNT(*) as queries
      FROM usage_records WHERE timestamp >= ?
      GROUP BY model ORDER BY cost_usd DESC
    `).all(since) as any[];

    const byDay = this.db.prepare(`
      SELECT
        date(timestamp) as date,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COUNT(*) as queries
      FROM usage_records WHERE timestamp >= ?
      GROUP BY date(timestamp) ORDER BY date DESC
    `).all(since) as any[];

    return {
      period: `last_${days}_days`,
      total_cost_usd: totals.total_cost_usd,
      total_input_tokens: totals.total_input_tokens,
      total_output_tokens: totals.total_output_tokens,
      total_cache_read_tokens: totals.total_cache_read_tokens,
      total_cache_creation_tokens: totals.total_cache_creation_tokens,
      query_count: totals.query_count,
      by_model: byModel,
      by_day: byDay,
    };
  }

  /** Prune records older than N days. */
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db.prepare("DELETE FROM usage_records WHERE timestamp < ?").run(cutoff).changes;
  }
}

// ── Cost Tracker ──

export class CostTracker {
  private store: CostStore;
  private budget: BudgetConfig;

  constructor(db: Database.Database, budget?: Partial<BudgetConfig>) {
    this.store = new CostStore(db);
    this.budget = {
      enabled: budget?.enabled ?? false,
      dailyLimitUsd: budget?.dailyLimitUsd ?? 50,
      monthlyLimitUsd: budget?.monthlyLimitUsd ?? 500,
    };
  }

  /**
   * Record usage from an SDK result.
   * Called after each query() completes (success or error).
   */
  recordUsage(data: {
    sessionId: string | null;
    costUsd: number;
    usage: Record<string, number>;
    modelUsage: Record<string, Record<string, any>>;
    durationMs: number;
    numTurns: number;
  }): void {
    // Record per-model usage
    for (const [model, mu] of Object.entries(data.modelUsage)) {
      this.store.record({
        timestamp: new Date().toISOString(),
        session_id: data.sessionId,
        input_tokens: mu.inputTokens ?? 0,
        output_tokens: mu.outputTokens ?? 0,
        cache_read_tokens: mu.cacheReadInputTokens ?? 0,
        cache_creation_tokens: mu.cacheCreationInputTokens ?? 0,
        cost_usd: mu.costUSD ?? 0,
        model,
        duration_ms: data.durationMs,
        num_turns: data.numTurns,
      });
    }

    // If no per-model breakdown, record as aggregate
    if (Object.keys(data.modelUsage).length === 0) {
      this.store.record({
        timestamp: new Date().toISOString(),
        session_id: data.sessionId,
        input_tokens: data.usage.input_tokens ?? 0,
        output_tokens: data.usage.output_tokens ?? 0,
        cache_read_tokens: data.usage.cache_read_input_tokens ?? 0,
        cache_creation_tokens: data.usage.cache_creation_input_tokens ?? 0,
        cost_usd: data.costUsd,
        model: "unknown",
        duration_ms: data.durationMs,
        num_turns: data.numTurns,
      });
    }
  }

  /** Check if budget allows a new query. */
  checkBudget(): BudgetStatus {
    const dailySpent = this.store.dailySpent();
    const monthlySpent = this.store.monthlySpent();
    const dailyRemaining = Math.max(0, this.budget.dailyLimitUsd - dailySpent);
    const monthlyRemaining = Math.max(0, this.budget.monthlyLimitUsd - monthlySpent);

    let exceeded = false;
    let exceededReason: string | null = null;

    if (this.budget.enabled) {
      if (dailySpent >= this.budget.dailyLimitUsd) {
        exceeded = true;
        exceededReason = `Daily budget exceeded: $${dailySpent.toFixed(2)} / $${this.budget.dailyLimitUsd.toFixed(2)}`;
      } else if (monthlySpent >= this.budget.monthlyLimitUsd) {
        exceeded = true;
        exceededReason = `Monthly budget exceeded: $${monthlySpent.toFixed(2)} / $${this.budget.monthlyLimitUsd.toFixed(2)}`;
      }
    }

    return {
      daily_spent_usd: dailySpent,
      daily_limit_usd: this.budget.dailyLimitUsd,
      daily_remaining_usd: dailyRemaining,
      monthly_spent_usd: monthlySpent,
      monthly_limit_usd: this.budget.monthlyLimitUsd,
      monthly_remaining_usd: monthlyRemaining,
      exceeded,
      exceeded_reason: exceededReason,
    };
  }

  /** Get usage summary for the last N days. */
  summary(days = 30): UsageSummary {
    return this.store.summary(days);
  }

  /** Prune old records. */
  prune(days = 90): number {
    return this.store.prune(days);
  }

  /** Update budget config at runtime. */
  updateBudget(budget: Partial<BudgetConfig>): void {
    if (budget.enabled !== undefined) this.budget.enabled = budget.enabled;
    if (budget.dailyLimitUsd !== undefined) this.budget.dailyLimitUsd = budget.dailyLimitUsd;
    if (budget.monthlyLimitUsd !== undefined) this.budget.monthlyLimitUsd = budget.monthlyLimitUsd;
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "cost-tracker", msg }) + "\n");
}
