#!/bin/bash
# Installs Docker CLI (no daemon) for sandbox container management.
# Usage: install-docker-cli.sh <gpg-fingerprint>
# Verifies the apt signing key against the provided fingerprint before trusting it.
set -e

GPG_FINGERPRINT="$1"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc

expected_fingerprint="$(printf '%s' "$GPG_FINGERPRINT" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"
actual_fingerprint="$(gpg --batch --show-keys --with-colons /tmp/docker.gpg.asc | awk -F: '$1 == "fpr" { print toupper($10); exit }')"

if [ -z "$actual_fingerprint" ] || [ "$actual_fingerprint" != "$expected_fingerprint" ]; then
  echo "ERROR: Docker apt key fingerprint mismatch (expected $expected_fingerprint, got ${actual_fingerprint:-<empty>})" >&2
  exit 1
fi

gpg --dearmor -o /etc/apt/keyrings/docker.gpg /tmp/docker.gpg.asc
rm -f /tmp/docker.gpg.asc
chmod a+r /etc/apt/keyrings/docker.gpg
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable\n' \
  "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  docker-ce-cli docker-buildx-plugin docker-compose-plugin
