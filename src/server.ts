/**
 * Gateway — replicates zeroclaw's HTTP interface backed by Claude Code.
 *
 * Routes (zeroclaw-compatible):
 *   GET  /health                    — public health check
 *   GET  /api/status                — full system status
 *   GET  /api/config                — read config
 *   PUT  /api/config                — write config
 *   POST /webhook                   — generic agent prompt
 *   GET  /api/events                — SSE event stream
 *   WS   /ws/chat                   — chat websocket
 *   GET  /openapi.json              — OpenAPI spec
 *   GET  /*                         — SPA static files
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { Claude, type ClaudeConfig } from "./claude.js";
import { handleSlackEvent, startSlack } from "./channels/slack.js";
import { loadConfig, loadConfigMasked, saveConfig, saveConfigSafe } from "./config-store.js";
import { SessionDB } from "./session-db.js";
import { SessionIndexer } from "./session-indexer.js";
import { BackgroundReviewer, type ReviewConfig, type ReviewEvent } from "./background-review.js";
import { scanContent } from "./content-scanner.js";
import { generateInsights } from "./insights.js";
import { CronScheduler, type CronConfig } from "./cron.js";
import { AuditLogger } from "./audit.js";
import { RateLimiter, type RateLimitConfig } from "./rate-limit.js";
import { Estop } from "./estop.js";
import { ensureMemoryDir, listDailyNotes, pruneDailyNotes } from "./daily-notes.js";
import { ensureHeartbeatFile, seedHeartbeatJob, isHeartbeatAlert } from "./heartbeat.js";
import { seedDreamingJob, getDreamingPrompt } from "./dreaming.js";
import { resolveApproval, listPendingApprovals } from "./approvals.js";
import { EmbeddingStore, type EmbeddingConfig } from "./embeddings.js";
import { startWhatsApp, handleWhatsAppVerify, handleWhatsAppEvent } from "./channels/whatsapp.js";
import { syncClaudeMd } from "./claude-md.js";
import { PROJECT_DIR_SUFFIX } from "./constants.js";
import { GatewayConfigSchema } from "./schemas.js";
import { AgentRegistry } from "./agent-registry.js";

// ── Schemas ──

const HealthResponse = z.object({
  status: z.enum(["ok", "down"]),
  paired: z.boolean(),
  require_pairing: z.boolean(),
}).openapi("HealthResponse");

const StatusResponse = z.object({
  provider: z.string(),
  model: z.string(),
  uptime_seconds: z.number(),
  gateway_port: z.number(),
  paired: z.boolean(),
  session: z.object({ alive: z.boolean(), busy: z.boolean() }),
}).openapi("StatusResponse");

const WebhookBody = z.object({
  message: z.string().min(1).openapi({ description: "Prompt text" }),
}).openapi("WebhookRequest");

// ── OpenAPI route defs ──

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Gateway"],
  summary: "Public health check",
  responses: {
    200: { content: { "application/json": { schema: HealthResponse } }, description: "Healthy" },
    503: { content: { "application/json": { schema: HealthResponse } }, description: "Down" },
  },
});

const statusRoute = createRoute({
  method: "get",
  path: "/api/status",
  tags: ["API"],
  summary: "Full system status",
  responses: {
    200: { content: { "application/json": { schema: StatusResponse } }, description: "Status" },
  },
});

// ── App ──

export interface SelfImprovementConfig {
  backgroundReview?: {
    enabled?: boolean;
    intervalTurns?: number;
    reviewMemory?: boolean;
    reviewSkills?: boolean;
  };
  sessionSearch?: { enabled?: boolean };
  contentScanning?: { enabled?: boolean };
  insights?: { enabled?: boolean };
}

export interface GatewayConfig {
  name: string;
  port: number;
  host: string;
  apiToken?: string;
  setupComplete?: boolean;
  browserTool?: "gologin" | "browser-use" | "agent-browser" | "none";
  claude: ClaudeConfig;
  channels: {
    slack?: { enabled: boolean };
    discord?: { enabled: boolean };
    telegram?: { enabled: boolean };
    websocket?: { enabled: boolean };
    whatsapp?: { enabled: boolean };
  };
  selfImprovement?: SelfImprovementConfig;
  cron?: Partial<CronConfig>;
  rateLimit?: Partial<RateLimitConfig>;
  audit?: { enabled?: boolean; retentionDays?: number };
  embeddings?: Partial<EmbeddingConfig>;
}

const startedAt = Date.now();

export function createApp(config: GatewayConfig) {
  const claude = new Claude(config.claude);
  claude.start();

  const app = new OpenAPIHono();

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: `exoclaw: ${config.name}`, version: "0.1.0" },
  });

  // Bearer auth middleware — skip public/static routes
  if (config.apiToken) {
    const token = config.apiToken;
    app.use("*", async (c, next) => {
      const p = c.req.path;
      if (p === "/health" || p === "/openapi.json" || p.startsWith("/slack/") || p.startsWith("/assets/") || p.startsWith("/api/auth") || p.startsWith("/api/session") || p.startsWith("/api/setup") || !p.startsWith("/api") && !p.startsWith("/webhook")) {
        return next();
      }
      const bearer = c.req.header("authorization")?.replace("Bearer ", "");
      const secret = c.req.header("x-webhook-secret");
      if (bearer !== token && secret !== token) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return next();
    });
  }

  // ── GET /health ──

  app.openapi(healthRoute, (c) => {
    const ok = claude.alive;
    return c.json({ status: ok ? "ok" as const : "down" as const, paired: true, require_pairing: false }, ok ? 200 : 503);
  });

  // ── GET /api/status ──

  app.openapi(statusRoute, (c) => {
    return c.json({
      provider: "claude-code",
      model: config.claude.model,
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      gateway_port: config.port,
      paired: true,
      session: { alive: claude.alive, busy: claude.busy, io: claude.usingChannel ? "mcp-channel" : "tmux" },
    });
  });

  // ── POST /webhook ──

  app.post("/webhook", async (c) => {
    const parsed = WebhookBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "validation_error", detail: parsed.error.message }, 400);
    if (!claude.alive) return c.json({ error: "session_not_running" }, 503);
    if (claude.busy) return c.json({ error: "session_busy" }, 429);

    const sessionId = c.req.header("x-session-id") || c.req.query("session_id") || crypto.randomUUID();

    try {
      const { text } = await collectResponse(claude, parsed.data.message);
      return c.json({ response: text, session_id: sessionId });
    } catch (err) {
      log("error", `Webhook agent error: ${err}`);
      return c.json({ error: "agent_error", detail: "An internal error occurred while processing the request" }, 500);
    }
  });

  // ── GET /api/events (SSE) ──

  // Simple event bus for broadcasting to SSE clients
  type SSECallback = (event: string, data: any) => void;
  const sseClients = new Set<SSECallback>();

  function broadcastSSE(event: string, data: any): void {
    for (const cb of sseClients) {
      try { cb(event, data); } catch (err) {
        log("debug", `SSE broadcast error: ${err}`);
      }
    }
  }

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const interval = setInterval(async () => {
        try {
          await stream.writeSSE({
            event: "status",
            data: JSON.stringify({
              type: "status",
              alive: claude.alive,
              busy: claude.busy,
              estop: estop.isActive,
              uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
              timestamp: new Date().toISOString(),
            }),
          });
        } catch (err) {
          log("debug", `SSE status write error: ${err}`);
          clearInterval(interval);
        }
      }, 10_000);

      // Subscribe to broadcast events
      const onEvent: SSECallback = async (event, data) => {
        try { await stream.writeSSE({ event, data: JSON.stringify(data) }); } catch (err) {
          log("debug", `SSE event write error: ${err}`);
        }
      };
      sseClients.add(onEvent);

      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(interval);
          sseClients.delete(onEvent);
          resolve();
        });
      });
    });
  });

  // ── Session control ──

  app.post("/api/session/restart", (c) => {
    audit.log({ event_type: "session", detail: "Session restarted via API", source: "api" });
    claude.restart();
    return c.json({ status: "ok" });
  });

  // ── Session history (parsed from tmux pane) ──

  app.get("/api/session/history", (c) => {
    try {
      const projectDir = join(
        process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || "/home/agent", "workspace", ".claude"),
        "projects",
        PROJECT_DIR_SUFFIX
      );
      const files = readdirSync(projectDir)
        .filter((f: string) => f.endsWith(".jsonl") && !f.includes("/"))
        .map((f: string) => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
        .sort((a: any, b: any) => b.mtime - a.mtime);

      if (!files.length) return c.json({ messages: [] });

      const lines = readFileSync(join(projectDir, files[0].name), "utf-8").split("\n").filter(Boolean);
      const messages: { role: string; content: string; toolName?: string }[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const msg = entry.message || {};
          const content = msg.content;

          if (entry.type === "user" && typeof content === "string") {
            messages.push({ role: "user", content });
          } else if (entry.type === "user" && Array.isArray(content)) {
            const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
            if (text) messages.push({ role: "user", content: text });
          }

          if (entry.type === "assistant" && Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                messages.push({ role: "assistant", content: block.text });
              }
              if (block.type === "tool_use") {
                messages.push({ role: "tool", content: `${block.name}: ${JSON.stringify(block.input || {}).slice(0, 200)}`, toolName: block.name });
              }
            }
          }

          if (entry.type === "user" && entry.toolUseResult?.stdout) {
            messages.push({ role: "tool", content: entry.toolUseResult.stdout.slice(0, 500) });
          }
        } catch (err) {
          log("debug", `Session history line parse error: ${err}`);
        }
      }

      return c.json({ messages });
    } catch (err) {
      log("warn", `Session history read failed: ${err}`);
      return c.json({ messages: [] });
    }
  });

  // ── Config API (persisted to volume via config-store) ──

  app.get("/api/config", (c) => {
    try {
      return c.json(loadConfigMasked());
    } catch {
      return c.json(config);
    }
  });

  app.put("/api/config", async (c) => {
    try {
      const body = await c.req.json();
      const parsed = GatewayConfigSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "validation_error", detail: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
      saveConfigSafe(body);
      audit.log({ event_type: "config_change", detail: "Config updated via API", source: "api" });
      return c.json({ status: "ok" });
    } catch (err) {
      log("error", `Config save failed: ${err}`);
      return c.json({ error: "save_failed" }, 500);
    }
  });

  // ── Claude Workspace Files API ──
  // Bidirectional: edit settings.json / CLAUDE.md individually, or as part of the full config

  const si = config.selfImprovement || {};
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || "/home/agent", ".claude");
  const workspaceDir = process.env.HOME || "/home/agent";

  const ws = join(workspaceDir, "workspace");
  const CLAUDE_FILES: Record<string, string> = {
    "settings.json": join(claudeHome, "settings.json"),
    "settings.local.json": join(claudeHome, "settings.local.json"),
    ".mcp.json": join(ws, ".mcp.json"),
    "CLAUDE.md": join(ws, "CLAUDE.md"),
    "IDENTITY.md": join(ws, "IDENTITY.md"),
    "SOUL.md": join(ws, "SOUL.md"),
    "USER.md": join(ws, "USER.md"),
    "AGENTS.md": join(ws, "AGENTS.md"),
    "TOOLS.md": join(ws, "TOOLS.md"),
    "MEMORY.md": join(ws, "MEMORY.md"),
    "HEARTBEAT.md": join(ws, "HEARTBEAT.md"),
  };

  app.get("/api/claude-files", (c) => {
    const result: Record<string, string> = {};
    for (const [name, path] of Object.entries(CLAUDE_FILES)) {
      try { result[name] = readFileSync(path, "utf-8"); } catch { /* file doesn't exist */ }
    }
    return c.json(result);
  });

  app.put("/api/claude-files/:name", async (c) => {
    const name = c.req.param("name");
    const filePath = CLAUDE_FILES[name];
    if (!filePath) return c.json({ error: "unknown_file", name }, 404);

    try {
      const { content } = await c.req.json() as { content: string };

      // Scan markdown/text files for prompt injection (skip JSON configs)
      if (si.contentScanning?.enabled !== false && name.endsWith(".md")) {
        const scan = scanContent(content);
        if (scan.blocked) {
          return c.json({ error: "content_blocked", detail: scan.reason, pattern: scan.pattern }, 422);
        }
      }

      // Ensure parent dir exists
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, content);
      audit.log({ event_type: "file_write", detail: `Updated workspace file: ${name}`, source: "api" });

      // Re-sync CLAUDE.md after any workspace file change so companion references stay current
      if (name === "CLAUDE.md" || name.endsWith(".md")) {
        try { syncClaudeMd(); } catch { /* intentional */ }
      }

      return c.json({ status: "ok", file: name });
    } catch (err) {
      log("error", `Workspace file write failed: ${err}`);
      return c.json({ error: "write_failed", detail: "Failed to write file" }, 500);
    }
  });

  // ── Skills API ──
  // Skills are SKILL.md files in workspace/.claude/skills/<name>/
  // Claude Code discovers them automatically.

  const skillsDir = join(workspaceDir, "workspace", ".claude", "skills");

  // Seed default skills on first run (if skills dir is empty or doesn't exist)
  try {
    mkdirSync(skillsDir, { recursive: true });
    const existing = readdirSync(skillsDir).filter(f => !f.startsWith("."));
    if (existing.length === 0) {
      const defaultSkillsDir = "/app/default-skills";
      try {
        const defaults = readdirSync(defaultSkillsDir, { withFileTypes: true });
        for (const entry of defaults) {
          if (entry.isDirectory()) {
            const src = join(defaultSkillsDir, entry.name, "SKILL.md");
            const dst = join(skillsDir, entry.name);
            try {
              mkdirSync(dst, { recursive: true });
              writeFileSync(join(dst, "SKILL.md"), readFileSync(src, "utf-8"));
            } catch { /* intentional */ }
          }
        }
      } catch { /* default-skills dir may not exist outside Docker */ }
    }
  } catch { /* intentional */ }

  app.get("/api/skills", (c) => {
    try {
      mkdirSync(skillsDir, { recursive: true });
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      const skills = entries
        .filter(e => e.isDirectory())
        .map(e => {
          const skillPath = join(skillsDir, e.name, "SKILL.md");
          let content = "";
          try { content = readFileSync(skillPath, "utf-8"); } catch { /* intentional */ }
          return { name: e.name, content, path: skillPath };
        });
      return c.json({ skills });
    } catch {
      return c.json({ skills: [] });
    }
  });

  app.get("/api/skills/:name", (c) => {
    const name = c.req.param("name");
    const skillPath = join(skillsDir, name, "SKILL.md");
    try {
      return c.json({ name, content: readFileSync(skillPath, "utf-8") });
    } catch {
      return c.json({ error: "not_found" }, 404);
    }
  });

  app.put("/api/skills/:name", async (c) => {
    const name = c.req.param("name");
    const { content } = await c.req.json() as { content: string };

    // Scan skill content for prompt injection
    if (si.contentScanning?.enabled !== false) {
      const scan = scanContent(content);
      if (scan.blocked) {
        return c.json({ error: "content_blocked", detail: scan.reason, pattern: scan.pattern }, 422);
      }
    }

    const dir = join(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content);
    audit.log({ event_type: "skill_change", detail: `Skill created/updated: ${name}`, source: "api" });
    return c.json({ status: "ok", name });
  });

  app.delete("/api/skills/:name", (c) => {
    const name = c.req.param("name");
    const dir = join(skillsDir, name);
    try {
      rmSync(dir, { recursive: true });
      audit.log({ event_type: "skill_change", detail: `Skill deleted: ${name}`, source: "api" });
      return c.json({ status: "ok" });
    } catch (err) {
      log("error", `Skill delete failed: ${err}`);
      return c.json({ error: "delete_failed", detail: "Failed to delete skill" }, 500);
    }
  });

  // ── Self-Improvement: Session DB, Indexer, Background Review, Insights ──

  const sessionDb = new SessionDB();
  const sessionIndexer = new SessionIndexer(sessionDb, 30_000);

  if (si.sessionSearch?.enabled !== false) {
    sessionIndexer.start();
  }

  // Background reviewer
  const reviewConfig: ReviewConfig = {
    enabled: si.backgroundReview?.enabled !== false,
    intervalTurns: si.backgroundReview?.intervalTurns ?? 5,
    reviewMemory: si.backgroundReview?.reviewMemory !== false,
    reviewSkills: si.backgroundReview?.reviewSkills !== false,
  };
  const reviewer = new BackgroundReviewer(reviewConfig, config.claude.model, config.claude.permissionMode);

  // Store recent review events for the dashboard
  const recentReviewEvents: ReviewEvent[] = [];
  reviewer.onEvent((event) => {
    recentReviewEvents.push(event);
    if (recentReviewEvents.length > 50) recentReviewEvents.shift();
    broadcastSSE("review", event);
  });

  // Hook: notify reviewer after each turn completes
  claude.onTurnComplete = () => {
    reviewer.onTurnComplete();
  };

  // ── Session Search API ──

  app.get("/api/sessions", (c) => {
    const limit = parseInt(c.req.query("limit") || "50");
    const offset = parseInt(c.req.query("offset") || "0");
    return c.json({ sessions: sessionDb.listSessions(limit, offset) });
  });

  app.get("/api/sessions/search", (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "query required" }, 400);
    const limit = parseInt(c.req.query("limit") || "20");
    const results = sessionDb.search(q, limit);

    // Group by session
    const grouped = new Map<number, { session_id: number; title: string | null; started_at: string; matches: typeof results }>();
    for (const r of results) {
      if (!grouped.has(r.session_id)) {
        grouped.set(r.session_id, {
          session_id: r.session_id,
          title: r.session_title,
          started_at: r.session_started_at,
          matches: [],
        });
      }
      grouped.get(r.session_id)!.matches.push(r);
    }

    return c.json({ results: Array.from(grouped.values()), total: results.length });
  });

  app.get("/api/sessions/:id/messages", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid session id" }, 400);
    return c.json({ messages: sessionDb.getSessionMessages(id) });
  });

  // ── Insights API ──

  app.get("/api/insights", (c) => {
    if (si.insights?.enabled === false) return c.json({ error: "insights disabled" }, 403);
    const days = parseInt(c.req.query("days") || "30");
    return c.json(generateInsights(sessionDb, days));
  });

  // ── Background Review API ──

  app.get("/api/review/events", (c) => {
    return c.json({ events: recentReviewEvents });
  });

  app.post("/api/review/trigger", (c) => {
    if (!reviewConfig.enabled) return c.json({ error: "background review disabled" }, 403);
    reviewer.triggerReview();
    return c.json({ status: "ok", detail: "Review triggered" });
  });

  // ── Audit Logger ──

  const auditConfig = config.audit || {};
  const audit = new AuditLogger(sessionDb.db, auditConfig.enabled !== false);

  audit.log({ event_type: "session", detail: `Gateway "${config.name}" started`, source: "system" });

  // Prune old audit entries on startup
  if (auditConfig.retentionDays) {
    audit.prune(auditConfig.retentionDays);
  }

  app.get("/api/audit", (c) => {
    const event_type = c.req.query("type") as any;
    const since = c.req.query("since");
    const severity = c.req.query("severity");
    const limit = parseInt(c.req.query("limit") || "100");
    return c.json({ events: audit.query({ event_type, since, severity, limit }) });
  });

  // ── Rate Limiter ──

  const rlConfig: RateLimitConfig = {
    enabled: config.rateLimit?.enabled !== false,
    maxRequestsPerMinute: config.rateLimit?.maxRequestsPerMinute ?? 60,
    maxTrackedIPs: config.rateLimit?.maxTrackedIPs ?? 10_000,
  };
  const rateLimiter = new RateLimiter(rlConfig);

  // Rate limit middleware for API routes
  if (rlConfig.enabled) {
    app.use("/api/*", async (c, next) => {
      const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
      if (!rateLimiter.allow(ip)) {
        audit.log({ event_type: "auth", detail: `Rate limited: ${ip}`, source: "gateway", severity: "warn" });
        return c.json({ error: "rate_limited", retry_after: 60 }, 429);
      }
      c.header("X-RateLimit-Remaining", String(rateLimiter.remaining(ip)));
      return next();
    });
  }

  // ── Cron Scheduler ──

  const cronConfig: CronConfig = {
    enabled: config.cron?.enabled !== false,
    maxConcurrent: config.cron?.maxConcurrent ?? 4,
    pollingIntervalMs: config.cron?.pollingIntervalMs ?? 60_000,
    defaultTimeoutMs: config.cron?.defaultTimeoutMs ?? 3 * 60_000,
    catchUpOnStartup: config.cron?.catchUpOnStartup ?? false,
  };
  const scheduler = new CronScheduler(sessionDb.db, cronConfig, config.claude.model, config.claude.permissionMode);

  scheduler.onJobComplete((job, run) => {
    audit.log({
      event_type: "cron_run",
      detail: `Job "${job.name}" (${job.id}): ${run.status}`,
      source: "cron",
      severity: run.status === "error" ? "error" : "info",
    });
    // Broadcast to SSE clients (dashboard, web UI)
    broadcastSSE("cron_complete", { job_id: job.id, name: job.name, status: run.status, result: run.result?.slice(0, 500) });
  });

  if (cronConfig.enabled) {
    scheduler.start();
  }

  app.get("/api/cron", (c) => {
    return c.json({ jobs: scheduler.listJobs() });
  });

  app.post("/api/cron", async (c) => {
    try {
      const body = await c.req.json() as { name: string; schedule: string; command: string; job_type?: any; model?: string };
      const job = scheduler.createJob(body);
      audit.log({ event_type: "cron_run", detail: `Created cron job: ${job.name} (${job.id})`, source: "api" });
      return c.json({ job });
    } catch (err) {
      log("warn", `Invalid cron job: ${err}`);
      return c.json({ error: "invalid_job", detail: "Invalid job definition" }, 400);
    }
  });

  app.get("/api/cron/:id", (c) => {
    const job = scheduler.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "not_found" }, 404);
    return c.json({ job });
  });

  app.patch("/api/cron/:id", async (c) => {
    const updates = await c.req.json();
    const job = scheduler.updateJob(c.req.param("id"), updates);
    if (!job) return c.json({ error: "not_found" }, 404);
    return c.json({ job });
  });

  app.delete("/api/cron/:id", (c) => {
    const deleted = scheduler.deleteJob(c.req.param("id"));
    if (!deleted) return c.json({ error: "not_found" }, 404);
    audit.log({ event_type: "cron_run", detail: `Deleted cron job: ${c.req.param("id")}`, source: "api" });
    return c.json({ status: "ok" });
  });

  app.get("/api/cron/:id/runs", (c) => {
    const limit = parseInt(c.req.query("limit") || "20");
    return c.json({ runs: scheduler.getJobRuns(c.req.param("id"), limit) });
  });

  app.post("/api/cron/:id/run", (c) => {
    const started = scheduler.runNow(c.req.param("id"));
    if (!started) return c.json({ error: "not_found_or_busy" }, 404);
    return c.json({ status: "ok", detail: "Job triggered" });
  });

  // ── E-STOP ──

  const estop = new Estop(claude, scheduler, audit);

  app.get("/api/estop", (c) => {
    return c.json(estop.state);
  });

  app.post("/api/estop", async (c) => {
    const { level, reason } = await c.req.json() as { level?: string; reason?: string };
    if (!level || (level !== "freeze" && level !== "kill")) {
      return c.json({ error: "level must be 'freeze' or 'kill'" }, 400);
    }
    const state = estop.trigger(level, reason || "Manual E-STOP via API", "api");
    return c.json(state);
  });

  app.post("/api/estop/resume", (c) => {
    const state = estop.resume("api");
    return c.json(state);
  });

  // E-STOP gate: reject agent messages when frozen
  app.use("/webhook", async (c, next) => {
    if (estop.isActive) {
      return c.json({ error: "estop_active", detail: "Agent is in emergency stop mode" }, 503);
    }
    return next();
  });

  // ── Auth / Setup API ──

  app.get("/api/auth/status", async (c) => {
    try {
      const out = execSync("claude auth status 2>&1", { encoding: "utf-8", env: process.env });
      return c.json(JSON.parse(out));
    } catch {
      return c.json({ loggedIn: false });
    }
  });

  app.post("/api/auth/setup-token", async (c) => {
    const { token } = await c.req.json() as { token: string };
    if (!token) return c.json({ error: "token_required" }, 400);

    try {
      execSync(`echo "${token.replace(/"/g, '\\"')}" | claude setup-token 2>&1`, {
        encoding: "utf-8",
        env: process.env,
      });
      return c.json({ status: "ok" });
    } catch (err) {
      log("error", `Auth setup-token failed: ${err}`);
      return c.json({ error: "setup_failed", detail: "Token setup failed" }, 500);
    }
  });

  // Expose tmux pane content so the UI can show login prompts / session state
  app.get("/api/session/pane", (c) => {
    try {
      const content = execSync(`tmux capture-pane -t claude -p -S -50 2>&1`, { encoding: "utf-8" });
      return c.json({ content });
    } catch {
      return c.json({ content: "", error: "no_session" });
    }
  });

  // Send keystrokes to the tmux session (for interactive prompts like login selection)
  app.post("/api/session/keys", async (c) => {
    const { keys } = await c.req.json() as { keys: string };
    if (!keys) return c.json({ error: "keys_required" }, 400);

    try {
      execSync(`tmux send-keys -t claude ${keys}`, { encoding: "utf-8" });
      return c.json({ status: "ok" });
    } catch (err) {
      log("error", `tmux send-keys failed: ${err}`);
      return c.json({ error: "send_failed", detail: "Failed to send keys to session" }, 500);
    }
  });

  // ── Setup Wizard API ──

  app.get("/api/setup/status", (c) => {
    try {
      const cfg = loadConfig();
      return c.json({ setupComplete: cfg.setupComplete ?? false });
    } catch {
      return c.json({ setupComplete: false });
    }
  });

  app.post("/api/setup/complete", async (c) => {
    try {
      const { browserTool, browserApiKey, composioApiKey } = await c.req.json() as {
        browserTool: "gologin" | "browser-use" | "agent-browser" | "none";
        browserApiKey?: string;
        composioApiKey?: string;
      };

      const cfg = loadConfig();
      cfg.setupComplete = true;
      cfg.browserTool = browserTool;

      if (!cfg.claude) cfg.claude = {};
      if (!cfg.claude.mcpServers) cfg.claude.mcpServers = {};

      const servers = cfg.claude.mcpServers as Record<string, any>;

      // Disable all browser MCP servers first
      for (const name of ["agent-browser", "gologin-mcp", "browser-use"]) {
        if (servers[name]) servers[name].enabled = false;
      }

      switch (browserTool) {
        case "gologin":
          servers["gologin-mcp"] = {
            enabled: true,
            type: "stdio",
            command: "npx",
            args: ["gologin-mcp"],
            env: { API_TOKEN: browserApiKey || "" },
          };
          break;
        case "browser-use":
          servers["browser-use"] = {
            enabled: true,
            type: "stdio",
            command: "npx",
            args: ["-y", "browser-use-mcp"],
            env: { BROWSER_USE_API_KEY: browserApiKey || "" },
          };
          break;
        case "agent-browser":
          servers["agent-browser"] = {
            ...(servers["agent-browser"] || { type: "stdio", command: "npx", args: ["agent-browser-mcp"] }),
            enabled: true,
          };
          break;
        case "none":
          // All already disabled above
          break;
      }

      // Composio integration
      if (composioApiKey) {
        servers["composio"] = {
          enabled: true,
          type: "http",
          url: "https://connect.composio.dev/mcp",
          headers: { "x-consumer-api-key": composioApiKey },
        };
      } else if (servers["composio"]) {
        servers["composio"].enabled = false;
      }

      saveConfig(cfg);
      audit.log({ event_type: "config_change", detail: `Setup completed: browser=${browserTool}, composio=${composioApiKey ? "enabled" : "disabled"}`, source: "setup-wizard" });

      return c.json({ status: "ok" });
    } catch (err) {
      log("error", `Setup wizard failed: ${err}`);
      return c.json({ error: "setup_failed", detail: "Setup failed" }, 500);
    }
  });

  // ── Slack ──

  if (config.channels.slack?.enabled) {
    startSlack();
    app.post("/slack/events", (c) => handleSlackEvent(c, claude));
  }

  // ── WhatsApp ──

  if (config.channels.whatsapp?.enabled) {
    startWhatsApp();
    app.get("/whatsapp", (c) => handleWhatsAppVerify(c));
    app.post("/whatsapp", (c) => handleWhatsAppEvent(c, claude));
  }

  // ── Daily Notes, Heartbeat, Dreaming ──

  ensureMemoryDir();
  ensureHeartbeatFile();

  // Sync CLAUDE.md with companion file references + daily notes
  // This is critical — Claude Code only reads CLAUDE.md natively,
  // so all other files must be referenced from it.
  syncClaudeMd();

  // Refresh daily notes in CLAUDE.md every hour (notes change throughout the day)
  setInterval(() => { try { syncClaudeMd(); } catch { /* intentional */ } }, 60 * 60_000);

  // Seed default cron jobs
  seedHeartbeatJob(scheduler);
  seedDreamingJob(scheduler);

  // Dreaming command resolver — replaces sentinel with dynamically built prompt
  scheduler.commandResolver = (command: string) => {
    if (command === "DREAMING_CONSOLIDATION") {
      return getDreamingPrompt(); // Returns null if no daily notes to review
    }
    return command; // Pass through all other commands unchanged
  };

  // Filter heartbeat results — suppress HEARTBEAT_OK from broadcast
  scheduler.onJobComplete((job, run) => {
    if (job.name === "heartbeat" && run.result && !isHeartbeatAlert(run.result)) {
      return; // Silent heartbeat — don't broadcast
    }
    if (job.name === "dreaming" && run.result?.includes("Nothing to consolidate")) {
      return; // Nothing consolidated — don't broadcast
    }
  });

  // Prune old daily notes on startup
  pruneDailyNotes(config.audit?.retentionDays || 90);

  // Daily notes API
  app.get("/api/daily-notes", (c) => {
    const limit = parseInt(c.req.query("limit") || "30");
    return c.json({ notes: listDailyNotes(limit) });
  });

  // ── Embeddings (optional vector search) ──

  const embeddingConfig: EmbeddingConfig = {
    enabled: config.embeddings?.enabled ?? false,
    apiKey: config.embeddings?.apiKey || process.env.OPENAI_API_KEY,
    apiUrl: config.embeddings?.apiUrl,
    model: config.embeddings?.model || "text-embedding-3-small",
    dimensions: config.embeddings?.dimensions || 256,
    vectorWeight: config.embeddings?.vectorWeight ?? 0.7,
    keywordWeight: config.embeddings?.keywordWeight ?? 0.3,
  };
  const embeddingStore = new EmbeddingStore(sessionDb.db, embeddingConfig);

  // Hybrid search endpoint (vector + keyword when embeddings enabled)
  app.get("/api/sessions/hybrid-search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "query required" }, 400);
    const limit = parseInt(c.req.query("limit") || "20");
    const results = await embeddingStore.hybridSearch(q, limit);
    return c.json({ results, vector_enabled: embeddingStore.isEnabled });
  });

  // ── Agent Registry (file-based agent definitions) ──

  const registry = new AgentRegistry(scheduler);

  app.get("/api/agents", (c) => {
    const agents = registry.listAgents().map(a => ({
      name: a.name,
      description: a.description,
      schedule: a.schedule,
      hasPrompt: a.hasPrompt,
      cronJobId: a.cronJobId,
    }));
    return c.json({ agents });
  });

  app.post("/api/agents/:name/run", async (c) => {
    const name = c.req.param("name");
    const agent = registry.getAgent(name);

    if (!agent) {
      return c.json({ error: "not_found", detail: `No agent named '${name}'` }, 404);
    }

    // If agent has a scheduled cron job, trigger it immediately
    if (agent.cronJobId) {
      const ok = scheduler.runNow(agent.cronJobId);
      if (!ok) {
        return c.json({ error: "already_running", detail: "Agent job is already running" }, 409);
      }
      audit.log({ event_type: "cron_run", detail: `Manual agent run: ${name} (job ${agent.cronJobId})`, source: "api" });
      return c.json({ status: "ok", mode: "scheduled", jobId: agent.cronJobId });
    }

    // On-demand only agent — spawn via a transient one-shot cron job
    if (!agent.hasPrompt) {
      return c.json({ error: "no_prompt", detail: "Agent has no prompt body" }, 400);
    }

    try {
      const job = scheduler.createJob({
        name: `${agent.name}-ondemand`,
        job_type: "prompt",
        schedule: `now + 1s`,
        command: agent.prompt,
        model: agent.model,
      });
      scheduler.runNow(job.id);
      audit.log({ event_type: "cron_run", detail: `Manual on-demand agent run: ${name}`, source: "api" });
      return c.json({ status: "ok", mode: "on_demand", jobId: job.id });
    } catch (err) {
      log("error", `Failed to run on-demand agent '${name}': ${err}`);
      return c.json({ error: "run_failed", detail: String(err) }, 500);
    }
  });

  // ── Sub-agent Files API ──
  // CRUD for agent definition files in ~/.claude/agents/

  const agentsDir = join(workspaceDir, "workspace", ".claude", "agents");

  app.get("/api/sub-agents", (c) => {
    try {
      mkdirSync(agentsDir, { recursive: true });
      const files = readdirSync(agentsDir).filter(f => f.endsWith(".md") || f.endsWith(".json"));
      const agents = files.map(f => {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        return { name: f.replace(/\.(md|json)$/, ""), filename: f, content };
      });
      return c.json({ agents });
    } catch (err) {
      return c.json({ agents: [] });
    }
  });

  app.put("/api/sub-agents/:name", async (c) => {
    const name = c.req.param("name");
    // Sanitize name — only allow alphanumeric, hyphen, underscore
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      return c.json({ error: "invalid_name", detail: "Agent name may only contain letters, numbers, hyphens, and underscores" }, 400);
    }
    try {
      const { content, ext = "md" } = await c.req.json() as { content: string; ext?: string };
      const filename = `${name}.${ext === "json" ? "json" : "md"}`;
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, filename), content);
      audit.log({ event_type: "file_write", detail: `Updated sub-agent: ${filename}`, source: "api" });
      return c.json({ status: "ok", name, filename });
    } catch (err) {
      return c.json({ error: "write_failed", detail: String(err) }, 500);
    }
  });

  app.delete("/api/sub-agents/:name", (c) => {
    const name = c.req.param("name");
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      return c.json({ error: "invalid_name" }, 400);
    }
    // Try both .md and .json
    let deleted = false;
    for (const ext of ["md", "json"]) {
      const fp = join(agentsDir, `${name}.${ext}`);
      try {
        if (existsSync(fp)) {
          rmSync(fp);
          deleted = true;
          audit.log({ event_type: "file_write", detail: `Deleted sub-agent: ${name}.${ext}`, source: "api" });
          break;
        }
      } catch {}
    }
    return deleted ? c.json({ status: "ok" }) : c.json({ error: "not_found" }, 404);
  });

  // ── Approvals API ──

  app.get("/api/approvals", (c) => {
    return c.json({ pending: listPendingApprovals() });
  });

  app.post("/api/approvals/:id", async (c) => {
    const id = c.req.param("id");
    const { approved, comment } = await c.req.json() as { approved: boolean; comment?: string };
    const resolved = resolveApproval(id, approved, "api", comment);
    if (!resolved) return c.json({ error: "not_found_or_already_resolved" }, 404);
    audit.log({
      event_type: "auth",
      detail: `Approval ${id}: ${approved ? "approved" : "denied"}${comment ? ` — ${comment}` : ""}`,
      source: "api",
      severity: approved ? "info" : "warn",
    });
    return c.json({ status: "ok", approved });
  });

  // ── Static SPA ──

  app.use("/assets/*", serveStatic({ root: "/app/web/dist" }));
  app.get("*", serveStatic({ root: "/app/web/dist", path: "index.html" }));

  return { app, claude, sessionDb, sessionIndexer, reviewer, scheduler, rateLimiter, estop, audit };
}

// ── Helpers ──

async function collectResponse(claude: Claude, prompt: string) {
  let fullText = "";

  for await (const event of claude.send(prompt)) {
    if (event.type === "chunk") fullText += event.content;
    if (event.type === "done") fullText = event.content || fullText;
  }

  return { text: fullText };
}

/**
 * Parse the tmux pane content into structured chat messages.
 *
 * Claude Code TUI format:
 *   ❯ <user message>
 *   ● <assistant response>
 *   ❯ <next user message>
 *   ...
 */
function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "server", msg }) + "\n");
}

