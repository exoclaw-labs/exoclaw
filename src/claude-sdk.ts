/**
 * Claude Code session manager — Agent SDK implementation.
 *
 * Two modes, selected by CLAUDE_SDK_V2 env var:
 *
 *   Stable (default): Uses `query()` per inbound message with `resume: sessionId`.
 *     Full feature set — MCP servers, system prompt, agents, settings sources.
 *     ~2-5s startup per query (mitigated by session resume).
 *
 *   V2 (CLAUDE_SDK_V2=true): Uses `unstable_v2_createSession()` for a persistent
 *     in-process session. Lower latency for follow-ups but limited options —
 *     no MCP servers, no system prompt, no agents, no cwd. Alpha API, may change.
 *
 * MCP tools (session_search, clarify, request_approval) are defined as
 * in-process SDK MCP servers — no separate channel-server process needed.
 * (Only available in stable mode; V2 lacks mcpServers support.)
 *
 * Remote control is an optional background process gated by ENABLE_REMOTE_CONTROL.
 */

import {
  query,
  createSdkMcpServer,
  tool,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  Options,
  SDKSession,
  SDKSessionOptions,
  SDKMessage,
  SDKResultSuccess,
  SDKResultError,
  McpServerConfig,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcess } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { SessionDB } from "./session-db.js";
import { PROJECT_DIR_SUFFIX } from "./constants.js";

// ── Types ──

export interface McpServerDef {
  enabled?: boolean;
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ClaudeConfig {
  name?: string;
  model: string;
  permissionMode: string;
  systemPrompt?: string;
  mcpServers?: Record<string, McpServerDef>;
  agents?: Record<string, { description: string; prompt: string }>;
  allowedTools?: string[];
  disallowedTools?: string[];
  thinkingBudget?: number;
  excludeDynamicSystemPromptSections?: string[];
  remoteControl?: boolean;
}

// Callback types for interactive tools (clarify / request_approval)
export type ClarifyHandler = (question: string, choices?: string[]) => Promise<string>;
export type ApprovalHandler = (action: string, detail?: string, riskLevel?: string) => Promise<string>;

/** Whether to use the unstable V2 session API. */
const USE_V2 = process.env.CLAUDE_SDK_V2 === "true";

export class Claude {
  private config: ClaudeConfig;
  private _busy = false;
  private _alive = false;
  private _sessionId: string | null = null;
  private _remoteControlUrl: string | null = null;
  private _remoteControlProc: ChildProcess | null = null;
  private _activeQuery: Query | null = null;

  // V2 session state
  private _v2Session: SDKSession | null = null;

  /** Called after each turn completes. Set by the gateway to trigger background review. */
  onTurnComplete: (() => void) | null = null;

  /** Called with usage data after each query result. Set by gateway for cost tracking. */
  onUsage: ((data: {
    sessionId: string | null;
    costUsd: number;
    usage: Record<string, number>;
    modelUsage: Record<string, any>;
    durationMs: number;
    numTurns: number;
  }) => void) | null = null;

  /** Set by the gateway to handle clarify tool calls from Claude. */
  onClarify: ClarifyHandler | null = null;

  /** Set by the gateway to handle approval tool calls from Claude. */
  onApproval: ApprovalHandler | null = null;

  /** In-process MCP server — created once, reused across queries (stable mode only). */
  private gatewayMcpServer: McpSdkServerConfigWithInstance | null = null;

  constructor(config: ClaudeConfig) {
    this.config = config;
    if (!USE_V2) {
      this.gatewayMcpServer = this.buildGatewayMcpServer();
    }
  }

  /** Start the session. No tmux — just mark alive and optionally start remote control. */
  start(): void {
    this._alive = true;
    this.loadSavedSessionId();

    if (USE_V2) {
      this.initV2Session();
    }

    if (process.env.ENABLE_REMOTE_CONTROL === "true" || this.config.remoteControl) {
      this.startRemoteControl();
    }

    log("info", `Claude SDK session manager started (mode=${USE_V2 ? "v2" : "stable"})`);
  }

