# exoclaw — one container, one Claude Code session, web dashboard
#
# Auth: subscription-based. After first run:
#   docker exec -it <name> claude login
#
# Browser: prefers cloud browsers (Browserbase, Browser Use, etc.)
#   For local Chrome: docker exec -it <name> sudo /app/scripts/install-chrome.sh

# ── Stage 1: Build SPA ──
FROM node:22-slim AS web-build
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /web
COPY web/package.json web/pnpm-lock.yaml web/tsconfig*.json web/vite.config.ts web/index.html ./
RUN pnpm install --frozen-lockfile
COPY web/src/ ./src/
RUN pnpm run build

# ── Stage 2: Runtime ──
FROM node:22-slim

# ── APT packages ──────────────────────────────────────────────────────────────
ARG EXOCLAW_DOCKER_APT_PACKAGES

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    binaryen build-essential bzip2 ca-certificates curl \
    dnsutils fd-find file git gnupg iputils-ping jq \
    less lsof nano netcat-openbsd openssh-client \
    pipx procps python3-dev ripgrep rsync socat \
    sqlite3 strace sudo tmux tree unzip vim \
    wget xz-utils yq zip \
    ${EXOCLAW_DOCKER_APT_PACKAGES} \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ── NPM packages ──────────────────────────────────────────────────────────────

ARG EXOCLAW_NPM_PACKAGES

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
RUN npm i -g @anthropic-ai/claude-code @openai/codex agent-browser agent-browser-mcp ${EXOCLAW_NPM_PACKAGES}

ENV PIPX_HOME=/opt/pipx
ENV PIPX_BIN_DIR=/usr/local/bin
RUN pipx ensurepath 2>/dev/null || true

# Build the gateway server
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src/ ./src/
RUN pnpm exec tsc && rm -rf src/

# Copy built SPA
COPY --from=web-build /web/dist ./web/dist

# Copy channel plugin
COPY channel-plugin /app/channel-plugin

# Copy default skills (seeded into workspace on first run)
COPY default-skills /app/default-skills

# Copy install scripts (owned by root, executable)
COPY scripts/ /app/scripts/
RUN chmod 755 /app/scripts/*.sh

# Install the exoclawctl CLI shim (wraps the compiled supervisor CLI)
RUN install -m 755 /app/scripts/exoclawctl.sh /usr/local/bin/exoclawctl

# ── Install Scripts ────────────────────────────────────────────────────────────

# Example: EXOCLAW_INSTALL_SCRIPTS="xiond rust" or "rust:wasm32-wasip1"
ARG EXOCLAW_INSTALL_SCRIPTS
RUN set -eu; \
    PATH="/app/scripts:$PATH"; \
    for script in $EXOCLAW_INSTALL_SCRIPTS; do \
    case "$script" in \
    *:*) install-${script%%:*}.sh $(echo "${script#*:}" | tr ':' ' ') ;; \
    *) install-${script}.sh ;; \
    esac || { echo "Install script failed: $script" >&2; exit 1; }; \
    done

# Always reinstall claude-code (pass --build-arg CACHEBUST=$(date +%s) to force)
ARG CACHEBUST=1
RUN npm i -g @anthropic-ai/claude-code@latest

# Sandboxed user + workspace
RUN useradd -m -s /bin/bash agent && \
    mkdir -p /home/agent/workspace && \
    chown agent:agent /home/agent/workspace

# Allow agent user to run install scripts + fix workspace permissions via sudo
RUN echo "agent ALL=(root) NOPASSWD: /app/scripts/*.sh, /bin/chown, /usr/bin/chown" > /etc/sudoers.d/exoclaw-scripts && \
    chmod 440 /etc/sudoers.d/exoclaw-scripts

USER agent
WORKDIR /home/agent/workspace

ENV HOME=/home/agent
ENV NODE_ENV=production
ENV ENABLE_CLAUDEAI_MCP_SERVERS=false

EXPOSE 8080

CMD ["node", "/app/dist/supervisor/index.js"]
