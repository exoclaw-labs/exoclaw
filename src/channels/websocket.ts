/**
 * WebSocket chat — replicates zeroclaw's /ws/chat protocol.
 *
 * Connect: ws://<host>/ws/chat?session_id=<uuid>&name=<label>
 * Auth:    Authorization: Bearer <token>  (header)
 *          Sec-WebSocket-Protocol: bearer.<token>  (browser fallback)
 *          ?token=<token>  (query fallback)
 *
 * Protocol:
 *   Server -> Client:
 *     { type: "session_start", session_id, resumed, message_count }
 *     { type: "chunk", content: "partial text" }
 *     { type: "thinking", content: "..." }
 *     { type: "tool_call", name, args }
 *     { type: "tool_result", name, output }
 *     { type: "done", full_response }
 *     { type: "error", message, code }
 *
 *   Client -> Server:
 *     { type: "message", content: "user text" }
 */

import { type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { Claude } from "../claude.js";
import { scanForLeaks } from "../content-scanner.js";
import type { Estop } from "../estop.js";

export function setupWebSocket(server: Server, claude: Claude, apiToken?: string, estop?: Estop): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws/chat") {
      socket.destroy();
      return;
    }

    // Auth: header > subprotocol > query
    if (apiToken) {
      const auth = req.headers.authorization;
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      const proto = (req.headers["sec-websocket-protocol"] || "")
        .split(",").map((s: string) => s.trim())
        .find((s: string) => s.startsWith("bearer."));
      const protoToken = proto?.slice(7);
      const queryToken = url.searchParams.get("token");
      const token = bearer || protoToken || queryToken;

      if (token !== apiToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = url.searchParams.get("session_id") || crypto.randomUUID();
      const name = url.searchParams.get("name") || undefined;
      wss.emit("connection", ws, sessionId, name);
    });
  });

  wss.on("connection", (ws: WebSocket, sessionId: string, name?: string) => {
    log(`Connected: ${sessionId}`);

    // Session start
    ws.send(JSON.stringify({
      type: "session_start",
      session_id: sessionId,
      resumed: false,
      message_count: 0,
      ...(name ? { name } : {}),
    }));

    ws.on("message", async (data) => {
      let parsed: { type?: string; content?: string };
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON", code: "PARSE_ERROR" }));
        return;
      }

      // Accept zeroclaw protocol: { type: "message", content: "..." }
      // Also accept simple: { prompt: "..." } for backwards compat
      const content = parsed.content || (parsed as any).prompt;
      if (!content) {
        ws.send(JSON.stringify({ type: "error", message: "Message content required", code: "INVALID_REQUEST" }));
        return;
      }

      if (estop?.isActive) {
        ws.send(JSON.stringify({ type: "error", message: "Agent is in emergency stop mode", code: "ESTOP_ACTIVE" }));
        return;
      }
      if (!claude.alive) {
        ws.send(JSON.stringify({ type: "error", message: "Session not running", code: "SESSION_DOWN" }));
        return;
      }
      if (claude.busy) {
        ws.send(JSON.stringify({ type: "error", message: "Session is busy", code: "SESSION_BUSY" }));
        return;
      }

      let fullResponse = "";

      try {
        for await (const event of claude.send(content)) {
          if (ws.readyState !== WebSocket.OPEN) break;

          if (event.type === "chunk") {
            fullResponse += event.content;
            ws.send(JSON.stringify({ type: "chunk", content: event.content }));
          } else if (event.type === "tool") {
            ws.send(JSON.stringify({ type: "tool_call", name: event.content, args: {} }));
          } else if (event.type === "done") {
            fullResponse = event.content || fullResponse;
            // Scan for credential leaks before sending to user
            const leak = scanForLeaks(fullResponse);
            if (leak.leaked) {
              log(`Credential leak blocked: ${leak.reason}`);
              fullResponse = "[Response redacted — contained sensitive credentials. The agent has been notified.]";
            }
            ws.send(JSON.stringify({ type: "done", full_response: fullResponse }));
          } else if (event.type === "error") {
            ws.send(JSON.stringify({ type: "error", message: event.content, code: "AGENT_ERROR" }));
          }
        }
      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: String(err), code: "AGENT_ERROR" }));
        }
      }
    });

    ws.on("close", () => log(`Disconnected: ${sessionId}`));
  });

  log("WebSocket channel enabled at /ws/chat");
}


function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level: "info", component: "ws", msg }) + "\n");
}
