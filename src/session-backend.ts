/**
 * Provider-agnostic session backend interface.
 *
 * Each LLM provider implements this interface. The gateway only references
 * SessionBackend — never a provider class directly.
 */

// Re-export shared types so consumers can import from one place
export type { SessionConfig, McpServerDef, ClarifyHandler, ApprovalHandler } from "./claude-sdk.js";
import type { SessionConfig, McpServerDef, ClarifyHandler, ApprovalHandler } from "./claude-sdk.js";

export type McpServerMap = Record<string, McpServerDef>;

export interface SessionBackend {
  start(): void;
  close(): void;
  send(prompt: string): AsyncGenerator<{ type: string; content: string }>;
  updateConfig(config: SessionConfig, mcpServers?: McpServerMap): void;
  restart(): void;
  freshStart(): void;
  switchSession(sessionId: string): void;

  mcpServers: Record<string, McpServerDef>;

  onTurnComplete: (() => void) | null;
  onUsage: ((data: {
    sessionId: string | null;
    costUsd: number;
    usage: Record<string, number>;
    modelUsage: Record<string, any>;
    durationMs: number;
    numTurns: number;
  }) => void) | null;
  onClarify: ClarifyHandler | null;
  onApproval: ApprovalHandler | null;

  set name(n: string);

  readonly alive: boolean;
  readonly busy: boolean;
  readonly usingChannel: boolean;
  readonly activeSessionId: string | null;
}

import { Claude } from "./claude-sdk.js";

export function createSessionBackend(
  config: SessionConfig,
  mcpServers: McpServerMap = {},
): SessionBackend {
  switch (config.provider) {
    case "claude":
      return new Claude(config, mcpServers);
    default:
      throw new Error(`Unknown session provider: ${config.provider}`);
  }
}
