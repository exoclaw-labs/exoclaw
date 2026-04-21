/**
 * Upgrade orchestrator for the supervisor.
 *
 * Currently supports one target: "claude" — runs the sudo-eligible wrapper
 * script /app/scripts/upgrade-claude.sh to bump @anthropic-ai/claude-code,
 * then restarts the gateway (and remote-control if it was running).
 */

import { spawn, spawnSync } from "child_process";
import { log } from "./log.js";
import type { Unit } from "./unit.js";
import {
  ERR_UPGRADE_FAILED,
  ERR_UPGRADE_IN_PROGRESS,
  type UpgradeResult,
} from "./protocol.js";

const UPGRADE_SCRIPT = "/app/scripts/upgrade-claude.sh";
const UPGRADE_TIMEOUT_MS = 120_000;
const CLAUDE_BIN = process.env.CLAUDE_BIN || "/usr/local/bin/claude";

export type UpgradeOutcome =
  | { ok: true; result: UpgradeResult }
  | { ok: false; error: string; detail: string };

export class UpgradeOrchestrator {
  private inProgress = false;

  constructor(private units: Map<string, Unit>) {}

  async upgradeClaude(opts: { noGatewayRestart?: boolean } = {}): Promise<UpgradeOutcome> {
    if (this.inProgress) {
      return { ok: false, error: ERR_UPGRADE_IN_PROGRESS, detail: "another upgrade is running" };
    }
    this.inProgress = true;
    try {
      return await this.runUpgrade(opts);
    } finally {
      this.inProgress = false;
    }
  }

  private async runUpgrade(opts: { noGatewayRestart?: boolean }): Promise<UpgradeOutcome> {
    const gateway = this.units.get("gateway");
    const remote = this.units.get("remote-control");

    const oldVersion = readVersion();
    log("supervisor", "info", `upgrade-claude: old version = ${oldVersion ?? "(unknown)"}`);

    const remoteWasRunning = remote?.state === "running" || remote?.state === "starting";
    if (remote && remoteWasRunning) {
      log("supervisor", "info", "upgrade-claude: stopping remote-control before upgrade");
      await remote.stop();
    }

    const scriptResult = await runScript();
    if (!scriptResult.ok) {
      // Restore remote-control to pre-state
      if (remote && remoteWasRunning) {
        remote.start().catch(() => {
          /* intentional */
        });
      }
      return { ok: false, error: ERR_UPGRADE_FAILED, detail: scriptResult.detail };
    }

    const newVersion = readVersion();
    log("supervisor", "info", `upgrade-claude: new version = ${newVersion ?? "(unknown)"}`);

    const restarted: string[] = [];
    if (gateway && !opts.noGatewayRestart) {
      log("supervisor", "info", "upgrade-claude: restarting gateway");
      await gateway.restart();
      restarted.push("gateway");
    }
    if (remote && remoteWasRunning) {
      log("supervisor", "info", "upgrade-claude: restarting remote-control");
      await remote.start();
      restarted.push("remote-control");
    }

    return {
      ok: true,
      result: {
        target: "claude",
        oldVersion,
        newVersion,
        restartedUnits: restarted,
        log: scriptResult.log,
      },
    };
  }
}

function readVersion(): string | null {
  try {
    const out = spawnSync(CLAUDE_BIN, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (out.status !== 0) return null;
    return out.stdout.trim();
  } catch {
    return null;
  }
}

function runScript(): Promise<{ ok: true; log: string } | { ok: false; detail: string; log?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("sudo", ["-n", UPGRADE_SCRIPT], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* intentional */
      }
    }, UPGRADE_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      out += text;
      // Forward to supervisor stdout with a synthetic tag for live visibility
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        process.stderr.write(`${new Date().toISOString()} [upgrade-claude] ${line}\n`);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      err += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        process.stderr.write(`${new Date().toISOString()} [upgrade-claude] ${line}\n`);
      }
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `spawn sudo failed: ${e.message}` });
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, detail: `upgrade-claude.sh timed out after ${UPGRADE_TIMEOUT_MS}ms`, log: out + err });
        return;
      }
      if (code === 0) {
        resolve({ ok: true, log: out });
      } else {
        resolve({
          ok: false,
          detail: `upgrade-claude.sh exited with code ${code}: ${err || out}`,
          log: out + err,
        });
      }
    });
  });
}
