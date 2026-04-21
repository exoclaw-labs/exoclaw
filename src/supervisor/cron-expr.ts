/**
 * Minimal standalone cron expression parser for the supervisor.
 *
 * Ported from src/cron.ts to keep the supervisor dependency-free of gateway code.
 * Supports:
 *   - 5-field cron: "min hour dom month dow"
 *   - One-shot ISO datetime: "2026-05-01T03:00:00Z"
 *   - Relative one-shot:     "now + 30m" (s|m|h|d)
 */

export interface ParsedSchedule {
  matches: (date: Date) => boolean;
  isOneShot: boolean;
  nextRun: (from: Date) => Date | null;
}

export function parseSchedule(expr: string): ParsedSchedule {
  const trimmed = expr.trim();

  // ── One-shot forms ──
  if (trimmed.match(/^\d{4}-\d{2}-\d{2}/) || trimmed.startsWith("now")) {
    let targetTime: number;
    if (trimmed.startsWith("now")) {
      const match = trimmed.match(/now\s*\+\s*(\d+)\s*(s|m|h|d)/);
      if (!match) throw new Error(`Invalid relative time: ${expr}`);
      const [, amount, unit] = match;
      const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
      targetTime = Date.now() + parseInt(amount, 10) * ms;
    } else {
      targetTime = new Date(trimmed).getTime();
      if (isNaN(targetTime)) throw new Error(`Invalid datetime: ${expr}`);
    }
    let fired = false;
    return {
      isOneShot: true,
      matches: (date: Date) => {
        if (fired) return false;
        if (date.getTime() >= targetTime) {
          fired = true;
          return true;
        }
        return false;
      },
      nextRun: (_from: Date) => (fired ? null : new Date(targetTime)),
    };
  }

  // ── Standard 5-field cron ──
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression (need 5 fields): ${expr}`);
  }

  const parsers = parts.map((part, i) => {
    const max = [59, 23, 31, 12, 6][i]!;
    const min = i === 2 ? 1 : 0;
    return parseCronField(part, min, max);
  });

  const matches = (date: Date) => {
    const values = [
      date.getMinutes(),
      date.getHours(),
      date.getDate(),
      date.getMonth() + 1,
      date.getDay(),
    ];
    return parsers.every((allowed, i) => allowed.has(values[i]!));
  };

  // Compute the next run time by scanning forward minute by minute.
  // Bounded at 366 days; recurring expressions should hit much sooner.
  const nextRun = (from: Date): Date | null => {
    const d = new Date(from.getTime());
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    const limit = 366 * 24 * 60;
    for (let i = 0; i < limit; i++) {
      if (matches(d)) return new Date(d.getTime());
      d.setMinutes(d.getMinutes() + 1);
    }
    return null;
  };

  return { isOneShot: false, matches, nextRun };
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr!, 10);
      const start = range === "*" ? min : parseInt(range!, 10);
      for (let i = start; i <= max; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let i = a!; i <= b!; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }
  return values;
}