  /** Initialize a V2 persistent session. */
  private initV2Session(): void {
    const opts: SDKSessionOptions = {
      model: this.config.model,
      permissionMode: "bypassPermissions",
      allowedTools: this.config.allowedTools,
      disallowedTools: this.config.disallowedTools,
      env: { ...process.env } as Record<string, string>,
    };

    if (this._sessionId) {
      log("info", `V2: resuming session ${this._sessionId.slice(0, 8)}...`);
      this._v2Session = unstable_v2_resumeSession(this._sessionId, opts);
    } else {
      log("info", "V2: creating new session");
      this._v2Session = unstable_v2_createSession(opts);
    }
  }

  // ── I/O ──

  async *send(prompt: string): AsyncGenerator<{ type: string; content: string }> {
    if (this._busy) throw new Error("Session is busy");

    log("info", `send(): prompt="${prompt.slice(0, 60)}..." (mode=${USE_V2 ? "v2" : "stable"})`);
    this._busy = true;

    try {
      if (USE_V2) {
        yield* this.sendV2(prompt);
      } else {
        yield* this.sendStable(prompt);
      }
    } catch (err) {
      yield { type: "error", content: `SDK error: ${err}` };
    } finally {
      this._activeQuery = null;
      this._busy = false;
      try { this.onTurnComplete?.(); } catch { /* intentional */ }
    }
  }

  /**
   * Stable mode: one query() call per inbound message with resume.
   * Full feature set — MCP servers, system prompt, agents, etc.
   */
  private async *sendStable(prompt: string): AsyncGenerator<{ type: string; content: string }> {
    const options = this.buildQueryOptions();
    const q = query({ prompt, options });
    this._activeQuery = q;
    yield* this.processMessageStream(q);
  }

  /**
   * V2 mode: persistent session, send() + stream() per message.
   * Lower latency but limited config (no MCP servers, no system prompt).
   */
  private async *sendV2(prompt: string): AsyncGenerator<{ type: string; content: string }> {
    if (!this._v2Session) {
      this.initV2Session();
    }
    if (!this._v2Session) {
      yield { type: "error", content: "V2 session failed to initialize" };
      return;
    }

    await this._v2Session.send(prompt);
    yield* this.processMessageStream(this._v2Session.stream());
  }

  /**
   * Shared message stream processor — handles SDK messages from both
   * stable query() and V2 session.stream().
   */
  private async *processMessageStream(
    stream: AsyncGenerator<SDKMessage, void> | AsyncIterable<SDKMessage>,
  ): AsyncGenerator<{ type: string; content: string }> {
    let lastAssistantText = "";

    for await (const message of stream) {
      // Capture session ID from init
      if (message.type === "system" && "subtype" in message && (message as any).subtype === "init") {
        const sid = (message as any).session_id;
        if (sid && sid !== this._sessionId) {
          this._sessionId = sid;
          this.saveSessionId(sid);
        }
        continue;
      }

      // Assistant messages — text, tool_use, thinking blocks
      if (message.type === "assistant" && "message" in message) {
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              lastAssistantText = block.text;
              yield { type: "chunk", content: block.text };
            }
            if (block.type === "tool_use") {
              yield {
                type: "tool_use",
                content: JSON.stringify({ name: block.name, input: block.input || {} }),
              };
            }
            if (block.type === "thinking" && block.thinking) {
              yield { type: "thinking", content: block.thinking.slice(0, 300) };
            }
          }
        }
        continue;
      }

      // Streaming deltas (when includePartialMessages is true)
      if (message.type === "stream_event" && "event" in message) {
        const event = (message as any).event;
        if (event?.type === "content_block_delta") {
          const delta = event.delta;
          if (delta?.type === "text_delta" && delta.text) {
            yield { type: "chunk", content: delta.text };
          }
          if (delta?.type === "thinking_delta" && delta.thinking) {
            yield { type: "thinking", content: delta.thinking };
          }
        }
        continue;
      }

