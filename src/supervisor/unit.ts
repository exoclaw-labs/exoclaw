/**
 * Unit — one supervised child process with a state machine.
 *
 * States: stopped | starting | running | stopping | failed
 *
 * Features:
 *   - Child spawned in its own process group (detached: true) so stop() can
 *     SIGTERM the whole subtree via `process.kill(-pgid, sig)`.
 *   - Readiness probes: http GET /health, stdout-regex, or plain 250ms grace.
 *   - Exponential backoff 1s → 30s cap, reset after 60s healthy.
 *   - Crash-loop quarantine: 10 crashes in 5 minutes → unit stays failed,
 *     auto-restart disabled until an explicit start() call.
 *   - Per-unit mutex serializes start/stop/restart.
 *   - Ring buffer of recent stdout/stderr lines (default 2000 per unit).
 *   - Optional cron schedule fires start() on match; supervisor loop ticks
 *     once per minute and calls maybeTickSchedule().
 */

import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { request as httpRequest } from "http";
import { parseSchedule, type ParsedSchedule } from "./cron-expr.js";
import { forwardToFile, log } from "./log.js";
import type { UnitStatus, UnitState, RestartPolicy } from "./protocol.js";

export interface ReadinessHttp {
  type: "http";
  url: string;
  timeoutMs: number;
  intervalMs: number;
}

export interface ReadinessStdoutRegex {
  type: "stdout-regex";
  pattern: RegExp | string;
  timeoutMs: number;
}

export type Readiness = ReadinessHttp | ReadinessStdoutRegex;

export interface UnitSpec {
  name: string;
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  restart: RestartPolicy;
  stopGraceMs: number;
  startTimeoutMs?: number;
  readiness?: Readiness;
  autoStart: boolean;
  startOrder: number;
  stdinScript?: string;
  ringBufferLines?: number;
  /** Optional cron schedule — when set, the supervisor's cron tick calls start() on match. */
  schedule?: string;
  /**
   * When true, stdout-regex readiness extractor captures the matched URL into
   * extras.remoteControlUrl. Used by the remote-control unit.
   */
  captureRemoteControlUrl?: boolean;
  /**
   * Extras updater: called with stdout/stderr chunks so unit can extract
   * per-unit metadata (e.g. remote-control URL) beyond the readiness probe.
   */
  extrasFromOutput?: (chunk: string, current: Record<string, unknown>) => Record<string, unknown>;
}

const DEFAULT_RING_BUFFER = 2000;
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const HEALTHY_RESET_MS = 60_000;
const QUARANTINE_WINDOW_MS = 5 * 60_000;
const QUARANTINE_THRESHOLD = 10;

interface CrashEntry {
  ts: number;
  code: number | null;
  signal: string | null;
}

export class Unit extends EventEmitter {
  readonly spec: UnitSpec;
  state: UnitState = "stopped";
  proc: ChildProcess | null = null;
  pid: number | null = null;
  pgid: number | null = null;
  startedAt: number | null = null;
  restartCount = 0;
  lastExitCode: number | null = null;
  lastExitSignal: string | null = null;
  lastCrashReason: string | null = null;
  extras: Record<string, unknown> = {};

  private crashes: CrashEntry[] = [];
  private currentBackoff = BACKOFF_INITIAL_MS;
  private backoffTimer: NodeJS.Timeout | null = null;
  private readinessTimer: NodeJS.Timeout | null = null;
  private ringBuffer: string[] = [];
  private readonly ringLimit: number;
  private stopping = false;
  private quarantinedFlag = false;
  private opChain: Promise<unknown> = Promise.resolve();
  private logSubscribers = new Set<(line: string) => void>();
  private parsedSchedule: ParsedSchedule | null = null;
  private lastScheduleTick: number | null = null;

  constructor(spec: UnitSpec) {
    super();
    this.spec = spec;
    this.ringLimit = spec.ringBufferLines ?? DEFAULT_RING_BUFFER;
    if (spec.schedule) {
      try {
        this.parsedSchedule = parseSchedule(spec.schedule);
      } catch (err) {
        log("supervisor", "warn", `Unit ${spec.name}: invalid schedule "${spec.schedule}": ${(err as Error).message}`);
      }
    }
  }

