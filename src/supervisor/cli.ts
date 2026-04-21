#!/usr/bin/env node
/**
 * exoclawctl — command-line interface to the exoclaw supervisor.
 *
 * Connects to the supervisor's Unix control socket and issues commands.
 * Installed as /usr/local/bin/exoclawctl via a shell shim inside the container.
 */

import { SupervisorClient } from "./client.js";
import { SupervisorUnavailable, type UnitStatus } from "./protocol.js";

const USAGE = `exoclawctl — exoclaw service supervisor CLI

Usage:
  exoclawctl ping
  exoclawctl status [unit]
  exoclawctl start <unit>
  exoclawctl stop <unit>
  exoclawctl restart <unit>
  exoclawctl logs <unit> [-n N] [-f]
  exoclawctl upgrade claude [--no-gateway-restart]

Options:
  --json          Emit machine-readable JSON instead of a table
  -n, --lines N   Number of log lines to tail (default 200)
  -f, --follow    Stream new log lines until interrupted
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const jsonIdx = argv.indexOf("--json");
  const wantJson = jsonIdx >= 0;
  if (wantJson) argv.splice(jsonIdx, 1);

  const client = new SupervisorClient();
  const cmd = argv[0];

  try {
    switch (cmd) {
      case "ping":
        await cmdPing(client, wantJson);
        return;
      case "status":
        await cmdStatus(client, argv[1], wantJson);
        return;
      case "start":
        await cmdLifecycle(client, "start", requireUnit(argv[1]), wantJson);
        return;
      case "stop":
        await cmdLifecycle(client, "stop", requireUnit(argv[1]), wantJson);
        return;
      case "restart":
        await cmdLifecycle(client, "restart", requireUnit(argv[1]), wantJson);
        return;
      case "logs":
        await cmdLogs(client, argv.slice(1));
        return;
      case "upgrade":
        await cmdUpgrade(client, argv.slice(1), wantJson);
        return;
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
        process.exit(2);
    }
  } catch (err) {
    if (err instanceof SupervisorUnavailable) {
      process.stderr.write(`error: supervisor is not running (${err.message})\n`);
      process.exit(3);
    }
    const msg = (err as Error).message || String(err);
    const detail = (err as Error & { detail?: string }).detail;
    process.stderr.write(`error: ${msg}${detail ? ` — ${detail}` : ""}\n`);
    process.exit(1);
  }
}

function requireUnit(name: string | undefined): string {
  if (!name) {
    process.stderr.write("error: unit name required\n");
    process.exit(2);
  }
  return name;
}

// ── Commands ──

async function cmdPing(client: SupervisorClient, json: boolean): Promise<void> {
  const result = await client.ping();
  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    const mins = Math.floor(result.uptimeSec / 60);
    const secs = result.uptimeSec % 60;
    process.stdout.write(`supervisor up (pid ${result.pid}, uptime ${mins}m${secs}s, version ${result.version})\n`);
  }
}

async function cmdStatus(
  client: SupervisorClient,
  unitName: string | undefined,
  json: boolean
): Promise<void> {
  if (unitName) {
    const info = await client.unitInfo(unitName);
    if (json) {
      process.stdout.write(JSON.stringify(info, null, 2) + "\n");
    } else {
      printUnitDetail(info);
    }
    return;
  }
  const { units } = await client.status();
  if (json) {
    process.stdout.write(JSON.stringify(units, null, 2) + "\n");
  } else {
    printUnitTable(units);
  }
}

async function cmdLifecycle(
  client: SupervisorClient,
  op: "start" | "stop" | "restart",
  unit: string,
  json: boolean
): Promise<void> {
  const status =
    op === "start" ? await client.start(unit) : op === "stop" ? await client.stop(unit) : await client.restart(unit);
  if (json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  } else {
    process.stdout.write(`${unit}: ${status.state}${status.pid ? ` (pid ${status.pid})` : ""}\n`);
  }
}

async function cmdLogs(client: SupervisorClient, args: string[]): Promise<void> {
  let unit: string | null = null;
  let tail = 200;
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-f" || a === "--follow") follow = true;
    else if (a === "-n" || a === "--lines") tail = parseInt(args[++i] || "200", 10);
    else if (!unit) unit = a;
  }
  if (!unit) {
    process.stderr.write("error: unit name required\n");
    process.exit(2);
  }

  if (follow) {
    const stop = await client.followLogs(unit, (line) => {
      process.stdout.write(line + "\n");
    }, tail);
    process.on("SIGINT", () => {
      stop();
      process.exit(0);
    });
    // Wait indefinitely
    await new Promise(() => {});
    return;
  }

  const lines = await client.logs(unit, tail);
  for (const line of lines) {
    process.stdout.write(line + "\n");
  }
}

async function cmdUpgrade(client: SupervisorClient, args: string[], json: boolean): Promise<void> {
  const target = args[0];
  if (target !== "claude") {
    process.stderr.write("error: only 'upgrade claude' is supported\n");
    process.exit(2);
  }
  const noGatewayRestart = args.includes("--no-gateway-restart");
  process.stdout.write("==> upgrading claude (this may take a minute)...\n");
  const result = await client.upgradeClaude({ noGatewayRestart });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(`==> old: ${result.oldVersion ?? "?"}\n`);
  process.stdout.write(`==> new: ${result.newVersion ?? "?"}\n`);
  if (result.restartedUnits.length > 0) {
    process.stdout.write(`==> restarted: ${result.restartedUnits.join(", ")}\n`);
  }
  process.stdout.write("==> done\n");
}

// ── Output helpers ──

function formatUptime(sec: number | null): string {
  if (sec === null) return "-";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h${m}m`;
}

