#!/bin/bash
# Installs the GitHub CLI (gh).
# Usage: install-gh.sh [version]
set -euo pipefail

VERSION="${1:-}"
if [ -z "${VERSION}" ]; then
  VERSION=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest | sed 's#.*/v##')
fi

GH_ARCH=$(dpkg --print-architecture)
curl -sfL "https://github.com/cli/cli/releases/download/v${VERSION}/gh_${VERSION}_linux_${GH_ARCH}.tar.gz" \
  -o /tmp/gh.tar.gz
tar xzf /tmp/gh.tar.gz -C /tmp/
cp /tmp/gh_*/bin/gh /usr/local/bin/gh
chmod +x /usr/local/bin/gh
rm -rf /tmp/gh*
