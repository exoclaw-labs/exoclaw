/**
 * Rate Limiter — sliding window per-IP rate limiting for the gateway.
 *
 * Inspired by zeroclaw's rate limiting (src/gateway/auth_rate_limit.rs).
 */

import { RATE_LIMIT_WINDOW_MS } from "./constants.js";

export interface RateLimitConfig {
  enabled: boolean;
  maxRequestsPerMinute: number;
  maxTrackedIPs: number;
}

interface WindowEntry {
  timestamps: number[];
}

export class RateLimiter {
  private config: RateLimitConfig;
  private windows = new Map<string, WindowEntry>();
  private sweepHandle: ReturnType<typeof setInterval> | null = null;

  constructor(config: RateLimitConfig) {
    this.config = config;

    if (config.enabled) {
      // Sweep stale entries every 5 minutes
      this.sweepHandle = setInterval(() => this.sweep(), 5 * 60_000);
    }
  }

  /** Returns true if the request should be allowed, false if rate-limited. */
  allow(ip: string): boolean {
    if (!this.config.enabled) return true;

    const now = Date.now();
    const windowMs = RATE_LIMIT_WINDOW_MS;
    const cutoff = now - windowMs;

    let entry = this.windows.get(ip);
    if (!entry) {
      // Enforce max tracked IPs
      if (this.windows.size >= this.config.maxTrackedIPs) {
        this.sweep();
        if (this.windows.size >= this.config.maxTrackedIPs) {
          return true; // Fail open if we can't track
        }
      }
      entry = { timestamps: [] };
      this.windows.set(ip, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);

    if (entry.timestamps.length >= this.config.maxRequestsPerMinute) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /** How many requests remain in the current window for this IP. */
  remaining(ip: string): number {
    if (!this.config.enabled) return this.config.maxRequestsPerMinute;

    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    const entry = this.windows.get(ip);
    if (!entry) return this.config.maxRequestsPerMinute;

    const recent = entry.timestamps.filter(t => t > cutoff).length;
    return Math.max(0, this.config.maxRequestsPerMinute - recent);
  }

  private sweep(): void {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    for (const [ip, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter(t => t > cutoff);
      if (entry.timestamps.length === 0) {
        this.windows.delete(ip);
      }
    }
  }

  stop(): void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
  }
}
