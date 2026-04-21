/**
 * Unix domain socket control server for the supervisor.
 *
 * Accepts newline-delimited JSON requests, dispatches to the supervisor,
 * returns newline-delimited JSON responses. One request per line.
 *
 * Mode 0600, no auth — the socket lives on the agent user's home dir,
 * anyone able to connect is already running as `agent` inside the container.
 */

import { createServer, Server, Socket } from "net";
import { existsSync, mkdirSync, unlinkSync, chmodSync } from "fs";
import { dirname } from "path";
import { log } from "./log.js";
import type { Unit } from "./unit.js";
import {
  ERR_INTERNAL,
  ERR_INVALID_REQUEST,
  ERR_UNKNOWN_OP,
  ERR_UNKNOWN_UNIT,
  SOCKET_PATH_DEFAULT,
  type Response,
  type WireRequest,
} from "./protocol.js";
import type { UpgradeOrchestrator } from "./upgrade.js";

export interface ControlDeps {
  units: Map<string, Unit>;
  upgrade: UpgradeOrchestrator;
  socketPath?: string;
  version: string;
  startedAt: number;
}

export class ControlServer {
  private server: Server | null = null;
  private readonly socketPath: string;

  constructor(private deps: ControlDeps) {
    this.socketPath = deps.socketPath ?? SOCKET_PATH_DEFAULT;
  }

  start(): Promise<void> {
    const dir = dirname(this.socketPath);
    mkdirSync(dir, { recursive: true });
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch (err) {
        log("supervisor", "warn", `Could not unlink stale socket: ${(err as Error).message}`);
      }
    }
    const server = createServer((sock) => this.handleConnection(sock));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        try {
          chmodSync(this.socketPath, 0o600);
        } catch {
          /* intentional */
        }
        log("supervisor", "info", `Control socket listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      /* intentional */
    }
  }

  private handleConnection(sock: Socket): void {
    sock.setEncoding("utf8");
    let buffer = "";
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      // eslint-disable-next-line no-cond-assign
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) continue;
        void this.handleLine(sock, line);
      }
    });
    sock.on("error", (err) => {
      log("supervisor", "debug", `control socket client error: ${err.message}`);
    });
  }

  private async handleLine(sock: Socket, line: string): Promise<void> {
    let req: WireRequest;
    try {
      req = JSON.parse(line) as WireRequest;
    } catch {
      this.sendResponse(sock, { id: "unknown", ok: false, error: ERR_INVALID_REQUEST, detail: "malformed json" });
      return;
    }
    if (typeof req.id !== "string" || typeof req.op !== "string") {
      this.sendResponse(sock, { id: req.id || "unknown", ok: false, error: ERR_INVALID_REQUEST });
      return;
    }
    try {
      const resp = await this.dispatch(sock, req);
      if (resp) this.sendResponse(sock, resp);
    } catch (err) {
      log("supervisor", "error", `control dispatch error: ${(err as Error).message}`);
      this.sendResponse(sock, {
        id: req.id,
        ok: false,
        error: ERR_INTERNAL,
        detail: (err as Error).message,
      });
    }
  }

  private async dispatch(sock: Socket, req: WireRequest): Promise<Response | null> {
    switch (req.op) {
      case "ping":
        return {
          id: req.id,
          ok: true,
          result: {
            pid: process.pid,
            uptimeSec: Math.floor((Date.now() - this.deps.startedAt) / 1000),
            version: this.deps.version,
          },
        };

      case "status":
        return {
          id: req.id,
          ok: true,
          result: {
            units: Array.from(this.deps.units.values()).map((u) => u.toStatus()),
          },
        };

      case "unit-info": {
        const unit = this.requireUnit(req.unit);
        if (!unit) return { id: req.id, ok: false, error: ERR_UNKNOWN_UNIT, detail: req.unit };
        return { id: req.id, ok: true, result: unit.toStatus() };
      }

      case "start": {
        const unit = this.requireUnit(req.unit);
        if (!unit) return { id: req.id, ok: false, error: ERR_UNKNOWN_UNIT, detail: req.unit };
        await unit.start();
        return { id: req.id, ok: true, result: unit.toStatus() };
      }

      case "stop": {
        const unit = this.requireUnit(req.unit);
        if (!unit) return { id: req.id, ok: false, error: ERR_UNKNOWN_UNIT, detail: req.unit };
        await unit.stop();
        return { id: req.id, ok: true, result: unit.toStatus() };
      }

      case "restart": {
        const unit = this.requireUnit(req.unit);
        if (!unit) return { id: req.id, ok: false, error: ERR_UNKNOWN_UNIT, detail: req.unit };
        await unit.restart();
        return { id: req.id, ok: true, result: unit.toStatus() };
      }

      case "logs": {
        const unit = this.requireUnit(req.unit);
        if (!unit) return { id: req.id, ok: false, error: ERR_UNKNOWN_UNIT, detail: req.unit };
        const tail = req.tail ?? 200;
        const lines = unit.tailLogs(tail);
        if (req.follow) {
          // Send existing tail, then stream new lines; never send a final result.
          // Client reads until socket closes.
          for (const line of lines) {
            sock.write(JSON.stringify({ id: req.id, stream: "log", line }) + "\n");
          }
          const unsub = unit.subscribeLogs((line) => {
            sock.write(JSON.stringify({ id: req.id, stream: "log", line }) + "\n");
          });
          sock.on("close", unsub);
          sock.on("end", unsub);
          return null;
        }
        return { id: req.id, ok: true, result: { lines } };
      }

      case "upgrade": {
        if (req.target !== "claude") {
          return { id: req.id, ok: false, error: ERR_UNKNOWN_OP, detail: `unsupported target: ${req.target}` };
        }
        const result = await this.deps.upgrade.upgradeClaude({ noGatewayRestart: req.noGatewayRestart });
        if (!result.ok) {
          return { id: req.id, ok: false, error: result.error, detail: result.detail };
        }
        return { id: req.id, ok: true, result: result.result };
      }

      default:
        return { id: req.id, ok: false, error: ERR_UNKNOWN_OP, detail: req.op };
    }
  }

  private requireUnit(name: string | undefined): Unit | null {
    if (!name) return null;
    return this.deps.units.get(name) ?? null;
  }

  private sendResponse(sock: Socket, resp: Response): void {
    try {
      sock.write(JSON.stringify(resp) + "\n");
    } catch {
      /* intentional */
    }
  }
}
