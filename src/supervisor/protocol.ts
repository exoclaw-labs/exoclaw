/**
 * Shared protocol types for the exoclaw supervisor control socket.
 *
 * Protocol: newline-delimited JSON over a Unix domain socket.
 * One request per line, one response per request.
 */

export const SOCKET_PATH_DEFAULT = `${process.env.HOME || "/home/agent"}/.exoclaw/ctl.sock`;

export type UnitState = "stopped" | "starting" | "running" | "stopping" | "failed";
export type RestartPolicy = "no" | "on-failure" | "always";

export interface UnitStatus {
  name: string;
  description: string;
  state: UnitState;
  pid: number | null;
  pgid: number | null;
  startedAt: string | null;
  uptimeSec: number | null;
  restartCount: number;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastCrashReason: string | null;
  crashHistory: Array<{ ts: string; code: number | null; signal: string | null }>;
  schedule: string | null;
  nextRun: string | null;
  quarantined: boolean;
  extras: Record<string, unknown>;
}

export interface UpgradeResult {
  target: "claude";
  oldVersion: string | null;
  newVersion: string | null;
  restartedUnits: string[];
  log: string;
}

// ── Ops ──

export type Op =
  | { op: "ping" }
  | { op: "status" }
  | { op: "unit-info"; unit: string }
  | { op: "start"; unit: string }
  | { op: "stop"; unit: string }
  | { op: "restart"; unit: string }
  | { op: "logs"; unit: string; tail?: number; follow?: boolean }
  | { op: "upgrade"; target: "claude"; noGatewayRestart?: boolean };

export interface Request {
  id: string;
  body: Op;
}

export interface WireRequest {
  id: string;
  op: Op["op"];
  unit?: string;
  tail?: number;
  follow?: boolean;
  target?: "claude";
  noGatewayRestart?: boolean;
}

export type Response =
  | {
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      id: string;
      ok: false;
      error: string;
      detail?: string;
    };

export interface LogLineFrame {
  id: string;
  stream: "log";
  line: string;
}

// ── Errors ──

export const ERR_UNKNOWN_OP = "unknown_op";
export const ERR_UNKNOWN_UNIT = "unknown_unit";
export const ERR_INVALID_REQUEST = "invalid_request";
export const ERR_UPGRADE_IN_PROGRESS = "upgrade_in_progress";
export const ERR_UPGRADE_FAILED = "upgrade_failed";
export const ERR_UNIT_BUSY = "unit_busy";
export const ERR_INTERNAL = "internal_error";

export class SupervisorUnavailable extends Error {
  constructor(message = "supervisor control socket unavailable") {
    super(message);
    this.name = "SupervisorUnavailable";
  }
}