  // ── Public API (serialized via opChain) ──

  start(): Promise<void> {
    return this.enqueue(() => this.doStart(/* fromScheduler */ false));
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.doStop(/* finalState */ "stopped"));
  }

  restart(): Promise<void> {
    return this.enqueue(async () => {
      await this.doStop("stopped");
      await this.doStart(false);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.catch(() => {
      /* swallow so subsequent ops run */
    });
    return next;
  }

  // ── State machine internals ──

  private async doStart(fromScheduler: boolean): Promise<void> {
    if (this.quarantinedFlag && !fromScheduler) {
      // Explicit start lifts quarantine.
      this.quarantinedFlag = false;
      this.crashes = [];
      this.currentBackoff = BACKOFF_INITIAL_MS;
    } else if (this.quarantinedFlag) {
      return;
    }

    if (this.state === "running" || this.state === "starting" || this.state === "stopping") {
      return;
    }

    this.clearBackoffTimer();
    this.setState("starting");
    this.stopping = false;

    const env = { ...process.env, ...(this.spec.env || {}) };
    let proc: ChildProcess;
    try {
      proc = spawn(this.spec.command, this.spec.args, {
        env,
        cwd: this.spec.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true, // own process group so we can SIGTERM the whole subtree
      });
    } catch (err) {
      this.lastCrashReason = `spawn failed: ${(err as Error).message}`;
      this.setState("failed");
      this.scheduleBackoffRestart();
      log("supervisor", "error", `Unit ${this.spec.name}: ${this.lastCrashReason}`);
      return;
    }

    this.proc = proc;
    this.pid = proc.pid ?? null;
    this.pgid = proc.pid ?? null; // with detached: true, pgid === pid
    this.startedAt = Date.now();

    // Feed stdin script if configured, then close stdin.
    if (this.spec.stdinScript && proc.stdin) {
      try {
        proc.stdin.write(this.spec.stdinScript);
        proc.stdin.end();
      } catch {
        /* intentional */
      }
    }

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.onOutput(chunk));
    proc.stderr?.on("data", (chunk: string) => this.onOutput(chunk));

    proc.on("error", (err) => {
      log("supervisor", "error", `Unit ${this.spec.name} proc error: ${err.message}`);
    });
    proc.on("exit", (code, signal) => this.onExit(code, signal));

    // Readiness probe
    await this.runReadinessProbe(proc);
  }

  private async runReadinessProbe(proc: ChildProcess): Promise<void> {
    const probe = this.spec.readiness;
    const timeoutMs = this.spec.startTimeoutMs ?? 30_000;

    if (!probe) {
      // Default: 250ms grace, then running.
      await new Promise((r) => setTimeout(r, 250));
      if (this.state === "starting" && !proc.killed) {
        this.setState("running");
        log("supervisor", "info", `Unit ${this.spec.name}: running (pid=${proc.pid})`);
      }
      return;
    }

    if (probe.type === "http") {
      const deadline = Date.now() + (probe.timeoutMs || timeoutMs);
      while (Date.now() < deadline && this.state === "starting") {
        const ok = await this.httpCheck(probe.url).catch(() => false);
        if (ok) {
          this.setState("running");
          log("supervisor", "info", `Unit ${this.spec.name}: running (pid=${proc.pid})`);
          return;
        }
        await new Promise((r) => setTimeout(r, probe.intervalMs));
      }
      if (this.state === "starting") {
        log("supervisor", "warn", `Unit ${this.spec.name}: readiness probe timed out`);
        this.lastCrashReason = "readiness_timeout";
        await this.killProc();
      }
      return;
    }

    if (probe.type === "stdout-regex") {
      // Watched in onOutput(); we just arm a timeout here.
      this.readinessTimer = setTimeout(() => {
        if (this.state === "starting") {
          log("supervisor", "warn", `Unit ${this.spec.name}: stdout-regex probe timed out`);
          this.lastCrashReason = "readiness_timeout";
          this.killProc().catch(() => {
            /* intentional */
          });
        }
      }, probe.timeoutMs);
    }
  }

  private async httpCheck(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = httpRequest(url, { method: "GET", timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  private onOutput(chunk: string): void {
    // Ring buffer (per-line)
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      this.ringBuffer.push(line);
      if (this.ringBuffer.length > this.ringLimit) {
        this.ringBuffer.splice(0, this.ringBuffer.length - this.ringLimit);
      }
      for (const sub of this.logSubscribers) {
        try {
          sub(line);
        } catch {
          /* intentional */
        }
      }
    }
    // Persist unit output to its per-unit rotated log file. We deliberately
    // don't mirror to stderr — supervisor events still go to `docker logs`,
    // but unit stdout/stderr is viewed via the dashboard Logs page or by
    // tailing ~/.exoclaw/logs/<unit>.log directly.
    forwardToFile(this.spec.name, chunk);

    // Extras extractor (remote-control URL, etc.)
    if (this.spec.extrasFromOutput) {
      try {
        this.extras = this.spec.extrasFromOutput(chunk, this.extras);
      } catch {
        /* intentional */
      }
    }

    // stdout-regex readiness probe
    const probe = this.spec.readiness;
    if (probe && probe.type === "stdout-regex" && this.state === "starting") {
      const pattern = typeof probe.pattern === "string" ? new RegExp(probe.pattern) : probe.pattern;
      if (pattern.test(chunk)) {
        if (this.readinessTimer) {
          clearTimeout(this.readinessTimer);
          this.readinessTimer = null;
        }
        this.setState("running");
        log("supervisor", "info", `Unit ${this.spec.name}: running (pid=${this.pid})`);
      }
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const previous = this.state;
    this.lastExitCode = code;
    this.lastExitSignal = signal;
    this.proc = null;
    this.pid = null;
    this.pgid = null;
    if (this.readinessTimer) {
      clearTimeout(this.readinessTimer);
      this.readinessTimer = null;
    }

    const runtimeMs = this.startedAt ? Date.now() - this.startedAt : 0;
    this.startedAt = null;

    if (this.stopping || previous === "stopping") {
      // Clean stop
      this.setState("stopped");
      log("supervisor", "info", `Unit ${this.spec.name}: stopped (code=${code} signal=${signal})`);
      this.stopping = false;
      return;
    }

    // Treat as a crash
    this.crashes.push({ ts: Date.now(), code, signal });
    this.crashes = this.crashes.filter((c) => Date.now() - c.ts < QUARANTINE_WINDOW_MS);
    this.restartCount++;
    this.lastCrashReason = `exit code=${code} signal=${signal ?? "none"}`;
    log(
      "supervisor",
      "warn",
      `Unit ${this.spec.name}: exited unexpectedly (code=${code} signal=${signal}) runtime=${runtimeMs}ms`
    );

    // Reset backoff if runtime was healthy
    if (runtimeMs >= HEALTHY_RESET_MS) {
      this.currentBackoff = BACKOFF_INITIAL_MS;
    }

    // Crash-loop quarantine
    if (this.crashes.length >= QUARANTINE_THRESHOLD) {
      this.quarantinedFlag = true;
      this.setState("failed");
      log(
        "supervisor",
        "error",
        `Unit ${this.spec.name}: quarantined after ${this.crashes.length} crashes in 5 minutes`
      );
      return;
    }

    const policy = this.spec.restart;
    const shouldRestart =
      policy === "always" ||
      (policy === "on-failure" && code !== 0);
    if (!shouldRestart) {
      this.setState(code === 0 ? "stopped" : "failed");
      return;
    }

    this.setState("failed");
    this.scheduleBackoffRestart();
  }

  private scheduleBackoffRestart(): void {
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    const delay = this.currentBackoff;
    this.currentBackoff = Math.min(this.currentBackoff * 2, BACKOFF_MAX_MS);
    log("supervisor", "info", `Unit ${this.spec.name}: restart in ${delay}ms (attempt ${this.restartCount + 1})`);
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.doStart(true).catch((err) => {
        log("supervisor", "error", `Unit ${this.spec.name}: backoff restart failed: ${(err as Error).message}`);
      });
    }, delay);
  }

  private clearBackoffTimer(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  private async doStop(_finalState: UnitState): Promise<void> {
    this.clearBackoffTimer();
    if (this.state === "stopped" || this.state === "failed") {
      // Mark deliberate stop even if already failed (lifts quarantine semantics)
      if (this.state === "failed") {
        this.setState("stopped");
      }
      return;
    }
    if (!this.proc || !this.pgid) {
      this.setState("stopped");
      return;
    }

    this.stopping = true;
    this.setState("stopping");

    const pgid = this.pgid;
    const grace = this.spec.stopGraceMs;
    const proc = this.proc;

    // SIGTERM the process group
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      // Group may have died already; try the pid directly
      try {
        if (this.pid) process.kill(this.pid, "SIGTERM");
      } catch {
        /* intentional */
      }
    }

    // Wait for exit or SIGKILL after grace
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        log("supervisor", "warn", `Unit ${this.spec.name}: SIGKILL after ${grace}ms grace`);
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          try {
            if (proc.pid) process.kill(proc.pid, "SIGKILL");
          } catch {
            /* intentional */
          }
        }
      }, grace);
      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private async killProc(): Promise<void> {
    if (!this.proc || !this.pgid) return;
    const pgid = this.pgid;
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      try {
        if (this.pid) process.kill(this.pid, "SIGKILL");
      } catch {
        /* intentional */
      }
    }
  }

  private setState(state: UnitState): void {
    const prev = this.state;
    this.state = state;
    if (prev !== state) this.emit("state", state, prev);
  }

  // ── Status + logs ──

  toStatus(): UnitStatus {
    const now = Date.now();
    return {
      name: this.spec.name,
      description: this.spec.description,
      state: this.state,
      pid: this.pid,
      pgid: this.pgid,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      uptimeSec: this.startedAt ? Math.floor((now - this.startedAt) / 1000) : null,
      restartCount: this.restartCount,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastCrashReason: this.lastCrashReason,
      crashHistory: this.crashes.slice(-5).map((c) => ({
        ts: new Date(c.ts).toISOString(),
        code: c.code,
        signal: c.signal,
      })),
      schedule: this.spec.schedule ?? null,
      nextRun:
        this.parsedSchedule && !this.parsedSchedule.isOneShot
          ? this.parsedSchedule.nextRun(new Date())?.toISOString() ?? null
          : this.parsedSchedule?.isOneShot
            ? this.parsedSchedule.nextRun(new Date())?.toISOString() ?? null
            : null,
      quarantined: this.quarantinedFlag,
      extras: { ...this.extras },
    };
  }

  tailLogs(n: number): string[] {
    if (n <= 0) return [];
    return this.ringBuffer.slice(-n);
  }

  subscribeLogs(fn: (line: string) => void): () => void {
    this.logSubscribers.add(fn);
    return () => this.logSubscribers.delete(fn);
  }

  // ── Cron ──

  /**
   * Called by the supervisor cron tick (once per minute). Fires start() if
   * the schedule matches the current minute and the unit is not already running.
   */
  maybeTickSchedule(now: Date): void {
    if (!this.parsedSchedule) return;
    // Debounce: at most one tick per wall-clock minute
    const minuteKey = Math.floor(now.getTime() / 60_000);
    if (this.lastScheduleTick === minuteKey) return;

    if (!this.parsedSchedule.matches(now)) return;
    this.lastScheduleTick = minuteKey;

    if (this.state === "running" || this.state === "starting" || this.state === "stopping") {
      log(
        "supervisor",
        "info",
        `Unit ${this.spec.name}: schedule fired but unit is ${this.state}, skipping`
      );
      return;
    }
    if (this.quarantinedFlag) {
      log("supervisor", "warn", `Unit ${this.spec.name}: schedule fired but unit is quarantined, skipping`);
      return;
    }
    log("supervisor", "info", `Unit ${this.spec.name}: schedule fired, starting`);
    this.enqueue(() => this.doStart(true)).catch((err) => {
      log("supervisor", "error", `Unit ${this.spec.name}: scheduled start failed: ${(err as Error).message}`);
    });
  }
}