function infoText(u: UnitStatus): string {
  const parts: string[] = [];
  if (u.quarantined) parts.push("QUARANTINED");
  if (u.extras.remoteControlUrl) parts.push(String(u.extras.remoteControlUrl));
  if (u.schedule) parts.push(`schedule=${u.schedule}`);
  if (u.nextRun) parts.push(`next=${u.nextRun}`);
  if (u.lastCrashReason && u.state === "failed") parts.push(`reason=${u.lastCrashReason}`);
  return parts.join(" ");
}

function printUnitTable(units: UnitStatus[]): void {
  const rows = units.map((u) => [
    u.name,
    u.state,
    u.pid === null ? "-" : String(u.pid),
    formatUptime(u.uptimeSec),
    String(u.restartCount),
    infoText(u),
  ]);
  const headers = ["UNIT", "STATE", "PID", "UPTIME", "RESTARTS", "INFO"];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length))
  );
  const writeRow = (cells: string[]) => {
    const line = cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
    process.stdout.write(line.trimEnd() + "\n");
  };
  writeRow(headers);
  for (const row of rows) writeRow(row);
}

function printUnitDetail(u: UnitStatus): void {
  process.stdout.write(`Unit:         ${u.name}\n`);
  process.stdout.write(`Description:  ${u.description}\n`);
  process.stdout.write(`State:        ${u.state}${u.quarantined ? " (quarantined)" : ""}\n`);
  process.stdout.write(`PID:          ${u.pid ?? "-"}${u.pgid ? ` (pgid ${u.pgid})` : ""}\n`);
  process.stdout.write(`Started:      ${u.startedAt ?? "-"}${u.uptimeSec !== null ? `  (uptime ${formatUptime(u.uptimeSec)})` : ""}\n`);
  process.stdout.write(`Restarts:     ${u.restartCount}\n`);
  if (u.lastCrashReason) process.stdout.write(`Last crash:   ${u.lastCrashReason}\n`);
  if (u.schedule) process.stdout.write(`Schedule:     ${u.schedule}\n`);
  if (u.nextRun) process.stdout.write(`Next run:     ${u.nextRun}\n`);
  if (Object.keys(u.extras).length > 0) {
    process.stdout.write(`Extras:\n`);
    for (const [k, v] of Object.entries(u.extras)) {
      process.stdout.write(`  ${k}: ${String(v)}\n`);
    }
  }
  if (u.crashHistory.length > 0) {
    process.stdout.write(`Crash history:\n`);
    for (const c of u.crashHistory) {
      process.stdout.write(`  ${c.ts}  code=${c.code ?? "?"}  signal=${c.signal ?? "none"}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
