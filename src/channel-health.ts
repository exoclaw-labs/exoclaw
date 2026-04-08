/**
 * Channel Health Monitor — tracks the health of each enabled channel adapter.
 *
 * Each channel reports its status (connected, disconnected, error) via
 * reportHealth(). The monitor exposes aggregate status for the /api/status
 * endpoint and broadcasts state changes to SSE clients.
 *
 * Inspired by OpenClaw's channel-health-policy.ts.
 */

export type ChannelStatus = "connected" | "disconnected" | "error" | "disabled";

export interface ChannelHealth {
  name: string;
  status: ChannelStatus;
  lastSeen: string | null;
  lastError: string | null;
  messageCount: number;
}

type HealthChangeListener = (channel: string, health: ChannelHealth) => void;

export class ChannelHealthMonitor {
  private channels = new Map<string, ChannelHealth>();
  private listeners: HealthChangeListener[] = [];

  /** Register a channel as enabled (call at startup). */
  register(name: string): void {
    this.channels.set(name, {
      name,
      status: "disconnected",
      lastSeen: null,
      lastError: null,
      messageCount: 0,
    });
  }

  /** Report that a channel is connected and working. */
  reportConnected(name: string): void {
    const ch = this.channels.get(name);
    if (!ch) return;
    const prev = ch.status;
    ch.status = "connected";
    ch.lastSeen = new Date().toISOString();
    if (prev !== "connected") this.notify(name, ch);
  }

  /** Report that a channel processed a message successfully. */
  reportMessage(name: string): void {
    const ch = this.channels.get(name);
    if (!ch) return;
    ch.status = "connected";
    ch.lastSeen = new Date().toISOString();
    ch.messageCount++;
  }

  /** Report that a channel encountered an error. */
  reportError(name: string, error: string): void {
    const ch = this.channels.get(name);
    if (!ch) return;
    const prev = ch.status;
    ch.status = "error";
    ch.lastError = error;
    if (prev !== "error") this.notify(name, ch);
  }

  /** Report that a channel has disconnected. */
  reportDisconnected(name: string): void {
    const ch = this.channels.get(name);
    if (!ch) return;
    const prev = ch.status;
    ch.status = "disconnected";
    if (prev !== "disconnected") this.notify(name, ch);
  }

  /** Subscribe to health state changes. */
  onChange(listener: HealthChangeListener): void {
    this.listeners.push(listener);
  }

  /** Get health status for all registered channels. */
  getAll(): ChannelHealth[] {
    return Array.from(this.channels.values());
  }

  /** Get health status for a specific channel. */
  get(name: string): ChannelHealth | undefined {
    return this.channels.get(name);
  }

  /** Check if any channel is in error state. */
  hasErrors(): boolean {
    return Array.from(this.channels.values()).some(ch => ch.status === "error");
  }

  private notify(name: string, health: ChannelHealth): void {
    for (const listener of this.listeners) {
      try { listener(name, health); } catch { /* intentional */ }
    }
  }
}
