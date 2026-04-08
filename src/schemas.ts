/**
 * Zod schemas for config validation.
 *
 * Used by the PUT /api/config endpoint and to provide proper types
 * for the config store. Uses .passthrough() to allow forward-compatible
 * fields that haven't been added to the schema yet.
 */

import { z } from "@hono/zod-openapi";

export const McpServerDefSchema = z.object({
  enabled: z.boolean().optional(),
  type: z.enum(["stdio", "http"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
}).passthrough();

export const ClaudeConfigSchema = z.object({
  name: z.string().optional(),
  model: z.string(),
  permissionMode: z.string(),
  systemPrompt: z.string().optional(),
  mcpServers: z.record(McpServerDefSchema).optional(),
  agents: z.record(z.object({
    description: z.string(),
    prompt: z.string(),
  })).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  thinkingBudget: z.number().int().min(0).optional(),
  extraFlags: z.array(z.string()).optional(),
  remoteControl: z.boolean().optional(),
}).passthrough();

export const SelfImprovementConfigSchema = z.object({
  backgroundReview: z.object({
    enabled: z.boolean().optional(),
    intervalTurns: z.number().optional(),
    reviewMemory: z.boolean().optional(),
    reviewSkills: z.boolean().optional(),
  }).passthrough().optional(),
  sessionSearch: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
  contentScanning: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
  insights: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
}).passthrough();

export const ChannelConfigSchema = z.object({
  enabled: z.boolean(),
}).passthrough();

export const RateLimitConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxRequestsPerMinute: z.number().positive().optional(),
  maxTrackedIPs: z.number().positive().optional(),
}).passthrough();

export const CronConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().positive().optional(),
  pollingIntervalMs: z.number().positive().optional(),
  defaultTimeoutMs: z.number().positive().optional(),
  catchUpOnStartup: z.boolean().optional(),
}).passthrough();

export const EmbeddingsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().optional(),
  apiUrl: z.string().optional(),
  model: z.string().optional(),
  dimensions: z.number().positive().optional(),
  vectorWeight: z.number().min(0).max(1).optional(),
  keywordWeight: z.number().min(0).max(1).optional(),
}).passthrough();

export const BudgetConfigSchema = z.object({
  enabled: z.boolean().optional(),
  dailyLimitUsd: z.number().positive().optional(),
  monthlyLimitUsd: z.number().positive().optional(),
}).passthrough();

export const QueueConfigSchema = z.object({
  mode: z.enum(["followup", "collect", "reject"]).optional(),
  maxQueueSize: z.number().positive().optional(),
  collectTimeoutMs: z.number().positive().optional(),
  maxWaitMs: z.number().positive().optional(),
}).passthrough();

export const GatewayConfigSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().positive(),
  host: z.string().min(1),
  apiToken: z.string().optional(),
  claudeApiToken: z.string().optional(),
  setupComplete: z.boolean().optional(),
  browserTool: z.enum(["browser-use", "agent-browser", "none"]).optional(),
  claude: ClaudeConfigSchema,
  channels: z.record(ChannelConfigSchema).optional(),
  selfImprovement: SelfImprovementConfigSchema.optional(),
  cron: CronConfigSchema.optional(),
  rateLimit: RateLimitConfigSchema.optional(),
  audit: z.object({
    enabled: z.boolean().optional(),
    retentionDays: z.number().positive().optional(),
  }).passthrough().optional(),
  embeddings: EmbeddingsConfigSchema.optional(),
  budget: BudgetConfigSchema.optional(),
  queue: QueueConfigSchema.optional(),
}).passthrough();

/** Inferred TypeScript type from the gateway config schema. */
export type GatewayConfigInput = z.input<typeof GatewayConfigSchema>;
