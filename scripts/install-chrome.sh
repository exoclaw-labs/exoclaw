#!/bin/bash
# install-chrome.sh — install a local Chrome for agent-browser.
#
# Run during onboarding if the user wants local headless browsing
# instead of (or in addition to) cloud browser services.
#
# Usage:
#   ./scripts/install-chrome.sh          # macOS (no sudo needed)
#   sudo ./scripts/install-chrome.sh     # Linux (needs root for system deps)
#
# Most users should prefer cloud browsers (Browserbase, Browser Use, etc.)
# which require no local installation. Only run this for local browsing.

set -e

OS=$(uname -s)

# ── Linux: install system dependencies ──
if [ "$OS" = "Linux" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "Error: Linux requires root for system dependencies."
    echo "Run: sudo $0"
    exit 1
  fi

  echo "==> Installing Chrome headless dependencies..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libxss1 xdg-utils
  apt-get clean
  rm -rf /var/lib/apt/lists/*

  # If running as root but there's an AGENT_USER, install Chrome as that user
  if [ -n "$SUDO_USER" ]; then
    echo "==> Downloading Chrome for Testing as $SUDO_USER..."
    su - "$SUDO_USER" -c "agent-browser install"
  else
    echo "==> Downloading Chrome for Testing..."
    agent-browser install
  fi

# ── macOS: no system deps needed ──
elif [ "$OS" = "Darwin" ]; then
  echo "==> Downloading Chrome for Testing..."
  agent-browser install

else
  echo "Error: Unsupported OS: $OS"
  exit 1
fi

echo ""
echo "==> Chrome installed successfully."
echo "    agent-browser will use local Chrome for headless browsing."
echo ""
echo "    To use a cloud browser instead, configure the provider:"
echo "      agent-browser -p browserbase open https://example.com"
echo "      agent-browser -p browser-use open https://example.com"
