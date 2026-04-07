/**
 * Terminal WebSocket — spawns a shell PTY and pipes I/O over WebSocket.
 *
 * Connect: ws://<host>/ws/terminal
 * Auth:    Same as /ws/chat (Bearer header, subprotocol, or query param)
 *
 * Protocol:
 *   Client -> Server: raw text (stdin)
 *   Server -> Client: raw text (stdout/stderr)
 *   Client -> Server: JSON { type: "resize", cols, rows } for terminal resize
 */

import { type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { spawn, type ChildProcess } from "child_process";

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

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    log("Terminal connected");

    const isLinux = process.platform === "linux";
    let proc: ChildProcess;

    if (isLinux) {
      proc = spawn("script", ["-qfc", "/bin/bash", "/dev/null"], {
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLUMNS: "120",
          LINES: "30",
        },
        cwd: process.env.HOME || "/home/agent",
      });
    } else {
      proc = spawn(process.env.SHELL || "/bin/bash", ["-i"], {
        env: {
          ...process.env,
          TERM: "xterm-256color",
        },
        cwd: process.env.HOME || "/home/agent",
      });
    }

    proc.stdout?.on("data", (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    proc.on("exit", (code) => {
      log(`Shell exited: ${code}`);
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    ws.on("message", (data) => {
      const msg = data.toString();
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "resize" && parsed.cols && parsed.rows) return;
      } catch {
        // Not JSON — raw stdin
      }
      proc.stdin?.write(msg);
    });

    ws.on("close", () => {
      log("Terminal disconnected");
      proc.kill();
    });
  });

  log("Terminal WebSocket enabled at /ws/terminal");
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level: "info", component: "terminal", msg }) + "\n");
}
