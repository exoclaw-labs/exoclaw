#!/bin/bash
# Installs Chromium + Xvfb for browser automation via Playwright.
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
set -e

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb dbus dbus-x11
mkdir -p /opt/playwright-browsers
PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
  node /app/node_modules/playwright-core/cli.js install --with-deps chromium
chown -R node:node /opt/playwright-browsers
