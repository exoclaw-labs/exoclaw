/**
 * Terminal WebSocket — persistent shell via node-pty.
 *
 * Connect: ws://<host>/ws/terminal
 * Auth:    Same as /ws/chat (Bearer header, subprotocol, or query param)
 *
 * The shell runs in a node-pty instance that persists across WebSocket
 * disconnects. Navigating away and reconnecting reattaches to the same
 * session with full scrollback and state preserved.
 *
 * Protocol:
 *   Client -> Server: raw text (stdin)
 *   Server -> Client: raw text (stdout/stderr)
 *   Client -> Server: JSON { type: "resize", cols, rows } for terminal resize
 */

import { type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";

/** Per-session PTY state — keyed by session ID. */
interface PtySession {
  pty: pty.IPty;
  outputBuffer: string;
}

const sessions = new Map<string, PtySession>();
const OUTPUT_BUFFER_LIMIT = 50_000;

/** Ensure a PTY session exists for the given ID. */
function ensureSession(id: string, cols: number, rows: number): PtySession {
  const existing = sessions.get(id);
  if (existing) return existing;

  const shell = process.env.SHELL || "/bin/bash";
  const home = process.env.HOME || "/home/agent";
  const cwd = `${home}/workspace`;

  const p = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  const session: PtySession = { pty: p, outputBuffer: "" };

  p.onData((data) => {
    session.outputBuffer += data;
    if (session.outputBuffer.length > OUTPUT_BUFFER_LIMIT) {
      session.outputBuffer = session.outputBuffer.slice(-OUTPUT_BUFFER_LIMIT);
    }
  });

  p.onExit(({ exitCode }) => {
    log(`PTY [${id}] exited with code ${exitCode} — will respawn on next connect`);
    sessions.delete(id);
  });

  sessions.set(id, session);
  log(`Created PTY session [${id}]`);
  return session;
}

export function setupTerminal(server: Server, apiToken?: string): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws/terminal") return;

    // Auth
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

    const sessionId = url.searchParams.get("id") || "default";
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, sessionId);
    });
  });

  wss.on("connection", (ws: WebSocket, sessionId: string) => {
    log(`Terminal connected [${sessionId}]`);

    const session = ensureSession(sessionId, 120, 30);

    // Send buffered output so reconnecting clients get context
    if (session.outputBuffer.length > 0) {
      ws.send(session.outputBuffer);
    }

    // Forward PTY output to WebSocket
    const dataHandler = session.pty.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    ws.on("message", (data) => {
      const msg = data.toString();
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "resize" && parsed.cols && parsed.rows) {
          session.pty.resize(parsed.cols, parsed.rows);
          return;
        }
      } catch {
        // Not JSON — raw stdin
      }
      session.pty.write(msg);
    });

    ws.on("close", () => {
      log(`Terminal disconnected [${sessionId}] — session preserved`);
      dataHandler.dispose();
    });
  });

  log("Terminal WebSocket enabled at /ws/terminal");
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level: "info", component: "terminal", msg }) + "\n");
}
