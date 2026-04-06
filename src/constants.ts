/**
 * Shared constants — centralizes magic numbers and strings used across modules.
 */

/** tmux session name for the persistent Claude Code session. */
export const TMUX_SESSION = "claude";

/** Port for the MCP channel server (stdio bridge over HTTP). */
export const CHANNEL_PORT = 3200;

/** Polling interval (ms) for tmux capture-pane and session file watchers. */
export const POLL_INTERVAL_MS = 200;

/**
 * Consecutive unchanged polls needed to consider a tmux response complete.
 * At POLL_INTERVAL_MS = 200ms, 15 polls = ~3 seconds of stability.
 */
export const STABLE_THRESHOLD = 15;

/**
 * Claude Code project directory suffix for the agent workspace.
 * Used to locate JSONL session files under ~/.claude/projects/.
 */
export const PROJECT_DIR_SUFFIX = "-home-agent-workspace";

/** Default approval timeout (ms) — auto-deny after 5 minutes. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** Rate limiter sliding window duration (ms). */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Default session/message retention period (days). */
export const RETENTION_DAYS = 90;

/** Milliseconds per day — used for date arithmetic. */
export const MS_PER_DAY = 86_400_000;
