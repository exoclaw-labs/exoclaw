#!/bin/bash
# Installs xiond (Xion blockchain CLI).
# Usage: install-xiond.sh <version>
set -e

VERSION="$1"
ARCH=$(dpkg --print-architecture)
curl -sfL "https://github.com/burnt-labs/xion/releases/download/v${VERSION}/xiond_${VERSION}_linux_${ARCH}.deb" \
  -o /tmp/xiond.deb
dpkg -i /tmp/xiond.deb
rm /tmp/xiond.deb
