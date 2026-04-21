#!/bin/bash
# install-tailscale.sh — install Tailscale static binaries (container-friendly).
#
# Installs tailscale + tailscaled to /usr/local/bin without apt repos or systemd.
# Designed for the exoclaw Docker container (node:22-slim based).
#
# Usage:
#   sudo ./scripts/install-tailscale.sh          # install latest
#   sudo ./scripts/install-tailscale.sh 1.78.1   # install specific version
#
# On macOS, Tailscale should be installed via the App Store or Homebrew.

set -euo pipefail

OS=$(uname -s)

if [ "$OS" = "Darwin" ]; then
  if command -v tailscale &>/dev/null; then
    echo "Tailscale already installed: $(tailscale version | head -1)"
  else
    echo "On macOS, install Tailscale from https://tailscale.com/download/mac"
    echo "  or: brew install tailscale"
  fi
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: requires root for installation."
  echo "Run: sudo $0"
  exit 1
fi

VERSION="${1:-}"
ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  armv7l|armhf)  ARCH="arm" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

if [ -z "$VERSION" ]; then
  echo "==> Fetching latest Tailscale version..."
  VERSION=$(curl -fsSL -o /dev/null -w '%{url_effective}' \
    https://github.com/tailscale/tailscale/releases/latest | sed 's#.*/v##')
fi

echo "==> Installing Tailscale ${VERSION} (${ARCH})..."
TARBALL="tailscale_${VERSION}_${ARCH}.tgz"
curl -fsSL "https://pkgs.tailscale.com/stable/${TARBALL}" -o "/tmp/${TARBALL}"
tar xzf "/tmp/${TARBALL}" -C /tmp/

install -m 755 "/tmp/tailscale_${VERSION}_${ARCH}/tailscale" /usr/local/bin/tailscale
install -m 755 "/tmp/tailscale_${VERSION}_${ARCH}/tailscaled" /usr/local/bin/tailscaled
rm -rf "/tmp/${TARBALL}" "/tmp/tailscale_${VERSION}_${ARCH}"

echo ""
echo "==> Tailscale ${VERSION} installed."
echo "    tailscale:  $(which tailscale)"
echo "    tailscaled: $(which tailscaled)"
echo ""
echo "    To use Tailscale Funnel, set TS_AUTHKEY in your environment"
echo "    and select 'Tailscale Funnel' as the tunnel provider in the dashboard."
