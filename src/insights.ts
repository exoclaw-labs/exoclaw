/**
 * Insights Engine — usage analytics and activity tracking.
 *
 * Queries the SessionDB for aggregate statistics:
 *   - Session count and message volume
 *   - Tool usage breakdown
 *   - Messages per day
 *   - Role breakdown (user vs assistant vs tool)
 *   - Hourly activity pattern
 *
 * Adapted from hermes-agent-custom's InsightsEngine (agent/insights.py).
 *
 * Token/cost tracking is handled separately by CostTracker (cost-tracker.ts)
 * which extracts usage data from Agent SDK query results.
 */

import type { SessionDB } from "./session-db.js";

export interface InsightsReport {
  period_days: number;
  sessions: {
    total: number;
  };
  messages: {
    total: number;
    per_day: { date: string; count: number }[];
    by_role: { role: string; count: number }[];
  };
  tools: {
    usage: { tool_name: string; count: number }[];
  };
  activity: {
    by_hour: { hour: number; count: number }[];
  };
}

export function generateInsights(db: SessionDB, days = 30): InsightsReport {
  const stats = db.getStats(days);

  return {
    period_days: days,
    sessions: {
      total: stats.sessionCount,
    },
    messages: {
      total: stats.messageCount,
      per_day: stats.messagesPerDay,
      by_role: stats.roleBreakdown,
    },
    tools: {
      usage: stats.toolUsage,
    },
    activity: {
      by_hour: stats.hourlyActivity,
    },
  };
}