      // Result — success or error
      if (message.type === "result") {
        const result = message as SDKResultSuccess | SDKResultError;
        if (result.subtype === "success") {
          lastAssistantText = (result as SDKResultSuccess).result || lastAssistantText;
          // Capture session ID from result
          if (result.session_id && result.session_id !== this._sessionId) {
            this._sessionId = result.session_id;
            this.saveSessionId(result.session_id);
          }
        } else {
          const errors = (result as SDKResultError).errors || [];
          yield { type: "error", content: errors.join("; ") || `Query ended: ${result.subtype}` };
        }

        // Emit usage data for cost tracking (both success and error results have usage)
        try {
          this.onUsage?.({
            sessionId: result.session_id ?? this._sessionId,
            costUsd: result.total_cost_usd ?? 0,
            usage: result.usage as any ?? {},
            modelUsage: result.modelUsage ?? {},
            durationMs: result.duration_ms ?? 0,
            numTurns: result.num_turns ?? 0,
          });
        } catch { /* cost tracking should never block the response */ }

        continue;
      }

      // User messages with tool results — show tool execution output
      if (message.type === "user" && "message" in message) {
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result" && typeof block.content === "string") {
              yield { type: "tool_result", content: block.content.slice(0, 500) };
            }
          }
        }
        continue;
      }

      // V2: capture session ID from the session object after first message
      if (USE_V2 && this._v2Session && !this._sessionId) {
        try {
          const sid = this._v2Session.sessionId;
          if (sid) {
            this._sessionId = sid;
            this.saveSessionId(sid);
          }
        } catch { /* sessionId may throw if not initialized yet */ }
      }
    }

    yield { type: "done", content: lastAssistantText };
  }

  // ── Query options builder ──

  private buildQueryOptions(): Options {
    const mcpServers: Record<string, McpServerConfig> = {};

    // Add the in-process gateway MCP server
    if (this.gatewayMcpServer) {
      mcpServers["exoclaw-gateway"] = this.gatewayMcpServer;
    }

    // Add external MCP servers from config
    if (this.config.mcpServers) {
      for (const [name, def] of Object.entries(this.config.mcpServers)) {
        if (def.enabled === false) continue;
        if (def.type === "http" && def.url) {
          mcpServers[name] = { type: "http", url: def.url, headers: def.headers };
        } else if (def.command) {
          mcpServers[name] = {
            type: "stdio",
            command: def.command,
            args: def.args,
            env: def.env,
          };
        }
      }
    }

    const options: Options = {
      model: this.config.model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers,
      maxTurns: 25,
      cwd: join(process.env.HOME || "/home/agent", "workspace"),
      // Only load project-level settings (.claude/settings.json, CLAUDE.md)
      // Exclude "user" (~/.claude/settings.json) to prevent stale or
      // conflicting config from leaking into the gateway-controlled session.
      settingSources: ["project", "local"],
      env: { ...process.env } as Record<string, string>,
    };

    // Session continuity — resume existing session
    if (this._sessionId) {
      options.resume = this._sessionId;
    }

    // System prompt — append to default Claude Code prompt
    if (this.config.systemPrompt) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: this.config.systemPrompt,
      };
    }

    // Agents
    if (this.config.agents && Object.keys(this.config.agents).length > 0) {
      options.agents = this.config.agents;
    }

    // Tool permissions
    if (this.config.allowedTools?.length) {
      options.allowedTools = this.config.allowedTools;
    }
    if (this.config.disallowedTools?.length) {
      options.disallowedTools = this.config.disallowedTools;
    }

    // Thinking budget
    if (this.config.thinkingBudget !== undefined) {
      if (this.config.thinkingBudget === 0) {
        options.thinking = { type: "disabled" };
      } else {
        options.thinking = { type: "enabled", budgetTokens: this.config.thinkingBudget };
      }
    }

    // Name for remote control prefix
    if (this.config.name) {
      options.extraArgs = {
        ...options.extraArgs,
        "name": this.config.name,
        "remote-control-session-name-prefix": this.config.name,
      };
    }

    // Exclude volatile system prompt sections to improve prompt cache hit rate
    if (this.config.excludeDynamicSystemPromptSections?.length) {
      options.extraArgs = {
        ...options.extraArgs,
        "exclude-dynamic-system-prompt-sections": this.config.excludeDynamicSystemPromptSections.join(","),
      };
    }

    return options;
  }

  // ── In-process MCP server ──

  private buildGatewayMcpServer(): McpSdkServerConfigWithInstance {
    let sessionDb: SessionDB | null = null;
    try { sessionDb = new SessionDB(); } catch { /* intentional */ }

    const sessionSearchTool = tool(
      "session_search",
      "Search past conversation history. Use when the user references something from a previous session or when you need cross-session context.",
      { query: z.string(), limit: z.number().optional() },
      async ({ query: q, limit }) => {
        if (!sessionDb) {
          return { content: [{ type: "text" as const, text: "Session search unavailable" }] };
        }
        const results = sessionDb.search(q, limit ?? 10);
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No results for "${q}"` }] };
        }

        // Group by session
        const grouped = new Map<number, { title: string | null; date: string; messages: string[] }>();
        for (const r of results) {
          if (!grouped.has(r.session_id)) {
            grouped.set(r.session_id, { title: r.session_title, date: r.session_started_at, messages: [] });
          }
          grouped.get(r.session_id)!.messages.push(`[${r.role}]: ${r.snippet || r.content.slice(0, 200)}`);
        }

        const formatted = Array.from(grouped.entries())
          .map(([, g]) => `## Session: ${g.title || "Untitled"} (${g.date})\n${g.messages.join("\n")}`)
          .join("\n\n---\n\n");

        return { content: [{ type: "text" as const, text: `Found ${results.length} result(s):\n\n${formatted}` }] };
      },
    );

    const clarifyTool = tool(
      "clarify",
      "Ask the user a question when you need clarification, want to offer choices, or need a decision before proceeding.",
      { question: z.string(), choices: z.array(z.string()).optional() },
      async ({ question, choices }) => {
        if (!this.onClarify) {
          return { content: [{ type: "text" as const, text: "[no clarify handler — user not connected]" }] };
        }
        try {
          const response = await this.onClarify(question, choices);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ question, choices: choices || [], user_response: response }),
            }],
          };
        } catch {
          return { content: [{ type: "text" as const, text: "[timeout — no response from user]" }] };
        }
      },
    );

    const requestApprovalTool = tool(
      "request_approval",
      "Request user approval before performing a dangerous or irreversible action.",
      {
        action: z.string(),
        detail: z.string().optional(),
        risk_level: z.enum(["low", "medium", "high", "critical"]).optional(),
      },
      async ({ action, detail, risk_level }) => {
        if (!this.onApproval) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ approved: false, action, reason: "no approval handler" }),
            }],
          };
        }
        try {
          const response = await this.onApproval(action, detail, risk_level);
          const approved = response.toLowerCase().includes("approve") && !response.toLowerCase().includes("deny");
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ approved, action, risk_level: risk_level || "medium", user_response: response }),
            }],
          };
        } catch {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ approved: false, action, reason: "timeout" }),
            }],
          };
        }
      },
    );

    return createSdkMcpServer({
      name: "exoclaw-gateway",
      tools: [sessionSearchTool, clarifyTool, requestApprovalTool],
    });
  }

  // ── Remote control (optional background process) ──

  private startRemoteControl(): void {
    const args = ["remote-control"];
    if (this.config.name) {
      args.push("--name", this.config.name);
    }

    log("info", `Starting remote control: claude ${args.join(" ")}`);
    const proc = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      cwd: join(process.env.HOME || "/home/agent", "workspace"),
    });
    this._remoteControlProc = proc;

    const parseOutput = (data: Buffer) => {
      const text = data.toString();
      // Capture the remote control URL
      const envMatch = text.match(/environment=(env_[a-zA-Z0-9]+)/);
      if (envMatch) {
        this._remoteControlUrl = `https://claude.ai/code?environment=${envMatch[1]}`;
        log("info", `Remote control URL: ${this._remoteControlUrl}`);
      }
      const urlMatch = text.match(/(https:\/\/claude\.ai\/code\/remote-control[^\s]*)/);
      if (urlMatch) {
        this._remoteControlUrl = urlMatch[1];
        log("info", `Remote control URL: ${this._remoteControlUrl}`);
      }
    };

    proc.stdout?.on("data", parseOutput);
    proc.stderr?.on("data", parseOutput);

    proc.on("exit", (code) => {
      log("warn", `Remote control process exited with code ${code}`);
      this._remoteControlProc = null;
      this._remoteControlUrl = null;
    });
  }

  private stopRemoteControl(): void {
    if (this._remoteControlProc) {
      log("info", "Stopping remote control process");
      try { this._remoteControlProc.kill(); } catch { /* intentional */ }
      this._remoteControlProc = null;
      this._remoteControlUrl = null;
    }
  }

  // ── Session persistence ──

  private get sessionFilePath(): string {
    return join(process.env.HOME || "/tmp", ".exoclaw", "session-id");
  }

  private loadSavedSessionId(): void {
    try {
      const saved = readFileSync(this.sessionFilePath, "utf-8").trim();
      if (saved) {
        this._sessionId = saved;
        log("info", `Loaded session ID: ${saved.slice(0, 8)}...`);
      }
    } catch { /* no saved session */ }
  }

  private saveSessionId(id: string): void {
    try {
      const dir = join(process.env.HOME || "/tmp", ".exoclaw");
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.sessionFilePath, id);
      log("info", `Saved session ID: ${id.slice(0, 8)}...`);
    } catch { /* intentional */ }
  }

  // ── Accessors ──

  get alive(): boolean { return this._alive; }
  get busy(): boolean { return this._busy; }
  /** Always true — SDK provides clean structured I/O. */
  get usingChannel(): boolean { return true; }
  get remoteControlUrl(): string | null { return this._remoteControlUrl; }
  get remoteControlRunning(): boolean { return this._remoteControlProc !== null; }

  get activeSessionId(): string | null {
    return this._sessionId;
  }

  /** Update the in-memory config (e.g. after API config save). */
  updateConfig(config: ClaudeConfig): void {
    const rcWanted = config.remoteControl === true;
    const rcRunning = this._remoteControlProc !== null;

    this.config = config;

    // Start or stop remote control to match the new config
    if (rcWanted && !rcRunning) {
      this.startRemoteControl();
    } else if (!rcWanted && rcRunning) {
      this.stopRemoteControl();
    }

    log("info", `Config updated: model=${config.model}, remoteControl=${rcWanted}`);
  }

  restart(): void {
    log("info", "Restarting Claude session");
    this._activeQuery?.close();
    this._activeQuery = null;
    this._v2Session?.close();
    this._v2Session = null;
    this._busy = false;
    // Session ID preserved — next send() will resume (stable) or re-init (V2)
    if (USE_V2) this.initV2Session();
  }

  /** Start completely fresh — no --resume, no session history. */
  freshStart(): void {
    log("info", "Starting fresh Claude session");
    this._activeQuery?.close();
    this._activeQuery = null;
    this._v2Session?.close();
    this._v2Session = null;
    this._busy = false;
    this._sessionId = null;
    try { unlinkSync(this.sessionFilePath); } catch { /* intentional */ }
    if (USE_V2) this.initV2Session();
  }

  /** Switch to a specific session by UUID. */
  switchSession(sessionId: string): void {
    log("info", `Switching to session: ${sessionId}`);
    this._activeQuery?.close();
    this._activeQuery = null;
    this._v2Session?.close();
    this._v2Session = null;
    this._busy = false;
    this._sessionId = sessionId;
    this.saveSessionId(sessionId);
    if (USE_V2) this.initV2Session();
  }

  close(): void {
    this._activeQuery?.close();
    this._activeQuery = null;
    this._v2Session?.close();
    this._v2Session = null;
    this._alive = false;
    this._busy = false;
    this.stopRemoteControl();
    log("info", "Claude session closed");
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "claude-sdk", msg }) + "\n");
}
