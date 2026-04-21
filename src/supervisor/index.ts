#!/usr/bin/env node
/**
 * exoclaw supervisor — PID 1 init for the container.
 *
 * Responsibilities:
 *   1. PID 1 duties — forward SIGTERM/SIGINT/SIGHUP, reap zombies via libuv.
 *   2. Spawn and supervise units (gateway, remote-control, custom services).
 *   3. Expose a Unix control socket for exoclawctl and the gateway.
 *   4. Fire scheduled services on their cron schedules.
 *   5. Run upgrade-claude on demand.
 */

import { spawnSync } from "child_process";
import { ControlServer } from "./control.js";
import { log } from "./log.js";
import { loadUnitSpecs } from "./units.js";
import { Unit } from "./unit.js";
import { UpgradeOrchestrator } from "./upgrade.js";

const VERSION = "0.1.0";
const STARTED_AT = Date.now();
const SCHEDULE_TICK_MS = 30_000; // evaluate schedules every 30s

async function main(): Promise<void> {
  log("supervisor", "info", `exoclaw supervisor ${VERSION} starting (pid ${process.pid})`);
  installSafetyNets();
  probeSudo();

  const specs = loadUnitSpecs();
  const units = new Map<string, Unit>();
  for (const spec of specs) {
    units.set(spec.name, new Unit(spec));
  }
  log(
    "supervisor",
    "info",
    `loaded ${units.size} units: ${Array.from(units.keys()).join(", ")}`
  );

  const upgrade = new UpgradeOrchestrator(units);
  const control = new ControlServer({
    units,
    upgrade,
    version: VERSION,
    startedAt: STARTED_AT,
  });

  try {
    await control.start();
  } catch (err) {
    log("supervisor", "error", `failed to start control socket: ${(err as Error).message}`);
    process.exit(1);
  }

  installSignalHandlers(units, control);

  // Start units in startOrder (already sorted by loadUnitSpecs)
  for (const unit of units.values()) {
    if (unit.spec.autoStart) {
      unit.start().catch((err) => {
        log(
          "supervisor",
          "error",
          `unit ${unit.spec.name}: initial start failed: ${(err as Error).message}`
        );
      });
    }
  }

  // Schedule tick
  const scheduleTimer = setInterval(() => {
    const now = new Date();
    for (const unit of units.values()) {
      unit.maybeTickSchedule(now);
    }
  }, SCHEDULE_TICK_MS);
  scheduleTimer.unref();

  log("supervisor", "info", "supervisor ready");
}

function installSafetyNets(): void {
  // PID 1 must not die on unhandled rejections — log loudly and continue.
  process.on("unhandledRejection", (reason) => {
    log(
      "supervisor",
      "error",
      `unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`
    );
  });
  process.on("uncaughtException", (err) => {
    log("supervisor", "error", `uncaught exception: ${err.stack ?? err.message}`);
  });
}

function probeSudo(): void {
  try {
    const out = spawnSync("sudo", ["-n", "true"], { timeout: 3000 });
    if (out.status !== 0) {
      log("supervisor", "warn", "sudo probe failed — upgrade-claude will not work");
    }
  } catch {
    log("supervisor", "warn", "sudo probe threw — upgrade-claude may not work");
  }
}

function installSignalHandlers(units: Map<string, Unit>, control: ControlServer): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("supervisor", "info", `received ${signal}, shutting down units`);
    await control.stop();
    // Stop units in reverse startOrder
    const ordered = Array.from(units.values()).sort(
      (a, b) => b.spec.startOrder - a.spec.startOrder
    );
    await Promise.allSettled(ordered.map((u) => u.stop()));
    log("supervisor", "info", "all units stopped, exiting");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => {
    log("supervisor", "info", "SIGHUP received (reload not implemented; send SIGTERM to restart)");
  });
}

main().catch((err) => {
  log("supervisor", "error", `fatal: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
