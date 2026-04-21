#!/usr/bin/env bash
# upgrade-claude.sh — runtime upgrade of @anthropic-ai/claude-code.
#
# Invoked by the exoclaw supervisor via:
#   sudo -n /app/scripts/upgrade-claude.sh [version]
#
# Default version: "latest". flock prevents concurrent upgrades.
# Runs as root (via sudoers) because global npm install needs to write
# /usr/local/lib/node_modules.

set -euo pipefail

VERSION="${1:-latest}"
LOCKFILE=/tmp/exoclaw-upgrade-claude.lock
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "another upgrade is already in progress" >&2
  exit 2
fi

echo "==> old version:"
/usr/local/bin/claude --version 2>/dev/null || echo "(not installed)"

echo "==> installing @anthropic-ai/claude-code@${VERSION}"
/usr/local/bin/npm i -g "@anthropic-ai/claude-code@${VERSION}"

echo "==> new version:"
/usr/local/bin/claude --version

echo "==> done"
