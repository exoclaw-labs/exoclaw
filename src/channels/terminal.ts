/**
 * Terminal WebSocket — persistent shell via a dedicated tmux session.
 *
 * Connect: ws://<host>/ws/terminal
 * Auth:    Same as /ws/chat (Bearer header, subprotocol, or query param)
 *
 * The shell runs in a tmux session ("exoclaw-term") that persists across
 * WebSocket disconnects. Navigating away and reconnecting reattaches to
 * the same session with full scrollback and state preserved.
 *
 * Protocol:
 *   Client -> Server: raw text (stdin)
 *   Server -> Client: raw text (stdout/stderr)
 *   Client -> Server: JSON { type: "resize", cols, rows } for terminal resize
 */

import { type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { spawn, execSync, type ChildProcess } from "child_process";

const TERM_SESSION = "exoclaw-term";

/** Ensure the persistent tmux session exists. */
function ensureSession(): void {
  try {
    execSync(`tmux has-session -t ${TERM_SESSION} 2>/dev/null`);
  } catch {
    // Create a new detached session
    const shell = process.env.SHELL || "/bin/bash";
    const cwd = process.env.HOME || "/home/agent";
    execSync(`tmux new-session -d -s ${TERM_SESSION} -x 120 -y 30 ${shell}`, {
      env: { ...process.env, TERM: "xterm-256color" },
      cwd,
    });
    log("Created persistent terminal session");
  }
}

/** Attach to the tmux session via `tmux attach` in a PTY-like pipe. */
function attachToSession(cols: number, rows: number): ChildProcess {
  // Resize the tmux pane to match the client terminal
  try {
    execSync(`tmux resize-window -t ${TERM_SESSION} -x ${cols} -y ${rows} 2>/dev/null`);
  } catch { /* may fail if session was just created */ }

  // Use script (Linux) or just run tmux attach directly
  const isLinux = process.platform === "linux";
  if (isLinux) {
    return spawn("script", ["-qfc", `tmux attach-session -t ${TERM_SESSION}`, "/dev/null"], {
      env: { ...process.env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) },
    });
  } else {
    return spawn("tmux", ["attach-session", "-t", TERM_SESSION], {
      env: { ...process.env, TERM: "xterm-256color" },
    });
  }
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

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    log("Terminal connected");

    // Ensure the persistent session exists
    ensureSession();

    // Attach to the tmux session
    let proc = attachToSession(120, 30);

    proc.stdout?.on("data", (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    proc.on("exit", () => {
      log("Attach process exited");
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    ws.on("message", (data) => {
      const msg = data.toString();
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "resize" && parsed.cols && parsed.rows) {
          try {
            execSync(`tmux resize-window -t ${TERM_SESSION} -x ${parsed.cols} -y ${parsed.rows} 2>/dev/null`);
          } catch { /* intentional */ }
          return;
        }
      } catch {
        // Not JSON — raw stdin
      }
      proc.stdin?.write(msg);
    });

    ws.on("close", () => {
      log("Terminal disconnected — session preserved");
      // Kill only the attach process, NOT the tmux session
      proc.kill();
    });
  });

  log("Terminal WebSocket enabled at /ws/terminal");
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level: "info", component: "terminal", msg }) + "\n");
}
