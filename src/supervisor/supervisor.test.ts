/**
 * Tests for the supervisor: Unit state machine, protocol, cron parser.
 *
 * These tests exercise the pieces in isolation without spinning up the
 * full supervisor. Unit tests use `sleep`/`node -e` fake commands so they
 * run anywhere Node runs.
 */

import { describe, it, expect } from "vitest";
import { parseSchedule } from "./cron-expr.js";
import { Unit, type UnitSpec } from "./unit.js";

// ── Cron expression parser ──

describe("parseSchedule", () => {
  it("parses a 5-field cron", () => {
    const s = parseSchedule("*/15 * * * *");
    expect(s.isOneShot).toBe(false);
    // :00, :15, :30, :45 match; :07 does not.
    expect(s.matches(new Date("2026-04-14T10:00:00Z"))).toBe(true);
    expect(s.matches(new Date("2026-04-14T10:15:00Z"))).toBe(true);
    expect(s.matches(new Date("2026-04-14T10:07:00Z"))).toBe(false);
  });

  it("parses a daily cron", () => {
    // parser uses local time (getHours/getMinutes) — mirror that in the test
    const s = parseSchedule("0 3 * * *");
    const atThree = new Date(2026, 3, 14, 3, 0, 0); // local 03:00
    const atFour = new Date(2026, 3, 14, 4, 0, 0);
    expect(s.matches(atThree)).toBe(true);
    expect(s.matches(atFour)).toBe(false);
  });

  it("parses a one-shot ISO datetime", () => {
    const target = new Date(Date.now() + 60_000);
    const s = parseSchedule(target.toISOString());
    expect(s.isOneShot).toBe(true);
    // Not yet
    expect(s.matches(new Date())).toBe(false);
    // At target time
    expect(s.matches(new Date(target.getTime() + 1000))).toBe(true);
    // Subsequent checks don't re-fire
    expect(s.matches(new Date(target.getTime() + 5000))).toBe(false);
  });

  it("parses a relative one-shot", () => {
    const s = parseSchedule("now + 1m");
    expect(s.isOneShot).toBe(true);
  });

  it("throws on malformed cron", () => {
    expect(() => parseSchedule("not valid")).toThrow();
    expect(() => parseSchedule("* * * *")).toThrow();
  });

  it("nextRun advances for recurring", () => {
    const s = parseSchedule("0 * * * *");
    const from = new Date(2026, 3, 14, 10, 15, 0);
    const next = s.nextRun(from);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(11);
    expect(next!.getMinutes()).toBe(0);
  });

});

// ── Unit state machine ──

/**
 * Poll unit.state until it reaches one of the expected states or timeout.
 * Avoids flaky fixed-delay assertions under CPU load in parallel test workers.
 */
async function waitForState(unit: Unit, expected: string[], timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (expected.includes(unit.state)) return unit.state;
    await new Promise((r) => setTimeout(r, 20));
  }
  return unit.state;
}

function makeSpec(overrides: Partial<UnitSpec> = {}): UnitSpec {
  return {
    name: "test-unit",
    description: "test",
    // sh is cheaper to spawn than node and avoids flaky boot-time races
    command: "/bin/sh",
    args: ["-c", "sleep 10"],
    restart: "no",
    stopGraceMs: 2000,
    autoStart: false,
    startOrder: 0,
    ...overrides,
  };
}

describe("Unit", () => {
  it("starts and stops cleanly with default grace readiness", async () => {
    const unit = new Unit(makeSpec());
    expect(unit.state).toBe("stopped");
    await unit.start();
    expect(unit.state).toBe("running");
    expect(unit.pid).not.toBeNull();
    await unit.stop();
    expect(unit.state).toBe("stopped");
    expect(unit.pid).toBeNull();
  });

  it("restart: no does not restart on clean exit", async () => {
    const unit = new Unit(
      makeSpec({
        args: ["-c", "exit 0"],
        restart: "no",
      })
    );
    await unit.start();
    const state = await waitForState(unit, ["stopped", "failed"]);
    expect(state).toBe("stopped");
  });

  it("stdout-regex readiness matches", async () => {
    const unit = new Unit(
      makeSpec({
        args: ["-c", "echo 'ready: boot complete'; sleep 10"],
        readiness: { type: "stdout-regex", pattern: /ready: boot complete/, timeoutMs: 5000 },
      })
    );
    await unit.start();
    const state = await waitForState(unit, ["running"]);
    expect(state).toBe("running");
    await unit.stop();
  });

  it("ring buffer captures stdout lines", async () => {
    const unit = new Unit(
      makeSpec({
        args: ["-c", "echo line-1; echo line-2; echo line-3; sleep 10"],
      })
    );
    await unit.start();
    // Wait until all 3 lines are in the buffer, or fail after 2s
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const lines = unit.tailLogs(10);
      if (lines.includes("line-1") && lines.includes("line-2") && lines.includes("line-3")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const lines = unit.tailLogs(10);
    expect(lines).toContain("line-1");
    expect(lines).toContain("line-2");
    expect(lines).toContain("line-3");
    await unit.stop();
  });

  it("toStatus reports schedule and nextRun when set", async () => {
    const unit = new Unit(
      makeSpec({
        schedule: "0 * * * *",
      })
    );
    const status = unit.toStatus();
    expect(status.schedule).toBe("0 * * * *");
    expect(status.nextRun).not.toBeNull();
  });
});
