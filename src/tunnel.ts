/**
 * Tunnel Manager — expose the gateway to the internet without external reverse proxy.
 *
 * Supports multiple tunnel providers:
 *   - cloudflare: Cloudflare Tunnel (cloudflared)
 *   - ngrok:      ngrok tunnel
 *   - tailscale:  Tailscale Funnel
 *   - custom:     arbitrary command
 *
 * The tunnel process is managed as a child process with auto-restart.
 * The public URL is captured from stdout and exposed via the API.
 *
 * Inspired by ZeroClaw's tunnel system (src/tunnel/).
 */

import { spawn, type ChildProcess } from "child_process";

export type TunnelProvider = "cloudflare" | "ngrok" | "tailscale" | "custom" | "none";

export interface TunnelConfig {
  provider: TunnelProvider;
  port: number;
  /** Auth token for the tunnel provider. */
  token?: string;
  /** Custom command (for "custom" provider). */
  command?: string;
  /** Custom args. */
  args?: string[];
  /** Cloudflare tunnel name. */
  tunnelName?: string;
}

export interface TunnelStatus {
  provider: TunnelProvider;
  running: boolean;
  publicUrl: string | null;
  error: string | null;
  startedAt: string | null;
}

export class TunnelManager {
  private config: TunnelConfig;
  private proc: ChildProcess | null = null;
  private _publicUrl: string | null = null;
  private _error: string | null = null;
  private _startedAt: string | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: TunnelConfig) {
    this.config = config;
  }

  start(): void {
    if (this.config.provider === "none") return;

    const { command, args } = this.buildCommand();
    if (!command) {
      this._error = `Unknown tunnel provider: ${this.config.provider}`;
      log("error", this._error);
      return;
    }

    log("info", `Starting ${this.config.provider} tunnel: ${command} ${args.join(" ")}`);
    this._startedAt = new Date().toISOString();
    this._error = null;

    this.proc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(this.config.token ? { TUNNEL_TOKEN: this.config.token } : {}) },
    });

    this.proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.parseUrl(text);
    });

    this.proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.parseUrl(text);
      // Don't log every stderr line — tunnels are chatty
    });

    this.proc.on("exit", (code) => {
      log("warn", `Tunnel exited with code ${code}`);
      this.proc = null;
      if (code !== 0) {
        this._error = `Tunnel exited with code ${code}`;
        // Auto-restart after 10s
        this.restartTimer = setTimeout(() => this.start(), 10_000);
      }
    });

    this.proc.on("error", (err) => {
      this._error = `Tunnel error: ${err.message}`;
      log("error", this._error);
      this.proc = null;
    });
  }

  stop(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this._publicUrl = null;
    this._startedAt = null;
    log("info", "Tunnel stopped");
  }

  get status(): TunnelStatus {
    return {
      provider: this.config.provider,
      running: this.proc !== null,
      publicUrl: this._publicUrl,
      error: this._error,
      startedAt: this._startedAt,
    };
  }

  get publicUrl(): string | null { return this._publicUrl; }

  private buildCommand(): { command: string; args: string[] } {
    const port = this.config.port;

    switch (this.config.provider) {
      case "cloudflare":
        return {
          command: "cloudflared",
          args: this.config.tunnelName
            ? ["tunnel", "run", "--url", `http://localhost:${port}`, this.config.tunnelName]
            : ["tunnel", "--url", `http://localhost:${port}`, ...(this.config.token ? ["--token", this.config.token] : [])],
        };
      case "ngrok":
        return {
          command: "ngrok",
          args: ["http", String(port), ...(this.config.token ? ["--authtoken", this.config.token] : []), "--log", "stdout"],
        };
      case "tailscale":
        return {
          command: "tailscale",
          args: ["funnel", String(port)],
        };
      case "custom":
        if (!this.config.command) return { command: "", args: [] };
        return {
          command: this.config.command,
          args: this.config.args || [],
        };
      default:
        return { command: "", args: [] };
    }
  }

  private parseUrl(text: string): void {
    // Common URL patterns from tunnel providers
    const patterns = [
      /https?:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
      /https?:\/\/[a-z0-9-]+\.ngrok-free\.app/i,
      /https?:\/\/[a-z0-9-]+\.ngrok\.io/i,
      /https?:\/\/[a-z0-9.-]+\.ts\.net[^\s]*/i,
      /Forwarding\s+(https?:\/\/[^\s]+)/i,
      /your url is:\s*(https?:\/\/[^\s]+)/i,
      /(https?:\/\/[a-z0-9-]+\.[a-z]+\.[a-z]+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const url = match[1] || match[0];
        if (url !== this._publicUrl) {
          this._publicUrl = url;
          log("info", `Tunnel URL: ${url}`);
        }
        return;
      }
    }
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "tunnel", msg }) + "\n");
}
