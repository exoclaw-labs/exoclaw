/**
 * SupervisorClient — connect to the supervisor control socket and issue ops.
 *
 * Used by:
 *   - exoclawctl CLI (src/supervisor/cli.ts)
 *   - the gateway (src/server.ts) to proxy /api/services/* and to read
 *     the current remote-control URL for /api/status.
 *
 * Single connection per call; no connection pooling. The control socket is
 * local, so the overhead is negligible.
 */

import { createConnection, Socket } from "net";
import {
  SOCKET_PATH_DEFAULT,
  SupervisorUnavailable,
  type UnitStatus,
  type UpgradeResult,
} from "./protocol.js";

export interface SupervisorClientOptions {
  socketPath?: string;
  defaultTimeoutMs?: number;
}

export interface PingResult {
  pid: number;
  uptimeSec: number;
  version: string;
}

export class SupervisorClient {
  private readonly socketPath: string;
  private readonly defaultTimeoutMs: number;
  private availableCache: { value: boolean; expires: number } | null = null;

  constructor(opts: SupervisorClientOptions = {}) {
    this.socketPath = opts.socketPath ?? SOCKET_PATH_DEFAULT;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 2000;
  }

  async available(): Promise<boolean> {
    const now = Date.now();
    if (this.availableCache && this.availableCache.expires > now) {
      return this.availableCache.value;
    }
    let ok: boolean;
    try {
      await this.ping();
      ok = true;
    } catch {
      ok = false;
    }
    this.availableCache = { value: ok, expires: now + 5000 };
    return ok;
  }

  async ping(): Promise<PingResult> {
    return this.request<PingResult>({ op: "ping" });
  }

  async status(): Promise<{ units: UnitStatus[] }> {
    return this.request<{ units: UnitStatus[] }>({ op: "status" });
  }

  async unitInfo(name: string): Promise<UnitStatus> {
    return this.request<UnitStatus>({ op: "unit-info", unit: name });
  }

  async start(name: string): Promise<UnitStatus> {
    return this.request<UnitStatus>({ op: "start", unit: name });
  }

  async stop(name: string): Promise<UnitStatus> {
    return this.request<UnitStatus>({ op: "stop", unit: name });
  }

  async restart(name: string): Promise<UnitStatus> {
    return this.request<UnitStatus>({ op: "restart", unit: name });
  }

  async logs(name: string, tail = 200): Promise<string[]> {
    const result = await this.request<{ lines: string[] }>({ op: "logs", unit: name, tail });
    return result.lines;
  }

  async upgradeClaude(opts: { noGatewayRestart?: boolean } = {}): Promise<UpgradeResult> {
    return this.request<UpgradeResult>(
      { op: "upgrade", target: "claude", noGatewayRestart: opts.noGatewayRestart },
      180_000
    );
  }

  // ── Streaming logs ──
  async followLogs(
    name: string,
    onLine: (line: string) => void,
    tail = 200
  ): Promise<() => void> {
    const sock = await this.connect();
    const id = randomId();
    sock.write(JSON.stringify({ id, op: "logs", unit: name, tail, follow: true }) + "\n");

    let buffer = "";
    sock.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let idx: number;
      // eslint-disable-next-line no-cond-assign
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { stream?: string; line?: string };
          if (msg.stream === "log" && typeof msg.line === "string") {
            onLine(msg.line);
          }
        } catch {
          /* intentional */
        }
      }
    });

    return () => {
      sock.destroy();
    };
  }

  // ── internals ──

  private request<T>(body: Record<string, unknown>, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    return new Promise((resolve, reject) => {
      let sock: Socket;
      try {
        sock = createConnection(this.socketPath);
      } catch (err) {
        reject(new SupervisorUnavailable((err as Error).message));
        return;
      }
      const id = randomId();
      let buffer = "";
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        sock.destroy();
        reject(new Error(`supervisor request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      sock.on("connect", () => {
        sock.write(JSON.stringify({ id, ...body }) + "\n");
      });
      sock.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const idx = buffer.indexOf("\n");
        if (idx < 0) return;
        const line = buffer.slice(0, idx).trim();
        try {
          const msg = JSON.parse(line) as {
            id: string;
            ok: boolean;
            result?: T;
            error?: string;
            detail?: string;
          };
          if (done) return;
          done = true;
          clearTimeout(timer);
          sock.end();
          if (msg.ok) {
            resolve(msg.result as T);
          } else {
            const err = new Error(msg.error || "supervisor_error");
            (err as Error & { detail?: string }).detail = msg.detail;
            reject(err);
          }
        } catch (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          sock.destroy();
          reject(err);
        }
      });
      sock.on("error", (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          reject(new SupervisorUnavailable(`${code}: ${this.socketPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      sock.once("connect", () => resolve(sock));
      sock.once("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          reject(new SupervisorUnavailable(`${code}: ${this.socketPath}`));
        } else {
          reject(err);
        }
      });
    });
  }
}

function randomId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
