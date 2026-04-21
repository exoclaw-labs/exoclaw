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
  type: z.enum(["stdio", "http", "sse"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
}).passthrough();

export const SessionConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  systemPrompt: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  providers: z.record(z.record(z.unknown())).optional(),
}).passthrough();

/**
 * Custom user-defined service spec for the supervisor.
 *
 * Built-in units (`gateway`, `remote-control`) are hardcoded in
 * src/supervisor/units.ts and are NOT configurable here — this schema is
 * additive only, for extra services the user wants supervised.
 */
export const CustomServiceSpecSchema = z.object({
  description: z.string().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  restart: z.enum(["no", "on-failure", "always"]).optional(),
  stopGraceMs: z.number().int().positive().optional(),
  startTimeoutMs: z.number().int().positive().optional(),
  autoStart: z.boolean().optional(),
  /** Cron schedule ("*\/15 * * * *") or one-shot ISO/relative ("now + 1h"). */
  schedule: z.string().optional(),
  readiness: z.union([
    z.object({
      type: z.literal("http"),
      url: z.string().url(),
      timeoutMs: z.number().int().positive().optional(),
      intervalMs: z.number().int().positive().optional(),
    }),
    z.object({
      type: z.literal("stdout-regex"),
      pattern: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    }),
  ]).optional(),
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

export const TunnelConfigSchema = z.object({
  provider: z.enum(["none", "tailscale", "cloudflare", "ngrok", "custom"]).optional(),
  token: z.string().optional(),
  tunnelName: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
}).passthrough();

export const PeerSchema = z.object({
  url: z.string().min(1),
  token: z.string().optional(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
}).passthrough();

export const GatewayConfigSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().positive(),
  host: z.string().min(1),
  apiToken: z.string().optional(),
  setupComplete: z.boolean().optional(),
  browserTool: z.enum(["browser-use", "agent-browser", "none"]).optional(),
  session: SessionConfigSchema,
  mcpServers: z.record(McpServerDefSchema).optional(),
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
  tunnel: TunnelConfigSchema.optional(),
  peers: z.record(PeerSchema).optional(),
  /** Extra user-defined services managed by the supervisor (adds to built-ins). */
  services: z.record(CustomServiceSpecSchema).optional(),
}).passthrough();

/** Inferred TypeScript type from the gateway config schema. */
export type GatewayConfigInput = z.input<typeof GatewayConfigSchema>;
