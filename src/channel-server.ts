#!/usr/bin/env node
/**
 * MCP Channel Server — bridges the gateway to a Claude Code session.
 *
 * Claude Code spawns this as a subprocess (stdio transport).
 * The gateway communicates with it via a local HTTP server on a Unix
 * socket or TCP port.
 *
 * Flow:
 *   Gateway HTTP → this process → MCP notification → Claude sees <channel> event
 *   Claude calls reply tool → this process → Gateway callback → original requester
 *
 * This gives us clean, structured I/O instead of tmux screen scraping.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { SessionDB } from "./session-db.js";

// Port for gateway ↔ channel communication
const CHANNEL_PORT = parseInt(process.env.CHANNEL_PORT || "3200", 10);

// Pending response callbacks: requestId → resolve function
const pending = new Map<string, (text: string) => void>();

// Session database for search tool (opened read-only)
let sessionDb: SessionDB | null = null;
try {
  sessionDb = new SessionDB();
} catch (err) {
  log(`Session DB unavailable for search tool: ${err}`);
}

// ── MCP Server ──

const mcp = new Server(
  { name: "exoclaw-gateway", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
    instructions: [
      "Messages from the exoclaw gateway arrive as <channel source=\"gateway\" request_id=\"...\">. The sender reads a web chat or messaging app — they cannot see your terminal output. Anything you want them to see MUST go through the reply tool.",
      "",
      "When a channel message arrives, respond by calling the reply tool with the request_id from the channel tag and your response text. This is the ONLY way to send your response back to the caller.",
      "",
      "Keep responses focused and conversational. The caller is waiting for your reply in real-time.",
      "",
      "You also have access to a session_search tool that lets you search your past conversation history. When the user references something from a previous session or you suspect relevant cross-session context exists, use session_search to recall it before asking them to repeat themselves.",
      "",
      "You can use the clarify tool to ask the user a question when you need clarification, want to offer choices, or need a decision before proceeding. This is especially useful when a task is ambiguous or has multiple valid approaches.",
      "",
      "Before performing dangerous or irreversible actions (deleting files, running risky commands, making external API calls with side effects), use the request_approval tool to get explicit user confirmation first.",
    ].join("\n"),
  },
);

// ── Reply Tool ──

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a reply back to the gateway caller. Use this to respond to channel messages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          request_id: {
            type: "string",
            description: "The request_id from the incoming channel message",
          },
          text: {
            type: "string",
            description: "The response text to send back",
          },
        },
        required: ["request_id", "text"],
      },
    },
    {
      name: "session_search",
      description: "Search your past conversation history. Use this when the user references something from a previous session, or when you need to recall context from earlier conversations. Returns matching message excerpts grouped by session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Full-text search query. Supports natural language keywords.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default: 10)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "clarify",
      description: "Ask the user a question when you need clarification, want to offer choices, or need a decision before proceeding. The question is sent through the channel and the user's response is returned. Use this when a task is ambiguous or has trade-offs the user should decide.",
      inputSchema: {
        type: "object" as const,
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user",
          },
          choices: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of choices (max 4). An 'Other' option is automatically added.",
          },
        },
        required: ["question"],
      },
    },
    {
      name: "request_approval",
      description: "Request user approval before performing a potentially dangerous or irreversible action. The request is sent to the user and you must wait for their response before proceeding. Use for: deleting files, running risky commands, making external API calls with side effects, or any action the user might want to review first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            description: "What you want to do (e.g., 'Delete 15 files matching *.tmp')",
          },
          detail: {
            type: "string",
            description: "Additional context about why this action is needed",
          },
          risk_level: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
            description: "How risky is this action? (default: medium)",
          },
        },
        required: ["action"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { request_id, text } = req.params.arguments as { request_id: string; text: string };

    const resolve = pending.get(request_id);
    if (resolve) {
      resolve(text);
      pending.delete(request_id);
      return { content: [{ type: "text", text: `Reply sent (${request_id})` }] };
    }

    return { content: [{ type: "text", text: `No pending request for ${request_id}` }] };
  }

  if (req.params.name === "session_search") {
    const { query, limit = 10 } = req.params.arguments as { query: string; limit?: number };

    if (!sessionDb) {
      return { content: [{ type: "text", text: "Session search is not available (database not initialized)" }] };
    }

    try {
      const results = sessionDb.search(query, limit);

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No results found for "${query}"` }] };
      }

      // Group by session and format results
      const grouped = new Map<number, { title: string | null; date: string; messages: string[] }>();
      for (const r of results) {
        if (!grouped.has(r.session_id)) {
          grouped.set(r.session_id, {
            title: r.session_title,
            date: r.session_started_at,
            messages: [],
          });
        }
        grouped.get(r.session_id)!.messages.push(
          `[${r.role}]: ${r.snippet || r.content.slice(0, 200)}`
        );
      }

      const formatted = Array.from(grouped.entries())
        .map(([_id, g]) => {
          const header = `## Session: ${g.title || "Untitled"} (${g.date})`;
          return `${header}\n${g.messages.join("\n")}`;
        })
        .join("\n\n---\n\n");

      return { content: [{ type: "text", text: `Found ${results.length} result(s) across ${grouped.size} session(s):\n\n${formatted}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Search error: ${err}` }] };
    }
  }

  if (req.params.name === "clarify") {
    const { question, choices } = req.params.arguments as { question: string; choices?: string[] };

    // Format the question with choices
    let formatted = question;
    if (choices && choices.length > 0) {
      const opts = [...choices.slice(0, 4), "Other (type your answer)"];
      formatted += "\n\n" + opts.map((c, i) => `${i + 1}. ${c}`).join("\n");
    }

    // Use the channel notification system to ask the user
    // The gateway will route this as a message and return the user's reply
    const clarifyId = `clarify-${crypto.randomUUID().slice(0, 8)}`;

    const clarifyPromise = new Promise<string>((resolve) => {
      pending.set(clarifyId, resolve);
      setTimeout(() => {
        if (pending.has(clarifyId)) {
          pending.delete(clarifyId);
          resolve("[timeout — no response from user]");
        }
      }, 5 * 60 * 1000);
    });

    // Push the question back through the channel as a notification
    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `[Clarification needed]\n\n${formatted}`,
          meta: { source: "clarify", request_id: clarifyId },
        },
      });
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to send clarification: ${err}` }] };
    }

    const response = await clarifyPromise;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          question,
          choices: choices || [],
          user_response: response,
        }),
      }],
    };
  }

  if (req.params.name === "request_approval") {
    const { action, detail, risk_level = "medium" } = req.params.arguments as {
      action: string; detail?: string; risk_level?: string;
    };

    const risk = risk_level as "low" | "medium" | "high" | "critical";

    // Format the approval request message
    const riskLabel = { low: "Low", medium: "Medium", high: "HIGH", critical: "CRITICAL" }[risk] || "Medium";
    const approvalId = crypto.randomUUID().slice(0, 8);

    const message = [
      `**Approval Required** [${riskLabel} Risk]`,
      "",
      `**Action:** ${action}`,
      detail ? `**Details:** ${detail}` : "",
      "",
      `Approval ID: \`${approvalId}\``,
      `Reply: "approve ${approvalId}" or "deny ${approvalId}"`,
    ].filter(Boolean).join("\n");

    // Send approval request through the channel
    const approvalPromise = new Promise<string>((resolve) => {
      pending.set(approvalId, resolve);
      setTimeout(() => {
        if (pending.has(approvalId)) {
          pending.delete(approvalId);
          resolve("denied:timeout");
        }
      }, 5 * 60 * 1000);
    });

    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: message,
          meta: { source: "approval", request_id: approvalId },
        },
      });
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to send approval request: ${err}` }] };
    }

    const response = await approvalPromise;
    const approved = response.toLowerCase().includes("approve") && !response.toLowerCase().includes("deny");

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          approved,
          action,
          risk_level: risk,
          user_response: response,
          approval_id: approvalId,
        }),
      }],
    };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
});

// ── Local HTTP Server (gateway talks to us here) ──

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // POST /push — gateway pushes a message into the Claude session
  if (req.method === "POST" && req.url === "/push") {
    const body = await readBody(req);
    if (!body) { res.writeHead(400); res.end(); return; }

    let parsed: { prompt: string; request_id: string; source?: string; meta?: Record<string, string> };
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end("invalid json"); return; }

    const { prompt, request_id, source = "gateway", meta = {} } = parsed;

    // Create a promise that resolves when Claude calls the reply tool
    const responsePromise = new Promise<string>((resolve) => {
      pending.set(request_id, resolve);

      // Timeout after 5 minutes
      setTimeout(() => {
        if (pending.has(request_id)) {
          pending.delete(request_id);
          resolve("[timeout — no reply from Claude]");
        }
      }, 5 * 60 * 1000);
    });

    // Push the message into Claude as a channel notification
    try {
      log(`Pushing channel notification: ${prompt.slice(0, 80)}`);
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: prompt,
          meta: { source, request_id, ...meta },
        },
      });
      log(`Channel notification sent OK`);
    } catch (err) {
      log(`Channel notification error: ${err}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
      return;
    }

    // Wait for Claude to reply
    const reply = await responsePromise;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ response: reply, request_id }));
    return;
  }

  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", pending: pending.size }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

// ── Startup ──

async function main() {
  // Start local HTTP server for gateway communication
  http.listen(CHANNEL_PORT, "127.0.0.1", () => {
    log(`Channel HTTP server on 127.0.0.1:${CHANNEL_PORT}`);
  });

  // Connect to Claude Code via stdio
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("MCP channel connected to Claude Code");
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});

// ── Utils ──

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", () => resolve(null));
  });
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level: "info", component: "channel-mcp", msg }) + "\n");
}
