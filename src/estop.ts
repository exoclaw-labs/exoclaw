/**
 * E-STOP — Emergency shutdown for the agent.
 *
 * Provides kill levels:
 *   - freeze:  Pause all processing (reject new messages, pause cron)
 *   - kill:    Kill the Claude tmux session immediately
 *   - resume:  Restore normal operation
 *
 * Inspired by zeroclaw's E-STOP (src/security/estop.rs).
 * Claude Code first: the actual session is a tmux process we can kill.
 */

import type { Claude } from "./claude.js";
import type { CronScheduler } from "./cron.js";
import type { AuditLogger } from "./audit.js";

export type EstopLevel = "freeze" | "kill";

export interface EstopState {
  active: boolean;
  level?: EstopLevel;
  reason?: string;
  triggered_at?: string;
  triggered_by?: string;
}

export class Estop {
  private _state: EstopState = { active: false };
  private claude: Claude;
  private scheduler: CronScheduler | null;
  private audit: AuditLogger | null;

  constructor(claude: Claude, scheduler?: CronScheduler, audit?: AuditLogger) {
    this.claude = claude;
    this.scheduler = scheduler || null;
    this.audit = audit || null;
  }

  get state(): EstopState {
    return { ...this._state };
  }

  get isActive(): boolean {
    return this._state.active;
  }

  /** Trigger emergency stop. */
  trigger(level: EstopLevel, reason: string, triggeredBy = "api"): EstopState {
    this._state = {
      active: true,
      level,
      reason,
      triggered_at: new Date().toISOString(),
      triggered_by: triggeredBy,
    };

    this.audit?.log({
      event_type: "estop",
      detail: `E-STOP triggered: level=${level}, reason=${reason}`,
      source: triggeredBy,
      severity: "critical",
    });

    // Stop cron scheduler
    this.scheduler?.stop();

    if (level === "kill") {
      // Kill the Claude tmux session
      this.claude.close();
    }

    log("critical", `E-STOP: ${level} — ${reason}`);
    return this.state;
  }

  /** Resume normal operation. */
  resume(resumedBy = "api"): EstopState {
    if (!this._state.active) return this.state;

    const prevLevel = this._state.level;

    this.audit?.log({
      event_type: "estop",
      detail: `E-STOP resumed from level=${prevLevel}`,
      source: resumedBy,
      severity: "warn",
    });

    this._state = { active: false };

    // Restart cron
    this.scheduler?.start();

    // If we killed the session, restart it
    if (prevLevel === "kill") {
      this.claude.restart();
    }

    log("info", `E-STOP resumed by ${resumedBy}`);
    return this.state;
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "estop", msg }) + "\n");
}
