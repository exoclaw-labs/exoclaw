#!/bin/bash
# tailscale-funnel.sh — start Tailscale Funnel inside a container.
#
# Manages the full lifecycle: starts tailscaled (if not running),
# authenticates via auth key, and runs `tailscale funnel` in the foreground.
#
# Env vars:
#   TS_AUTHKEY    — Tailscale auth key (required for first auth)
#   TUNNEL_TOKEN  — Fallback for TS_AUTHKEY (set by TunnelManager from config)
#   TS_HOSTNAME   — Machine hostname on the tailnet (default: exoclaw)
#   TS_STATE_DIR  — State directory (default: ~/.tailscale)
#
# Usage: tailscale-funnel.sh <port>

set -euo pipefail

PORT="${1:?Usage: tailscale-funnel.sh <port>}"
STATE_DIR="${TS_STATE_DIR:-${HOME}/.tailscale}"
SOCKET="${STATE_DIR}/tailscaled.sock"
AUTHKEY="${TS_AUTHKEY:-${TUNNEL_TOKEN:-}}"
HOSTNAME="${TS_HOSTNAME:-exoclaw}"
USE_CUSTOM_SOCKET=true

if ! command -v tailscale &>/dev/null; then
  echo "Error: tailscale not installed." >&2
  echo "Run: sudo /app/scripts/install-tailscale.sh" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"

# Check if tailscaled is already reachable
if tailscale --socket="$SOCKET" status &>/dev/null 2>&1; then
  echo "tailscaled already running (custom socket)" >&2
elif tailscale status &>/dev/null 2>&1; then
  # System-level tailscale running — use default socket
  USE_CUSTOM_SOCKET=false
  echo "Using system tailscaled" >&2
else
  echo "Starting tailscaled (userspace networking)..." >&2
  tailscaled \
    --state="${STATE_DIR}/tailscaled.state" \
    --socket="$SOCKET" \
    --tun=userspace-networking \
    --port=0 \
    &>/dev/null &
  TAILSCALED_PID=$!

  # Wait for the socket to appear (max 30s)
  for i in $(seq 1 30); do
    [ -S "$SOCKET" ] && break
    if ! kill -0 "$TAILSCALED_PID" 2>/dev/null; then
      echo "Error: tailscaled exited unexpectedly" >&2
      exit 1
    fi
    sleep 1
  done

  if [ ! -S "$SOCKET" ]; then
    echo "Error: tailscaled socket did not appear after 30s" >&2
    kill "$TAILSCALED_PID" 2>/dev/null || true
    exit 1
  fi

  echo "tailscaled running (pid=$TAILSCALED_PID)" >&2

  # Authenticate
  if [ -n "$AUTHKEY" ]; then
    echo "Authenticating as ${HOSTNAME}..." >&2
    tailscale --socket="$SOCKET" up \
      --authkey="$AUTHKEY" \
      --hostname="$HOSTNAME"
    echo "Authenticated on tailnet" >&2
  else
    echo "Warning: no auth key provided." >&2
    echo "Tailscale may not be authenticated. Paste an auth key into the" >&2
    echo "tunnel Auth Key field in the dashboard and restart the tunnel." >&2
  fi
fi

# Build funnel command
FUNNEL_ARGS=()
if [ "$USE_CUSTOM_SOCKET" = true ]; then
  FUNNEL_ARGS+=(--socket="$SOCKET")
fi
FUNNEL_ARGS+=(funnel "$PORT")

echo "Starting tailscale funnel on port ${PORT}..." >&2
exec tailscale "${FUNNEL_ARGS[@]}"
