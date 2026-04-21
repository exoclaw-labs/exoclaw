/**
 * Unit definitions for the exoclaw supervisor.
 *
 * Built-in units (`gateway`, `remote-control`) are hardcoded and NOT user-
 * configurable. Custom user-defined units are loaded from config.services
 * in ~/.exoclaw/config.yml.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { log } from "./log.js";
import type { Readiness, UnitSpec } from "./unit.js";
import type { RestartPolicy } from "./protocol.js";

export const BUILTIN_UNIT_NAMES = new Set(["gateway", "remote-control"]);

const HOME = process.env.HOME || "/home/agent";
const CONFIG_PATH = join(HOME, ".exoclaw", "config.yml");
const LEGACY_CONFIG_PATH = join(HOME, ".exoclaw", "config.json");
const WORKSPACE = join(HOME, "workspace");
const NODE_BIN = "/usr/local/bin/node";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "/usr/local/bin/claude";

export function loadUnitSpecs(): UnitSpec[] {
  const config = readConfig();
  const gatewayName = typeof config.name === "string" ? config.name : "exoclaw";
  const sessionCfg = (config.session || {}) as Record<string, any>;
  const claudeProviderCfg = (sessionCfg.providers?.claude || {}) as Record<string, unknown>;
  const wantsRemoteControl =
    process.env.ENABLE_REMOTE_CONTROL === "true" || claudeProviderCfg.remoteControl === true;

  const specs: UnitSpec[] = [
    buildGatewaySpec(),
    buildRemoteControlSpec(gatewayName, wantsRemoteControl),
  ];

  const customBlob = config.services;
  if (customBlob && typeof customBlob === "object") {
    for (const [name, raw] of Object.entries(customBlob as Record<string, unknown>)) {
      if (BUILTIN_UNIT_NAMES.has(name)) {
        log("supervisor", "warn", `config.services["${name}"] is a reserved built-in name; skipping`);
        continue;
      }
      const spec = validateCustomSpec(name, raw);
      if (spec) specs.push(spec);
    }
  }

  return specs.sort((a, b) => a.startOrder - b.startOrder);
}

function readConfig(): Record<string, any> {
  try {
    if (existsSync(CONFIG_PATH)) {
      return parse(readFileSync(CONFIG_PATH, "utf-8")) || {};
    }
    if (existsSync(LEGACY_CONFIG_PATH)) {
      return JSON.parse(readFileSync(LEGACY_CONFIG_PATH, "utf-8"));
    }
  } catch { /* intentional */ }
  return {};
}

// ── Built-in unit specs ──

function buildGatewaySpec(): UnitSpec {
  return {
    name: "gateway",
    description: "exoclaw HTTP gateway (Hono, Claude SDK, channels)",
    command: NODE_BIN,
    args: ["/app/dist/index.js"],
    cwd: WORKSPACE,
    restart: "always",
    stopGraceMs: 15_000,
    startTimeoutMs: 45_000,
    readiness: {
      type: "http",
      url: "http://127.0.0.1:8080/health",
      timeoutMs: 45_000,
      intervalMs: 500,
    },
    autoStart: true,
    startOrder: 0,
  };
}

function buildRemoteControlSpec(gatewayName: string, autoStart: boolean): UnitSpec {
  return {
    name: "remote-control",
    description: "claude remote-control relay (optional)",
    command: CLAUDE_BIN,
    args: ["remote-control", "--name", gatewayName],
    cwd: WORKSPACE,
    restart: "on-failure",
    stopGraceMs: 5_000,
    startTimeoutMs: 20_000,
    readiness: {
      type: "stdout-regex",
      pattern: /environment=(env_[a-zA-Z0-9]+)|https:\/\/claude\.ai\/code\/remote-control/,
      timeoutMs: 20_000,
    },
    stdinScript: "y\n",
    autoStart,
    startOrder: 10,
    extrasFromOutput: (chunk, current) => {
      const next = { ...current };
      const envMatch = chunk.match(/environment=(env_[a-zA-Z0-9]+)/);
      if (envMatch) {
        next.remoteControlUrl = `https://claude.ai/code?environment=${envMatch[1]}`;
      }
      const urlMatch = chunk.match(/(https:\/\/claude\.ai\/code\/remote-control[^\s]*)/);
      if (urlMatch) {
        next.remoteControlUrl = urlMatch[1];
      }
      return next;
    },
  };
}

// ── Custom unit validation ──

function validateCustomSpec(name: string, raw: unknown): UnitSpec | null {
  if (!raw || typeof raw !== "object") {
    log("supervisor", "warn", `config.services["${name}"]: not an object; skipping`);
    return null;
  }
  const r = raw as Record<string, unknown>;

  const command = typeof r.command === "string" ? r.command : null;
  if (!command) {
    log("supervisor", "warn", `config.services["${name}"]: missing "command"; skipping`);
    return null;
  }
  const args = Array.isArray(r.args) && r.args.every((x) => typeof x === "string") ? (r.args as string[]) : [];
  const cwd = typeof r.cwd === "string" ? r.cwd : WORKSPACE;
  const env =
    r.env && typeof r.env === "object"
      ? Object.fromEntries(
          Object.entries(r.env as Record<string, unknown>).filter(
            ([, v]) => typeof v === "string"
          ) as Array<[string, string]>
        )
      : undefined;

  const restart: RestartPolicy =
    r.restart === "always" || r.restart === "on-failure" || r.restart === "no"
      ? (r.restart as RestartPolicy)
      : "on-failure";
  const autoStart = r.autoStart === true;
  const stopGraceMs = typeof r.stopGraceMs === "number" ? r.stopGraceMs : 5_000;
  const startTimeoutMs = typeof r.startTimeoutMs === "number" ? r.startTimeoutMs : undefined;
  const schedule = typeof r.schedule === "string" ? r.schedule : undefined;
  const description = typeof r.description === "string" ? r.description : `custom service ${name}`;

  let readiness: Readiness | undefined;
  if (r.readiness && typeof r.readiness === "object") {
    const p = r.readiness as Record<string, unknown>;
    if (p.type === "http" && typeof p.url === "string") {
      readiness = {
        type: "http",
        url: p.url,
        timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : 10_000,
        intervalMs: typeof p.intervalMs === "number" ? p.intervalMs : 500,
      };
    } else if (p.type === "stdout-regex" && typeof p.pattern === "string") {
      readiness = {
        type: "stdout-regex",
        pattern: p.pattern,
        timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : 10_000,
      };
    }
  }

  return {
    name,
    description,
    command,
    args,
    cwd,
    env,
    restart,
    stopGraceMs,
    startTimeoutMs,
    readiness,
    autoStart,
    startOrder: 100,
    schedule,
  };
}
