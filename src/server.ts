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
import { exec, execSync, execFileSync } from "child_process";
import { Claude, type SessionConfig, type McpServerDef } from "./claude-sdk.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
import { reviewAgentRun, isAgentJob } from "./agent-review.js";
import { CostTracker, type BudgetConfig } from "./cost-tracker.js";
import { ChannelHealthMonitor } from "./channel-health.js";
import { WorkspaceScanner } from "./workspace-scanner.js";
import { SOPEngine } from "./sop.js";
import { enrichLinks } from "./link-enricher.js";
import { runDiagnostics } from "./doctor.js";
import { MessageQueue, type QueueConfig } from "./message-queue.js";
import { registerOpenAIRoutes } from "./openai-compat.js";
import { SupervisorClient } from "./supervisor/client.js";
import { SupervisorUnavailable } from "./supervisor/protocol.js";
import { HookRegistry, type HookContext } from "./hooks.js";
import { KnowledgeGraph } from "./knowledge-graph.js";
import { compressSession, compressRecentSessions } from "./context-compressor.js";
import { runPrune, seedPruneJob } from "./session-pruner.js";
import { TunnelManager, type TunnelConfig as TunnelCfg } from "./tunnel.js";
import { DelegationManager, SwarmCoordinator, MessageRouter } from "./multi-agent.js";
import { analyzeImage, generateImage } from "./media-tools.js";

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

export interface PeerConfig {
  url: string;
  token?: string;
  enabled?: boolean;
  description?: string;
}

export interface GatewayConfig {
  name: string;
  port: number;
  host: string;
  apiToken?: string;
  setupComplete?: boolean;
  browserTool?: "browser-use" | "agent-browser" | "none";
  session: SessionConfig;
  mcpServers?: Record<string, McpServerDef>;
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
  budget?: Partial<BudgetConfig>;
  queue?: Partial<QueueConfig>;
  tunnel?: Partial<TunnelCfg>;
  peers?: Record<string, PeerConfig>;
}

const startedAt = Date.now();

