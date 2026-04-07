/**
 * Approval System — channel-based confirmation for dangerous operations.
 *
 * When the agent wants to perform a potentially dangerous action
 * (e.g., deleting files, running risky commands), it can use the
 * `request_approval` MCP tool to ask the user for confirmation.
 *
 * The approval request is sent through the channel (WebSocket, Slack, etc.)
 * and the user's response is returned to the agent.
 *
 * Inspired by OpenClaw's exec-approvals system.
 */

import { APPROVAL_TIMEOUT_MS } from "./constants.js";

/** Maximum number of pending approval requests to prevent memory leaks. */
const MAX_PENDING_APPROVALS = 100;

export interface ApprovalRequest {
  id: string;
  action: string;      // What the agent wants to do
  detail?: string;      // Additional context
  risk_level: "low" | "medium" | "high" | "critical";
  requested_at: string;
  status: "pending" | "approved" | "denied" | "timeout";
  resolved_at?: string;
  resolved_by?: string;
}

type ApprovalResolver = (approved: boolean, comment?: string) => void;

const pendingApprovals = new Map<string, { request: ApprovalRequest; resolve: ApprovalResolver }>();

/** Create a new approval request. Returns a promise that resolves when user responds. */
export function createApproval(
  action: string,
  detail?: string,
  riskLevel: "low" | "medium" | "high" | "critical" = "medium",
  timeoutMs = APPROVAL_TIMEOUT_MS,
): { request: ApprovalRequest; promise: Promise<{ approved: boolean; comment?: string }> } {
  const id = crypto.randomUUID().slice(0, 8);
  const request: ApprovalRequest = {
    id,
    action,
    detail,
    risk_level: riskLevel,
    requested_at: new Date().toISOString(),
    status: "pending",
  };

  // Cleanup expired entries before adding new ones
  for (const [key, entry] of pendingApprovals) {
    if (entry.request.status !== "pending") {
      pendingApprovals.delete(key);
    }
  }

  // Enforce max pending limit to prevent memory leaks
  if (pendingApprovals.size >= MAX_PENDING_APPROVALS) {
    // Remove oldest entry
    const oldestKey = pendingApprovals.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = pendingApprovals.get(oldestKey);
      if (oldest) {
        oldest.request.status = "timeout";
        oldest.request.resolved_at = new Date().toISOString();
        oldest.resolve(false, "Evicted: too many pending approvals");
      }
      pendingApprovals.delete(oldestKey);
    }
  }

  const promise = new Promise<{ approved: boolean; comment?: string }>((resolve) => {
    pendingApprovals.set(id, {
      request,
      resolve: (approved, comment) => {
        request.status = approved ? "approved" : "denied";
        request.resolved_at = new Date().toISOString();
        resolve({ approved, comment });
      },
    });

    // Auto-deny after timeout
    setTimeout(() => {
      if (pendingApprovals.has(id)) {
        request.status = "timeout";
        request.resolved_at = new Date().toISOString();
        pendingApprovals.delete(id);
        resolve({ approved: false, comment: "Approval timed out" });
      }
    }, timeoutMs);
  });

  return { request, promise };
}

/** Resolve a pending approval (called from API when user responds). */
export function resolveApproval(id: string, approved: boolean, resolvedBy = "user", comment?: string): boolean {
  const entry = pendingApprovals.get(id);
  if (!entry) return false;

  entry.request.resolved_by = resolvedBy;
  entry.resolve(approved, comment);
  pendingApprovals.delete(id);
  return true;
}

/** List pending approval requests. */
export function listPendingApprovals(): ApprovalRequest[] {
  return Array.from(pendingApprovals.values()).map(e => e.request);
}