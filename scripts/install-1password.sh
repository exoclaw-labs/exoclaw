#!/bin/bash
# Installs the 1Password CLI (op).
set -e

curl -sS https://downloads.1password.com/linux/keys/1password.asc \
  | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" \
  > /etc/apt/sources.list.d/1password.list

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends 1password-cli
