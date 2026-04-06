# exoclaw — one container, one Claude Code session, web dashboard
#
# Auth: subscription-based. After first run:
#   docker exec -it <name> claude login
#
# Browser: prefers cloud browsers (Browserbase, Browser Use, etc.)
#   For local Chrome: docker exec -it <name> sudo /app/scripts/install-chrome.sh

# ── Stage 1: Build SPA ──
FROM node:22-slim AS web-build
WORKDIR /web
COPY web/package.json web/tsconfig*.json web/vite.config.ts web/index.html ./
RUN npm install
COPY web/src/ ./src/
RUN npm run build

# ── Stage 2: Runtime ──
FROM node:22-slim

# ── APT packages ──────────────────────────────────────────────────────────────
ARG EXOCLAW_DOCKER_APT_PACKAGES

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash ca-certificates curl procps git gnupg jq vim tmux sudo \
    python3 python3-pip python3-venv pipx \
    build-essential python3-dev \
    ${EXOCLAW_DOCKER_APT_PACKAGES} \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ── NPM packages ──────────────────────────────────────────────────────────────

ARG EXOCLAW_NPM_PACKAGES

RUN npm i -g @anthropic-ai/claude-code agent-browser agent-browser-mcp ${EXOCLAW_NPM_PACKAGES}

ENV PIPX_HOME=/opt/pipx
ENV PIPX_BIN_DIR=/usr/local/bin
RUN pipx ensurepath 2>/dev/null || true

# Build the gateway server
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npx tsc && rm -rf src/

# Copy built SPA
COPY --from=web-build /web/dist ./web/dist

# Copy channel plugin
COPY channel-plugin /app/channel-plugin

# Copy default skills (seeded into workspace on first run)
COPY default-skills /app/default-skills

# Copy install scripts (owned by root, executable)
COPY scripts/ /app/scripts/
RUN chmod 755 /app/scripts/*.sh

# Always reinstall claude-code (pass --build-arg CACHEBUST=$(date +%s) to force)
ARG CACHEBUST=1
RUN npm install -g @anthropic-ai/claude-code@latest

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
ENV CLAUDE_CONFIG_DIR=/home/agent/.claude
ENV NODE_ENV=production
ENV ENABLE_CLAUDEAI_MCP_SERVERS=false

EXPOSE 8080

CMD ["node", "/app/dist/index.js"]