export function createApp(config: GatewayConfig) {
  // Translate peer gateways into http MCP servers so Claude sees them as native tools.
  // Each peer becomes `mcp__peer-<name>__send_message` / `__get_status`.
  // Done before `new Claude()` so the MCP server map is complete.
  if (config.peers) {
    config.mcpServers = config.mcpServers || {};
    for (const [peerName, peer] of Object.entries(config.peers)) {
      if (peer.enabled === false) continue;
      const key = `peer-${peerName}`;
      const headers: Record<string, string> = {};
      if (peer.token) headers["Authorization"] = `Bearer ${peer.token}`;
      const def: McpServerDef = { type: "http", url: peer.url, headers };
      config.mcpServers[key] = def;
    }
  }

  const claude = new Claude(config.session, config.mcpServers || {});
  claude.name = config.name;
  claude.start();

  const sessionModel = config.session.model;
  const sessionPermMode = (config.session.providers?.claude as any)?.permissionMode || "bypassPermissions";

  const supervisor = new SupervisorClient();
  let rcCache: { url: string | null; running: boolean; expires: number } | null = null;
  async function readRemoteControl(): Promise<{ url: string | null; running: boolean }> {
    if (rcCache && rcCache.expires > Date.now()) {
      return { url: rcCache.url, running: rcCache.running };
    }
    try {
      const info = await supervisor.unitInfo("remote-control");
      const running = info.state === "running" || info.state === "starting";
      const url = typeof info.extras.remoteControlUrl === "string" ? info.extras.remoteControlUrl : null;
      rcCache = { url, running, expires: Date.now() + 2000 };
      return { url, running };
    } catch {
      rcCache = { url: null, running: false, expires: Date.now() + 2000 };
      return { url: null, running: false };
    }
  }

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
      if (p === "/health" || p === "/openapi.json" || p.startsWith("/slack/") || p.startsWith("/assets/") || p.startsWith("/api/auth") || p.startsWith("/api/session") || p.startsWith("/api/setup") || (!p.startsWith("/api") && !p.startsWith("/webhook") && !p.startsWith("/mcp"))) {
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

  // ── GET /api/doctor ──

  app.get("/api/doctor", (c) => {
    return c.json(runDiagnostics());
  });

  // ── GET /api/status ──

  app.openapi(statusRoute, async (c) => {
    const rc = await readRemoteControl();
    return c.json({
      provider: "claude-code",
      model: sessionModel,
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      gateway_port: config.port,
      paired: true,
      session: { alive: claude.alive, busy: claude.busy, io: "agent-sdk", remoteControlUrl: rc.url, remoteControlRunning: rc.running },
    });
  });

  // ── Services API (proxied to supervisor) ──

  app.get("/api/services", async (c) => {
    try {
      const { units } = await supervisor.status();
      return c.json({ units });
    } catch (err) {
      if (err instanceof SupervisorUnavailable) {
        return c.json({ error: "supervisor_unavailable", units: [] }, 503);
      }
      return c.json({ error: "supervisor_error", detail: (err as Error).message }, 500);
    }
  });

  app.get("/api/services/:unit", async (c) => {
    try {
      const info = await supervisor.unitInfo(c.req.param("unit"));
      return c.json(info);
    } catch (err) {
      if (err instanceof SupervisorUnavailable) {
        return c.json({ error: "supervisor_unavailable" }, 503);
      }
      return c.json({ error: "unit_not_found", detail: (err as Error).message }, 404);
    }
  });

  app.post("/api/services/:unit/start", async (c) => {
    try {
      const info = await supervisor.start(c.req.param("unit"));
      audit.log({ event_type: "service_start", detail: `start ${c.req.param("unit")}`, source: "api" });
      return c.json(info);
    } catch (err) {
      if (err instanceof SupervisorUnavailable) return c.json({ error: "supervisor_unavailable" }, 503);
      return c.json({ error: "start_failed", detail: (err as Error).message }, 500);
    }
  });

  app.post("/api/services/:unit/stop", async (c) => {
    try {
      const info = await supervisor.stop(c.req.param("unit"));
      audit.log({ event_type: "service_stop", detail: `stop ${c.req.param("unit")}`, source: "api" });
      return c.json(info);
    } catch (err) {
      if (err instanceof SupervisorUnavailable) return c.json({ error: "supervisor_unavailable" }, 503);
      return c.json({ error: "stop_failed", detail: (err as Error).message }, 500);
    }
  });

  app.post("/api/services/:unit/restart", async (c) => {
    try {
      const info = await supervisor.restart(c.req.param("unit"));
      audit.log({ event_type: "service_restart", detail: `restart ${c.req.param("unit")}`, source: "api" });
      return c.json(info);
    } catch (err) {
      if (err instanceof SupervisorUnavailable) return c.json({ error: "supervisor_unavailable" }, 503);
      return c.json({ error: "restart_failed", detail: (err as Error).message }, 500);
    }
  });

  app.post("/api/services/upgrade", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { target?: string; noGatewayRestart?: boolean };
      if (body.target !== "claude") {
        return c.json({ error: "unsupported_target", detail: "only target=claude is supported" }, 400);
      }
      const result = await supervisor.upgradeClaude({ noGatewayRestart: body.noGatewayRestart });
      audit.log({ event_type: "claude_upgrade", detail: `${result.oldVersion ?? "?"} → ${result.newVersion ?? "?"}`, source: "api" });
      return c.json(result);
    } catch (err) {
      if (err instanceof SupervisorUnavailable) return c.json({ error: "supervisor_unavailable" }, 503);
      return c.json({ error: "upgrade_failed", detail: (err as Error).message }, 500);
    }
  });

  // ── POST /webhook ──

  const messageQueue = new MessageQueue(config.queue);

  app.post("/webhook", async (c) => {
    const parsed = WebhookBody.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "validation_error", detail: parsed.error.message }, 400);
    if (!claude.alive) return c.json({ error: "session_not_running" }, 503);

    const sessionId = c.req.header("x-session-id") || c.req.query("session_id") || crypto.randomUUID();

    try {
      // Enrich URLs in the message with titles/descriptions before sending to Claude
      const enrichedMessage = await enrichLinks(parsed.data.message).catch(() => parsed.data.message);
      const text = await messageQueue.enqueue(
        enrichedMessage,
        "webhook",
        () => claude.busy,
        (prompt) => claude.send(prompt),
      );
      return c.json({ response: text, session_id: sessionId, queued: messageQueue.pending > 0 });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("busy") || msg.includes("Queue full") || msg.includes("Queue timeout")) {
        return c.json({ error: "session_busy", detail: msg, queue_mode: messageQueue.mode, pending: messageQueue.pending }, 429);
      }
      log("error", `Webhook agent error: ${err}`);
      return c.json({ error: "agent_error", detail: "An internal error occurred while processing the request" }, 500);
    }
  });

  app.get("/api/queue", (c) => {
    return c.json({ mode: messageQueue.mode, pending: messageQueue.pending });
  });

  // ── POST /mcp — peer gateway MCP-over-HTTP ──
  //
  // Lets another exoclaw container talk to this one as an MCP server.
  // Tools:
  //   send_message(text, wait_for_reply?) — routes through the same queue as /webhook,
  //                                         so content scanning, budget, estop all apply.
  //   get_status()                        — { name, alive, busy, model }
  //
  // Auth: reuses the gateway Bearer middleware above. Peers put this container's
  // apiToken in an Authorization header (wired via config.peers[*].token).

  // Fresh MCP server per request — stateless HTTP transport is single-use.
  function createPeerMcpServer(): McpServer {
    const mcp = new McpServer(
      { name: `exoclaw-peer-${config.name}`, version: "0.1.0" },
      {
        capabilities: { tools: {} },
        instructions: `This is the peer interface for exoclaw gateway "${config.name}". Use send_message to deliver a message to its Claude session. Use get_status to check if the peer is alive and free.`,
      },
    );

    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "send_message",
          description: `Send a message to the "${config.name}" exoclaw gateway. By default the call returns immediately ("queued") and the peer will respond asynchronously by calling your own send_message in the reverse direction. Set wait_for_reply=true to block until the peer's Claude finishes a turn (times out after ~5 min; can deadlock if both peers wait on each other — avoid mutual wait_for_reply).`,
          inputSchema: {
            type: "object" as const,
            properties: {
              text: { type: "string", description: "The message text to deliver" },
              wait_for_reply: {
                type: "boolean",
                description: "If true, wait for the peer's Claude to complete a turn and return its final text. Default false (fire-and-forget).",
              },
            },
            required: ["text"],
          },
        },
        {
          name: "get_status",
          description: `Return the current status of the "${config.name}" exoclaw gateway: whether its Claude session is alive, whether it's busy processing a turn, its model, and its name.`,
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    }));

    mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name === "send_message") {
        const { text, wait_for_reply = false } = (req.params.arguments || {}) as {
          text?: string;
          wait_for_reply?: boolean;
        };
        if (!text) {
          return { content: [{ type: "text" as const, text: "[error: text is required]" }] };
        }
        if (!claude.alive) {
          return { content: [{ type: "text" as const, text: "[peer session not running]" }] };
        }
        if (estop.isActive) {
          return { content: [{ type: "text" as const, text: `[peer estop active: ${estop.state.reason ?? "frozen"}]` }] };
        }

        const enriched = await enrichLinks(text).catch(() => text);

        if (!wait_for_reply) {
          void (async () => {
            try {
              await messageQueue.enqueue(enriched, "peer", () => claude.busy, (p) => claude.send(p));
            } catch (err) {
              log("warn", `Peer message enqueue failed: ${err}`);
            }
          })();
          return {
            content: [{
              type: "text" as const,
              text: `[queued — ${config.name} will respond asynchronously]`,
            }],
          };
        }

        try {
          const reply = await messageQueue.enqueue(enriched, "peer", () => claude.busy, (p) => claude.send(p));
          return { content: [{ type: "text" as const, text: reply }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `[peer error: ${err}]` }] };
        }
      }

      if (req.params.name === "get_status") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              name: config.name,
              model: sessionModel,
              alive: claude.alive,
              busy: claude.busy,
              estop: estop.isActive,
              pending: messageQueue.pending,
            }),
          }],
        };
      }

      return { content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }] };
    });

    return mcp;
  }

  app.all("/mcp", async (c) => {
    const mcp = createPeerMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } catch (err) {
      log("error", `Peer MCP handleRequest error: ${err}`);
      return c.json({ error: "peer_mcp_error", detail: String(err) }, 500);
    } finally {
      await mcp.close().catch(() => {});
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

  app.post("/api/session/fresh", (c) => {
    audit.log({ event_type: "session", detail: "Fresh session started via API", source: "api" });
    claude.freshStart();
    return c.json({ status: "ok" });
  });

  app.delete("/api/sessions", (c) => {
    audit.log({ event_type: "session", detail: "Session history cleared via API", source: "api" });
    sessionDb.clearSessions();
    return c.json({ status: "ok" });
  });

  app.post("/api/session/switch", async (c) => {
    const { sessionId } = await c.req.json() as { sessionId: string };
    if (!sessionId || !/^[a-f0-9-]{36}$/.test(sessionId)) {
      return c.json({ error: "invalid_session_id" }, 400);
    }
    audit.log({ event_type: "session", detail: `Switched to session ${sessionId}`, source: "api" });
    claude.switchSession(sessionId);
    return c.json({ status: "ok" });
  });

  // ── Session history (parsed from tmux pane) ──

  app.get("/api/session/history", (c) => {
    try {
      const projectDir = join(
        join(process.env.HOME || "/home/agent", ".claude"),
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
      const masked = loadConfigMasked();
      return c.json({ ...masked, chatScrollback: parseInt(process.env.CHAT_SCROLLBACK || "5000", 10) });
    } catch {
      return c.json({ ...config, chatScrollback: parseInt(process.env.CHAT_SCROLLBACK || "5000", 10) });
    }
  });

  app.put("/api/config", async (c) => {
    try {
      const body = await c.req.json();
      const parsed = GatewayConfigSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "validation_error", detail: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
      // Capture desired remote-control state before we save, so we can diff
      const rcDesired = body?.session?.providers?.claude?.remoteControl === true;
      saveConfigSafe(body);
      // Push session config changes to the running instance
      if (body.session) {
        claude.updateConfig(body.session, body.mcpServers);
      }
      // Ask the supervisor to start/stop the remote-control unit to match.
      // Failures here are non-fatal — supervisor may be unavailable in dev.
      void (async () => {
        try {
          const info = await supervisor.unitInfo("remote-control");
          const running = info.state === "running" || info.state === "starting";
          if (rcDesired && !running) await supervisor.start("remote-control");
          if (!rcDesired && running) await supervisor.stop("remote-control");
          rcCache = null; // invalidate so next /api/status reads fresh
        } catch {
          /* supervisor unavailable — skip */
        }
      })();
      audit.log({ event_type: "config_change", detail: "Config updated via API", source: "api" });
      return c.json({ status: "ok" });
    } catch (err) {
      log("error", `Config save failed: ${err}`);
      return c.json({ error: "save_failed" }, 500);
    }
  });

  // ── Claude Workspace Files API ──
  // Workspace files editable via web UI — all under ~/workspace/ (never ~/.claude)

  const si = config.selfImprovement || {};
  const workspaceDir = process.env.HOME || "/home/agent";

  const ws = join(workspaceDir, "workspace");
  const wsClaudeDir = join(ws, ".claude");
  const CLAUDE_FILES: Record<string, string> = {
    "settings.json": join(wsClaudeDir, "settings.json"),
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

      // .mcp.json is no longer writable through this endpoint — MCP servers
      // are now configured in config.yml via PUT /api/config.
      if (name === ".mcp.json") {
        return c.json({
          error: "gone",
          detail: "MCP servers are now configured in config.yml. Use PUT /api/config to update mcpServers.",
        }, 410);
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
  const reviewer = new BackgroundReviewer(reviewConfig, sessionModel, sessionPermMode);

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
    const sessions = sessionDb.listSessions(limit, offset).map((s: any) => ({
      ...s,
      uuid: s.file_path?.split("/").pop()?.replace(".jsonl", "") || null,
    }));
    return c.json({ sessions, activeSessionId: claude.activeSessionId });
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

  app.patch("/api/sessions/:id", async (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid session id" }, 400);
    const { title } = await c.req.json() as { title: string };
    if (!title || typeof title !== "string") return c.json({ error: "title required" }, 400);
    const ok = sessionDb.renameSession(id, title.slice(0, 200));
    if (!ok) return c.json({ error: "session not found" }, 404);
    audit.log({ event_type: "session", detail: `Renamed session ${id} to "${title.slice(0, 50)}"`, source: "api" });
    return c.json({ status: "ok" });
  });

  app.delete("/api/sessions/:id", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid session id" }, 400);
    const ok = sessionDb.deleteSession(id);
    if (!ok) return c.json({ error: "session not found" }, 404);
    audit.log({ event_type: "session", detail: `Deleted session ${id}`, source: "api" });
    return c.json({ status: "ok" });
  });

  // ── Insights API ──

  app.get("/api/insights", (c) => {
    if (si.insights?.enabled === false) return c.json({ error: "insights disabled" }, 403);
    const days = parseInt(c.req.query("days") || "30");
    return c.json(generateInsights(sessionDb, days));
  });

  // ── Cost Tracker & Budget Enforcement ──

  const costTracker = new CostTracker(sessionDb.db, config.budget);

  // Hook: record usage data after each SDK query
  claude.onUsage = (data) => {
    try {
      costTracker.recordUsage(data);
      broadcastSSE("usage", {
        cost_usd: data.costUsd,
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
        duration_ms: data.durationMs,
      });
    } catch (err) {
      log("error", `Cost tracking failed: ${err}`);
    }
  };

  // Budget enforcement — reject prompts when budget exceeded
  if (config.budget?.enabled) {
    app.use("/webhook", async (c, next) => {
      const budget = costTracker.checkBudget();
      if (budget.exceeded) {
        audit.log({ event_type: "auth", detail: budget.exceeded_reason!, source: "gateway", severity: "warn" });
        return c.json({ error: "budget_exceeded", detail: budget.exceeded_reason }, 429);
      }
      return next();
    });
  }

  app.get("/api/usage", (c) => {
    const days = parseInt(c.req.query("days") || "30");
    return c.json(costTracker.summary(days));
  });

  app.get("/api/usage/budget", (c) => {
    return c.json(costTracker.checkBudget());
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
  const scheduler = new CronScheduler(sessionDb, cronConfig, sessionModel, sessionPermMode);

  scheduler.onJobComplete((job, run) => {
    audit.log({
      event_type: "cron_run",
      detail: `Job "${job.name}" (${job.id}): ${run.status}`,
      source: "cron",
      severity: run.status === "error" ? "error" : "info",
    });

    // Suppress silent heartbeats and empty dreaming runs from broadcast
    if (job.name === "heartbeat" && run.result && !isHeartbeatAlert(run.result)) {
      return; // Silent heartbeat — don't broadcast
    }
    if (job.name === "dreaming" && run.result?.includes("Nothing to consolidate")) {
      return; // Nothing consolidated — don't broadcast
    }

    // Broadcast to SSE clients (dashboard, web UI)
    broadcastSSE("cron_complete", { job_id: job.id, name: job.name, status: run.status, result: run.result?.slice(0, 500) });

    // Sub-agent self-improvement: log run result to agent's MEMORY.md and re-stitch
    if (isAgentJob(job.name)) {
      reviewAgentRun(job.name, job, run);
      stitchAgent(job.name);
    }
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

  app.get("/api/cron/running", (c) => {
    return c.json({ running: scheduler.listRunning() });
  });

  app.get("/api/cron/:id/status", (c) => {
    const status = scheduler.getRunningStatus(c.req.param("id"));
    if (!status) return c.json({ running: false });
    return c.json(status);
  });

  app.post("/api/cron/:id/kill", (c) => {
    const killed = scheduler.killJob(c.req.param("id"));
    if (!killed) return c.json({ error: "not_running" }, 404);
    audit.log({ event_type: "cron_run", detail: `Killed running job: ${c.req.param("id")}`, source: "api", severity: "warn" });
    return c.json({ status: "ok", detail: "Job killed" });
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

  // ── Login tmux session (temporary — only while unauthenticated) ──

  const LOGIN_TMUX = "exoclaw-login";

  function isLoginTmuxAlive(): boolean {
    try {
      execSync(`tmux has-session -t ${LOGIN_TMUX} 2>&1`);
      return true;
    } catch { return false; }
  }

  function startLoginTmux(): void {
    if (isLoginTmuxAlive()) return;
    log("info", "Spawning login tmux session");
    try {
      // Spawn a persistent shell — don't run "claude login" as the session
      // command, because if it exits the tmux session dies and the pane
      // content (including any error) is lost.
      execSync(`tmux new-session -d -s ${LOGIN_TMUX} -x 120 -y 40 2>&1`, { env: process.env });
      execSync(`tmux send-keys -t ${LOGIN_TMUX} "claude login" Enter`, { env: process.env });
      startLoginAutoAccept();
    } catch (err) {
      log("error", `Failed to start login tmux: ${err}`);
    }
  }

  function captureLoginPane(): string {
    try {
      const pane = execSync(`tmux capture-pane -t ${LOGIN_TMUX} -p 2>&1`, {
        encoding: "utf-8",
        env: process.env,
      });
      log("debug", `Login pane (last 80): ${JSON.stringify(pane.trimEnd().slice(-80))}`);
      return pane;
    } catch { return ""; }
  }

  // Parse a key string into tokens. Quoted substrings become literal text
  // (sent with tmux `-l`), bare words are sent as tmux key names.
  // Examples:
  //   `"abc" Enter`          -> [{literal: "abc"}, {key: "Enter"}]
  //   `Up`                    -> [{key: "Up"}]
  //   `"a#b$c" Enter`        -> [{literal: "a#b$c"}, {key: "Enter"}]
  function parseLoginKeys(raw: string): Array<{ literal?: string; key?: string }> {
    const tokens: Array<{ literal?: string; key?: string }> = [];
    const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      if (m[1] !== undefined) {
        tokens.push({ literal: m[1].replace(/\\"/g, '"') });
      } else if (m[2] !== undefined) {
        tokens.push({ key: m[2] });
      }
    }
    return tokens;
  }

  function sendLoginKeys(keys: string): void {
    const tokens = parseLoginKeys(keys);
    if (tokens.length === 0) return;
    try {
      for (const tok of tokens) {
        if (tok.literal !== undefined) {
          // `-l` makes tmux treat characters literally (no key-name lookup,
          // no shell interpretation since we use execFileSync).
          execFileSync("tmux", ["send-keys", "-t", LOGIN_TMUX, "-l", tok.literal], { env: process.env });
        } else if (tok.key) {
          execFileSync("tmux", ["send-keys", "-t", LOGIN_TMUX, tok.key], { env: process.env });
        }
      }
    } catch (err) {
      log("error", `Failed to send login keys: ${err}`);
    }
  }

  function killLoginTmux(): void {
    if (!isLoginTmuxAlive()) return;
    log("info", "Killing login tmux session (auth complete)");
    if (loginAutoAcceptTimer) { clearInterval(loginAutoAcceptTimer); loginAutoAcceptTimer = null; }
    try { execSync(`tmux kill-session -t ${LOGIN_TMUX} 2>&1`); } catch {}
  }

  /**
   * Auto-accept post-login TUI prompts in the login tmux session.
   * Handles the same interactive prompts that the old autoAcceptPrompts()
   * handled — theme picker, workspace trust, bypass permissions, etc.
   * Only runs while the login tmux is alive; clears itself when done.
   */
  let loginAutoAcceptTimer: ReturnType<typeof setInterval> | null = null;

  function startLoginAutoAccept(): void {
    if (loginAutoAcceptTimer) return;
    loginAutoAcceptTimer = setInterval(() => {
      if (!isLoginTmuxAlive()) {
        clearInterval(loginAutoAcceptTimer!);
        loginAutoAcceptTimer = null;
        return;
      }

      let pane: string;
      try {
        pane = execSync(`tmux capture-pane -t ${LOGIN_TMUX} -p 2>&1`, {
          encoding: "utf-8", env: process.env,
        });
      } catch { return; }

      // Theme picker — accept default
      if (pane.includes("Syntax theme:") || pane.includes("Choose a theme") || pane.includes("Select a color")) {
        log("info", "Login auto-accept: theme picker");
        try { execSync(`tmux send-keys -t ${LOGIN_TMUX} Enter`, { env: process.env }); } catch {}
        return;
      }

      // Workspace trust
      if (pane.includes("Yes, I trust this folder")) {
        log("info", "Login auto-accept: workspace trust");
        try { execSync(`tmux send-keys -t ${LOGIN_TMUX} Enter`, { env: process.env }); } catch {}
        return;
      }

      // "Press Enter to continue" after login success
      if (pane.includes("Press Enter to continue") || pane.includes("Login successful")) {
        log("info", "Login auto-accept: post-login continue");
        try { execSync(`tmux send-keys -t ${LOGIN_TMUX} Enter`, { env: process.env }); } catch {}
        return;
      }

      // Bypass permissions warning — navigate Down to "Yes, I accept" then Enter
      if (pane.includes("Bypass Permissions") || (pane.includes("Yes, I accept") && !pane.includes("Select login method"))) {
        log("info", "Login auto-accept: bypass permissions");
        try {
          execSync(`tmux send-keys -t ${LOGIN_TMUX} Down`, { env: process.env });
          setTimeout(() => {
            try { execSync(`tmux send-keys -t ${LOGIN_TMUX} Enter`, { env: process.env }); } catch {}
          }, 300);
        } catch {}
        return;
      }

      // Generic "Enter to confirm" prompts (but not login/API key prompts)
      if (
        (pane.includes("Enter to confirm") || pane.includes("Esc to cancel")) &&
        !pane.includes("Select login method") &&
        !pane.includes("Paste code here") &&
        !pane.includes("API key") &&
        !pane.includes("No, exit")
      ) {
        log("info", "Login auto-accept: generic confirm");
        try { execSync(`tmux send-keys -t ${LOGIN_TMUX} Enter`, { env: process.env }); } catch {}
        return;
      }
    }, 2000);
  }

  app.get("/api/auth/status", async (c) => {
    try {
      const out = execSync("claude auth status 2>&1", { encoding: "utf-8", env: process.env });
      const status = JSON.parse(out);
      // Tear down the login tmux once auth succeeds
      if (status?.loggedIn && isLoginTmuxAlive()) {
        killLoginTmux();
      }
      return c.json(status);
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
      killLoginTmux();
      return c.json({ status: "ok" });
    } catch (err) {
      log("error", `Auth setup-token failed: ${err}`);
      return c.json({ error: "setup_failed", detail: "Token setup failed" }, 500);
    }
  });

  // Pane endpoint — serves login tmux when unauthenticated, SDK status otherwise
  app.get("/api/session/pane", (c) => {
    // If login tmux is alive, return its pane content
    if (isLoginTmuxAlive()) {
      const pane = captureLoginPane();
      // If claude login finished and returned to shell prompt, re-run it
      // (Shell prompt ends with $ — distinct from Claude's ❯ prompt)
      const trimmed = pane.trimEnd();
      if (trimmed.endsWith("$") || trimmed.endsWith("#")) {
        log("info", "Login command returned to shell — re-running claude login");
        execSync(`tmux send-keys -t ${LOGIN_TMUX} "claude login" Enter`, { env: process.env });
      }
      return c.json({ content: pane });
    }
    // Not logged in and no login tmux yet — start one
    try {
      const out = execSync("claude auth status 2>&1", { encoding: "utf-8", env: process.env });
      const status = JSON.parse(out);
      if (!status?.loggedIn) {
        startLoginTmux();
        return c.json({ content: captureLoginPane() || "Starting login..." });
      }
    } catch {
      startLoginTmux();
      return c.json({ content: captureLoginPane() || "Starting login..." });
    }
    return c.json({
      content: `[agent-sdk mode] session=${claude.activeSessionId || "none"} alive=${claude.alive} busy=${claude.busy}`,
    });
  });

  // Keys endpoint — sends to login tmux when active, otherwise not supported
  app.post("/api/session/keys", async (c) => {
    if (isLoginTmuxAlive()) {
      const { keys } = await c.req.json() as { keys: string };
      if (keys) sendLoginKeys(keys);
      return c.json({ status: "ok" });
    }
    return c.json({ error: "not_supported", detail: "No active login session" }, 400);
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
        browserTool: "browser-use" | "agent-browser" | "none";
        browserApiKey?: string;
        composioApiKey?: string;
      };

      const cfg = loadConfig();
      cfg.setupComplete = true;
      cfg.browserTool = browserTool;

      if (!cfg.mcpServers) cfg.mcpServers = {};

      const servers = cfg.mcpServers as Record<string, any>;

      // Disable all browser MCP servers first
      for (const name of ["agent-browser", "browser-use"]) {
        if (servers[name]) servers[name].enabled = false;
      }
      // Clean up legacy gologin-mcp if present
      if (servers["gologin-mcp"]) { delete servers["gologin-mcp"]; }

      switch (browserTool) {
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
          // Install Chrome binary in the background (~/.agent-browser/, persisted via volume)
          {
            const installCmd = existsSync("/app/scripts/install-chrome.sh")
              ? "sudo /app/scripts/install-chrome.sh"
              : "agent-browser install";
            log("info", `Installing Chrome in background: ${installCmd}`);
            exec(installCmd, { timeout: 120_000 }, (err) => {
              if (err) log("warn", `Chrome install failed (agent-browser may not work): ${err.message}`);
              else log("info", "Chrome installed successfully for agent-browser");
            });
          }
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
  // Directory-per-agent: each agent is a folder with META.md, CLAUDE.md, and optional companion files.
  // ExoClaw auto-generates a flat .md file (agentsDir/<name>.md) from the directory contents.

  const agentsDir = join(workspaceDir, "workspace", ".claude", "agents");

  const COMPANION_ORDER = ["CLAUDE.md", "IDENTITY.md", "SOUL.md", "USER.md", "MEMORY.md", "TOOLS.md", "HEARTBEAT.md"];

  /** Stitch directory files into a flat <name>.md for Claude Code.
   *  Section markers (<!-- FILENAME -->) allow lossless round-tripping. */
  function stitchAgent(name: string): void {
    const dir = join(agentsDir, name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;

    const metaPath = join(dir, "META.md");
    const metaContent = existsSync(metaPath) ? readFileSync(metaPath, "utf-8").trim() : `name: ${name}`;

    const parts: string[] = [`---\n${metaContent}\n---`];

    for (const file of COMPANION_ORDER) {
      const fp = join(dir, file);
      if (existsSync(fp)) {
        const content = readFileSync(fp, "utf-8").trimEnd();
        parts.push(`<!-- ${file} -->\n${content}`);
      }
    }

    writeFileSync(join(agentsDir, `${name}.md`), parts.join("\n\n") + "\n");
  }

  /** Parse a flat <name>.md back into a directory of files.
   *  Skips if the directory already exists (directory is source of truth). */
  function unstitchAgent(name: string): void {
    const mdFile = join(agentsDir, `${name}.md`);
    const dir = join(agentsDir, name);
    if (!existsSync(mdFile) || existsSync(dir)) return;

    let raw: string;
    try { raw = readFileSync(mdFile, "utf-8"); } catch { return; }

    // Parse frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fmMatch) return;

    const [, meta, body] = fmMatch;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "META.md"), meta.trim() + "\n");

    // Split body on section markers
    const MARKER = /<!-- ([A-Z][A-Z0-9_.-]+) -->\n/g;
    const segments: { file: string; content: string }[] = [];
    let lastIndex = 0;
    let claudeBody = "";
    let match: RegExpExecArray | null;

    while ((match = MARKER.exec(body)) !== null) {
      if (segments.length === 0 && lastIndex === 0) {
        // Everything before first marker is CLAUDE.md
        claudeBody = body.slice(0, match.index).trim();
      } else if (segments.length > 0) {
        segments[segments.length - 1].content = body.slice(lastIndex, match.index).trim();
      }
      segments.push({ file: match[1], content: "" });
      lastIndex = match.index + match[0].length;
    }

    // Remaining content after last marker
    if (segments.length > 0) {
      segments[segments.length - 1].content = body.slice(lastIndex).trim();
    } else {
      // No markers — entire body is CLAUDE.md (legacy flat format)
      claudeBody = body.trim();
    }

    writeFileSync(join(dir, "CLAUDE.md"), (claudeBody || "") + "\n");
    for (const { file, content } of segments) {
      if (content) writeFileSync(join(dir, file), content + "\n");
    }

    log("info", `Migrated flat agent '${name}' to directory format`);
  }

  app.get("/api/sub-agents", (c) => {
    try {
      mkdirSync(agentsDir, { recursive: true });
      const entries = readdirSync(agentsDir, { withFileTypes: true });

      // Auto-migrate any flat .md files that don't have a matching directory
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".md")) {
          const agentName = e.name.slice(0, -3);
          if (!entries.some(d => d.isDirectory() && d.name === agentName)) {
            unstitchAgent(agentName);
          }
        }
      }

      // Re-read after potential migrations
      const dirs = readdirSync(agentsDir, { withFileTypes: true }).filter(e => e.isDirectory());
      const agents = dirs.map(e => {
        const dir = join(agentsDir, e.name);
        const files: Record<string, string> = {};
        for (const f of readdirSync(dir).filter(f => f.endsWith(".md"))) {
          try { files[f] = readFileSync(join(dir, f), "utf-8"); } catch {}
        }
        return { name: e.name, files };
      });
      return c.json({ agents });
    } catch {
      return c.json({ agents: [] });
    }
  });

  app.put("/api/sub-agents/:name/:file", async (c) => {
    const name = c.req.param("name");
    const file = c.req.param("file");
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      return c.json({ error: "invalid_name", detail: "Agent name may only contain letters, numbers, hyphens, and underscores" }, 400);
    }
    if (!/^[A-Z][A-Z0-9_-]*\.md$/.test(file)) {
      return c.json({ error: "invalid_file", detail: "File must match [A-Z][A-Z0-9_-]*.md" }, 400);
    }
    try {
      const { content } = await c.req.json() as { content: string };
      const dir = join(agentsDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), content);
      stitchAgent(name);
      audit.log({ event_type: "file_write", detail: `Updated sub-agent file: ${name}/${file}`, source: "api" });
      return c.json({ status: "ok", name, file });
    } catch (err) {
      return c.json({ error: "write_failed", detail: String(err) }, 500);
    }
  });

  app.delete("/api/sub-agents/:name", (c) => {
    const name = c.req.param("name");
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      return c.json({ error: "invalid_name" }, 400);
    }
    const dir = join(agentsDir, name);
    const generated = join(agentsDir, `${name}.md`);
    let deleted = false;
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      rmSync(dir, { recursive: true });
      deleted = true;
    }
    if (existsSync(generated)) {
      rmSync(generated);
      deleted = true;
    }
    if (deleted) {
      audit.log({ event_type: "file_write", detail: `Deleted sub-agent: ${name}`, source: "api" });
    }
    return deleted ? c.json({ status: "ok" }) : c.json({ error: "not_found" }, 404);
  });

  app.delete("/api/sub-agents/:name/:file", (c) => {
    const name = c.req.param("name");
    const file = c.req.param("file");
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      return c.json({ error: "invalid_name" }, 400);
    }
    if (file === "META.md" || file === "CLAUDE.md") {
      return c.json({ error: "protected_file", detail: "Cannot delete META.md or CLAUDE.md" }, 400);
    }
    const fp = join(agentsDir, name, file);
    if (!existsSync(fp)) {
      return c.json({ error: "not_found" }, 404);
    }
    rmSync(fp);
    stitchAgent(name);
    audit.log({ event_type: "file_write", detail: `Deleted sub-agent file: ${name}/${file}`, source: "api" });
    return c.json({ status: "ok" });
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

  // ── Channel Health Monitor ──

  const channelHealth = new ChannelHealthMonitor();

  channelHealth.onChange((name, health) => {
    broadcastSSE("channel_health", { channel: name, status: health.status, error: health.lastError });
    if (health.status === "error") {
      audit.log({ event_type: "error", detail: `Channel ${name}: ${health.lastError}`, source: "system", severity: "warn" });
    }
  });

  app.get("/api/channels/health", (c) => {
    return c.json({ channels: channelHealth.getAll() });
  });

  // ── Workspace File Scanner ──

  const workspaceScanner = new WorkspaceScanner(ws);
  if (si.contentScanning?.enabled !== false) {
    workspaceScanner.onAlert((alert) => {
      audit.log({
        event_type: "error",
        detail: `Credential leak in workspace file: ${alert.file} — ${alert.reason}`,
        source: "system",
        severity: "critical",
      });
      broadcastSSE("workspace_alert", alert);
    });
    workspaceScanner.start();
  }

  app.get("/api/workspace/alerts", (c) => {
    return c.json({ alerts: workspaceScanner.getRecentAlerts() });
  });

  // ── SOP Engine ──

  const sopEngine = new SOPEngine(sessionDb.db, sessionModel, sessionPermMode);

  sopEngine.onStepComplete((run, stepIdx, result, status) => {
    broadcastSSE("sop_step", { run_id: run.id, sop: run.sop_name, step: stepIdx, status, result: result.slice(0, 200) });
    if (status === "error") {
      audit.log({ event_type: "error", detail: `SOP ${run.sop_name} step ${stepIdx} failed`, source: "sop", severity: "warn" });
    }
  });

  app.get("/api/sops", (c) => {
    return c.json({ sops: sopEngine.listSOPs() });
  });

  app.get("/api/sops/:name", (c) => {
    const sop = sopEngine.getSOP(c.req.param("name"));
    if (!sop) return c.json({ error: "not_found" }, 404);
    return c.json(sop);
  });

  app.post("/api/sops/:name/run", async (c) => {
    try {
      const runId = await sopEngine.execute(c.req.param("name"));
      audit.log({ event_type: "cron_run", detail: `SOP "${c.req.param("name")}" started (run ${runId})`, source: "api" });
      return c.json({ status: "ok", run_id: runId });
    } catch (err) {
      return c.json({ error: "execution_failed", detail: String(err) }, 400);
    }
  });

  app.get("/api/sop-runs", (c) => {
    const sopName = c.req.query("sop") || undefined;
    const limit = parseInt(c.req.query("limit") || "20");
    return c.json({ runs: sopEngine.listRuns(sopName, limit) });
  });

  app.get("/api/sop-runs/:id", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid_id" }, 400);
    const run = sopEngine.getRun(id);
    if (!run) return c.json({ error: "not_found" }, 404);
    return c.json(run);
  });

  app.post("/api/sop-runs/:id/resume", async (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid_id" }, 400);
    const resumed = await sopEngine.resumeRun(id);
    if (!resumed) return c.json({ error: "not_paused_or_not_found" }, 404);
    audit.log({ event_type: "cron_run", detail: `SOP run ${id} resumed`, source: "api" });
    return c.json({ status: "ok" });
  });

  // ── OpenAI-Compatible API ──

  registerOpenAIRoutes(app, claude);

  // ── Hook System ──

  const hooks = new HookRegistry();
  hooks.loadFromDisk().catch(() => {}); // Non-blocking

  app.get("/api/hooks", (c) => {
    return c.json({ plugins: hooks.list() });
  });

  // ── Knowledge Graph ──

  const knowledgeGraph = new KnowledgeGraph(sessionDb.db);

  app.get("/api/knowledge", (c) => {
    const q = c.req.query("q");
    if (q) {
      return c.json({ results: knowledgeGraph.search(q) });
    }
    const type = c.req.query("type") as any;
    const limit = parseInt(c.req.query("limit") || "50");
    return c.json({ nodes: knowledgeGraph.listNodes(type, limit), stats: knowledgeGraph.stats() });
  });

  app.post("/api/knowledge/nodes", async (c) => {
    const { type, name, description, tags } = await c.req.json() as any;
    if (!type || !name) return c.json({ error: "type and name required" }, 400);
    const node = knowledgeGraph.upsertNode(type, name, description, tags);
    return c.json({ node });
  });

  app.delete("/api/knowledge/nodes/:id", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid_id" }, 400);
    if (!knowledgeGraph.deleteNode(id)) return c.json({ error: "not_found" }, 404);
    return c.json({ status: "ok" });
  });

  app.post("/api/knowledge/edges", async (c) => {
    const { source_id, target_id, edge_type, weight, context: edgeContext } = await c.req.json() as any;
    if (!source_id || !target_id || !edge_type) return c.json({ error: "source_id, target_id, edge_type required" }, 400);
    const edge = knowledgeGraph.addEdge(source_id, target_id, edge_type, weight, edgeContext);
    return c.json({ edge });
  });

  app.get("/api/knowledge/nodes/:id/edges", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid_id" }, 400);
    return c.json(knowledgeGraph.getEdges(id));
  });

  app.get("/api/knowledge/nodes/:id/traverse", (c) => {
    const id = parseInt(c.req.param("id"));
    const hops = parseInt(c.req.query("hops") || "2");
    if (isNaN(id)) return c.json({ error: "invalid_id" }, 400);
    const result = knowledgeGraph.traverse(id, hops);
    return c.json({ nodes: Array.from(result.values()) });
  });

  // ── Context Compression ──

  app.post("/api/sessions/:id/compress", async (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid_id" }, 400);
    const result = await compressSession(sessionDb, id, sessionModel);
    if (!result) return c.json({ error: "nothing_to_compress" }, 404);
    return c.json(result);
  });

  app.get("/api/sessions/context", async (c) => {
    const count = parseInt(c.req.query("count") || "3");
    const context = await compressRecentSessions(sessionDb, count, sessionModel);
    return c.json({ context });
  });

  // ── Session Pruning ──

  // Run initial prune on startup
  runPrune(sessionDb, {
    messageRetentionDays: (config.audit?.retentionDays ?? 90),
    dailyNoteRetentionDays: 30,
    maxDbSizeMb: 500,
    autoSchedule: false,
  }, audit);

  // Seed automatic prune cron job
  seedPruneJob(scheduler);

  // ── Tunnel Manager ──

  const tunnelManager = new TunnelManager({
    provider: config.tunnel?.provider ?? "none",
    port: config.port,
    token: config.tunnel?.token,
    command: config.tunnel?.command,
    args: config.tunnel?.args,
    tunnelName: config.tunnel?.tunnelName,
  });
  if (config.tunnel?.provider && config.tunnel.provider !== "none") {
    tunnelManager.start();
  }

  app.get("/api/tunnel", (c) => {
    return c.json(tunnelManager.status);
  });

  app.post("/api/tunnel/restart", (c) => {
    tunnelManager.restart({
      provider: config.tunnel?.provider ?? "none",
      port: config.port,
      token: config.tunnel?.token,
      command: config.tunnel?.command,
      args: config.tunnel?.args,
      tunnelName: config.tunnel?.tunnelName,
    });
    audit.log({ event_type: "config_change", detail: `Tunnel restarted (provider: ${config.tunnel?.provider ?? "none"})`, source: "api" });
    return c.json({ status: "ok" });
  });

  // ── Multi-Agent System ──

  const delegations = new DelegationManager(sessionModel, sessionPermMode);
  const swarm = new SwarmCoordinator(sessionModel, sessionPermMode);
  const router = new MessageRouter();

  app.post("/api/delegate", async (c) => {
    const { parent, child, prompt: delegatePrompt } = await c.req.json() as any;
    if (!child || !delegatePrompt) return c.json({ error: "child and prompt required" }, 400);
    const delegation = delegations.delegate(parent || "main", child, delegatePrompt);
    return c.json({ delegation });
  });

  app.get("/api/delegations", (c) => {
    return c.json({ active: delegations.listActive() });
  });

  app.delete("/api/delegations/:id", (c) => {
    if (!delegations.cancel(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    return c.json({ status: "ok" });
  });

  app.post("/api/swarm", async (c) => {
    const { tasks, strategy } = await c.req.json() as { tasks: { agent: string; prompt: string }[]; strategy?: string };
    if (!tasks?.length) return c.json({ error: "tasks required" }, 400);
    const results = await swarm.execute(tasks, (strategy as any) || "parallel");
    return c.json({ results });
  });

  app.get("/api/routing/rules", (c) => {
    return c.json({ rules: router.listRules() });
  });

  app.post("/api/routing/rules", async (c) => {
    const { pattern, channel: routeChannel, agent, priority } = await c.req.json() as any;
    if (!pattern || !agent) return c.json({ error: "pattern and agent required" }, 400);
    const rule = router.addRule({ pattern, channel: routeChannel, agent, priority: priority ?? 100 });
    return c.json({ rule });
  });

  app.delete("/api/routing/rules/:id", (c) => {
    if (!router.removeRule(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    return c.json({ status: "ok" });
  });

  // ── Media Tools ──

  app.post("/api/vision", async (c) => {
    try {
      const body = await c.req.json() as any;
      const result = await analyzeImage(body);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post("/api/image/generate", async (c) => {
    try {
      const body = await c.req.json() as any;
      const result = await generateImage(body);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // ── Static SPA ──

  app.use("/assets/*", serveStatic({ root: "/app/web/dist" }));
  app.get("*", serveStatic({ root: "/app/web/dist", path: "index.html" }));

  return { app, claude, sessionDb, sessionIndexer, reviewer, scheduler, rateLimiter, estop, audit, costTracker, channelHealth, hooks, knowledgeGraph, tunnelManager, router };
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

