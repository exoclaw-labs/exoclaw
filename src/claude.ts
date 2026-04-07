/**
 * Claude Code session manager — hybrid tmux + MCP channel approach.
 *
 * Runs a real interactive `claude` session in tmux with --remote-control.
 * Registers a custom MCP channel server so the gateway can push messages
 * via clean structured protocol instead of screen scraping.
 *
 * Primary I/O: MCP channel (POST /push → channel notification → reply tool)
 * Fallback I/O: tmux send-keys + capture-pane (if channel unavailable)
 *
 * Auth: subscription via `claude login`.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync, unlinkSync } from "fs";
import { join } from "path";
import { TMUX_SESSION, CHANNEL_PORT, POLL_INTERVAL_MS, STABLE_THRESHOLD, PROJECT_DIR_SUFFIX } from "./constants.js";

// ── Types ──

export interface McpServerDef {
  enabled?: boolean;
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ClaudeConfig {
  name?: string;
  model: string;
  permissionMode: string;
  systemPrompt?: string;
  mcpServers?: Record<string, McpServerDef>;
  agents?: Record<string, { description: string; prompt: string }>;
  allowedTools?: string[];
  disallowedTools?: string[];
  extraFlags?: string[];
  remoteControl?: boolean;
}

const IDLE_PATTERN = /^❯\s*$/m;


export class Claude {
  private config: ClaudeConfig;
  private mcpConfigPath: string;
  private _busy = false;
  private _alive = false;
  private channelAvailable = false;
  private _remoteControlUrl: string | null = null;

  /** Called after each turn completes. Set by the gateway to trigger background review. */
  onTurnComplete: (() => void) | null = null;

  constructor(config: ClaudeConfig) {
    this.config = config;
    this.mcpConfigPath = this.writeMcpConfig(config.mcpServers || {});
  }

  /** Write Claude Code settings that make the TUI tmux-friendly. */
  private writeTmuxSettings(): void {
    const configDir = join(process.env.HOME || "/home/agent", ".claude");
    mkdirSync(configDir, { recursive: true });
    const settingsPath = join(configDir, "settings.json");
    let settings: Record<string, any> = {};
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch (err) {
      if (err instanceof SyntaxError) {
        log("warn", `Failed to parse settings.json: ${err.message}`);
      }
    }
    settings.skipDangerousModePermissionPrompt = true;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  /** Start the persistent tmux + claude session. */
  start(): void {
    // Ensure tmux-friendly settings are persisted
    this.writeTmuxSettings();

    try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch (err) {
      log("debug", `tmux kill-session (pre-start cleanup): ${err}`);
    }

    const claudeArgs = this.buildArgs();

    // Write a launcher script with tmux-friendly env vars
    const launcherPath = join(process.env.HOME || "/tmp", ".exoclaw", "launch.sh");
    mkdirSync(join(process.env.HOME || "/tmp", ".exoclaw"), { recursive: true });
    const scriptLines = [
      "#!/bin/sh",
      "# tmux-friendly environment — simplify TUI for reliable capture-pane parsing",
      "export CLAUDE_CODE_DISABLE_MOUSE=1",
      "export CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1",
      "export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1",
      "export CLAUDE_CODE_NO_FLICKER=1",
      "export CLAUDE_CODE_ACCESSIBILITY=1",
      "export NO_COLOR=1",
      `exec claude \\`,
    ];
    for (const arg of claudeArgs) {
      scriptLines.push(`  '${arg.replace(/'/g, "'\\''")}' \\`);
    }
    scriptLines[scriptLines.length - 1] = scriptLines[scriptLines.length - 1].replace(/ \\$/, "");
    writeFileSync(launcherPath, scriptLines.join("\n") + "\n", { mode: 0o755 });

    // Configure tmux for reliable capture-pane parsing
    try {
      execSync(`tmux set-option -g history-limit 10000 2>/dev/null`);
      execSync(`tmux set-option -g escape-time 0 2>/dev/null`);
      execSync(`tmux set-option -g set-clipboard off 2>/dev/null`);
      execSync(`tmux set-option -g mouse off 2>/dev/null`);
      execSync(`tmux set-option -g status off 2>/dev/null`);
    } catch { /* tmux server may not be running yet */ }

    log("info", `Starting tmux session: claude ${claudeArgs.join(" ")}`);
    execSync(`tmux new-session -d -s ${TMUX_SESSION} -x 200 -y 50 ${launcherPath}`);
    this._alive = true;

    this.autoAcceptPrompts();
    this.pollChannelHealth();
    this.saveSessionId();

    // Monitor tmux session health + auto-restart
    setInterval(() => {
      try {
        execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
        this._alive = true;
      } catch {
        if (this._alive) {
          log("warn", "Claude tmux session died — restarting in 5s");
          this._alive = false;
          setTimeout(() => this.respawn(), 5000);
        }
      }
    }, 5000);

    log("info", "Claude tmux session started");
  }

  /** Respawn the tmux session after a crash. */
  private respawn(): void {
    try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch (err) {
      log("debug", `tmux kill-session (pre-respawn cleanup): ${err}`);
    }

    // Rewrite launcher script (same env vars as start()) and respawn
    const claudeArgs = this.buildArgs();
    const launcherPath = join(process.env.HOME || "/tmp", ".exoclaw", "launch.sh");
    const scriptLines = [
      "#!/bin/sh",
      "export CLAUDE_CODE_DISABLE_MOUSE=1",
      "export CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1",
      "export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1",
      "export CLAUDE_CODE_NO_FLICKER=1",
      "export CLAUDE_CODE_ACCESSIBILITY=1",
      "export NO_COLOR=1",
      `exec claude \\`,
    ];
    for (const arg of claudeArgs) {
      scriptLines.push(`  '${arg.replace(/'/g, "'\\''")}' \\`);
    }
    scriptLines[scriptLines.length - 1] = scriptLines[scriptLines.length - 1].replace(/ \\$/, "");
    writeFileSync(launcherPath, scriptLines.join("\n") + "\n", { mode: 0o755 });

    log("info", "Respawning tmux session");
    try {
      execSync(`tmux new-session -d -s ${TMUX_SESSION} -x 200 -y 50 ${launcherPath}`);
      this._alive = true;
    } catch (err) {
      log("error", `Respawn failed: ${err}`);
    }
  }

  /** Periodically check if the MCP channel server is up. */
  private pollChannelHealth(): void {
    const check = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${CHANNEL_PORT}/health`);
        this.channelAvailable = r.ok;
      } catch {
        this.channelAvailable = false;
      }
    };
    setInterval(check, 3000);
    // First check after startup delay (claude needs to spawn the MCP server)
    setTimeout(check, 5000);
  }

  /**
   * Continuously watch the tmux pane and auto-accept interactive prompts.
   * Runs as a background loop for the lifetime of the session — handles
   * startup prompts, post-login prompts, and any future interactive
   * dialogs that appear.
   */
  private async autoAcceptPrompts(): Promise<void> {
    let ready = false;

    let busySince: number | null = null;

    const tick = async () => {
      if (!this._alive) return;

      // Busy watchdog: if tmux shows idle prompt but _busy is stuck, force-clear it
      if (this._busy) {
        try {
          const pane = this.capturePane();
          if (pane && IDLE_PATTERN.test(pane)) {
            if (!busySince) {
              busySince = Date.now();
            } else if (Date.now() - busySince > 10_000) {
              log("warn", "Busy flag stuck while Claude is idle — force-clearing");
              this._busy = false;
              busySince = null;
            }
          } else {
            busySince = null; // Claude is actually working
          }
        } catch { /* intentional */ }
        return;
      }
      busySince = null;

      try {
        const pane = this.capturePane();
        if (!pane) return;

        // Already at idle prompt
        if (IDLE_PATTERN.test(pane)) {
          if (!ready) { ready = true; log("info", "Claude interactive session ready"); }
          return;
        }

        ready = false;

        // Resume session picker — just press Enter to confirm the selected session
        if (pane.includes("Resume Session") && pane.includes("Type to search")) {
          log("info", "Auto-accepting session resume picker");
          execSync(`tmux send-keys -t ${TMUX_SESSION} Enter`);
          return;
        }

        // Workspace trust — "Yes, I trust this folder" is pre-selected, press Enter
        if (pane.includes("Yes, I trust this folder")) {
          log("info", "Auto-accepting workspace trust prompt");
          execSync(`tmux send-keys -t ${TMUX_SESSION} Enter`);
          return;
        }

        // Theme picker — accept default
        if (pane.includes("Syntax theme:") || pane.includes("Choose a theme") || pane.includes("Select a color")) {
          log("info", "Auto-accepting theme prompt");
          execSync(`tmux send-keys -t ${TMUX_SESSION} Enter`);
          return;
        }

        // "Press Enter to continue" after login success
        if (pane.includes("Press Enter to continue") || pane.includes("Login successful")) {
          log("info", "Auto-accepting post-login prompt");
          execSync(`tmux send-keys -t ${TMUX_SESSION} Enter`);
          return;
        }

        // Bypass permissions warning — default is "No, exit" so we must
        // navigate DOWN to "Yes, I accept" before pressing Enter
        if (pane.includes("Bypass Permissions") || pane.includes("Yes, I accept")) {
          log("info", "Auto-accepting bypass permissions prompt");
          execSync(`tmux send-keys -t ${TMUX_SESSION} Down`);
          await sleep(300);
          execSync(`tmux send-keys -t ${TMUX_SESSION} Enter`);
          return;
        }

        // Generic "Enter to confirm" prompts (not login/permissions related)
        if (
          (pane.includes("Enter to confirm") || pane.includes("Esc to cancel")) &&
          !pane.includes("Select login method") &&
          !pane.includes("Paste code here") &&
          !pane.includes("API key") &&
          !pane.includes("No, exit")
        ) {
          log("info", "Auto-accepting interactive prompt");
          execSync(`tmux send-keys -t ${TMUX_SESSION} Enter`);
          return;
        }

        // Login / OAuth prompts — leave for the Setup page to handle
        // (Select login method, Paste code here, API key, etc.)

      } catch (err) {
        log("debug", `Auto-accept tick error: ${err}`);
      }
    };

    // Poll every 2 seconds
    setInterval(tick, 2000);
    // Run immediately
    await sleep(1000);
    tick();
  }

  /** Path to persist the session ID for --continue across restarts. */
  private get sessionFilePath(): string {
    return join(process.env.HOME || "/tmp", ".exoclaw", "session-id");
  }

  private saveSessionId(): void {
    // Wait for Claude to create a JSONL file, then save its UUID as the active session
    setTimeout(() => {
      try {
        const projectDir = join(
          join(process.env.HOME || "/home/agent", ".claude"),
          "projects", PROJECT_DIR_SUFFIX
        );
        const files = readdirSync(projectDir)
          .filter(f => f.endsWith(".jsonl") && !f.includes("/"))
          .map(f => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          const sessionId = files[0].name.replace(".jsonl", "");
          const dir = join(process.env.HOME || "/tmp", ".exoclaw");
          mkdirSync(dir, { recursive: true });
          writeFileSync(this.sessionFilePath, sessionId);
          log("info", `Saved session ID: ${sessionId}`);
        }
        // Capture remote control URL from the tmux pane
        const pane = this.capturePane();
        const rcMatch = pane.match(/(https:\/\/claude\.ai\/code\/remote-control[^\s]*)/);
        if (rcMatch) {
          this._remoteControlUrl = rcMatch[1];
          log("info", `Captured remote control URL`);
        }
      } catch { /* intentional */ }
    }, 15000);
  }

  private buildArgs(): string[] {
    const args = [
      "--model", this.config.model,
      // Main agent always runs in bypass mode for uninterrupted operation
      "--permission-mode", "bypassPermissions",
      // MCP servers are configured in workspace/.mcp.json — Claude reads it natively
    ];

    // Resume a specific session by UUID, or start fresh if no saved ID
    try {
      const savedId = readFileSync(this.sessionFilePath, "utf-8").trim();
      if (savedId) {
        args.push("--resume", savedId);
        log("info", `Resuming session: ${savedId.slice(0, 8)}...`);
      }
    } catch { /* no saved session, starts fresh */ }

    if (this.config.name) {
      args.push("--name", this.config.name);
    }

    if (this.config.remoteControl !== false) {
      args.push("--remote-control");
      if (this.config.name) {
        args.push("--remote-control-session-name-prefix", this.config.name);
      }
    }

    // Load the channel plugin so Claude sees channel events from the gateway
    args.push("--plugin-dir", "/app/channel-plugin");

    // System prompt is handled by CLAUDE.md in the workspace — no --system-prompt flag needed

    if (this.config.agents && Object.keys(this.config.agents).length > 0) {
      args.push("--agents", JSON.stringify(this.config.agents));
    }

    if (this.config.allowedTools?.length) {
      args.push("--allowed-tools", ...this.config.allowedTools);
    }
    if (this.config.disallowedTools?.length) {
      args.push("--disallowed-tools", ...this.config.disallowedTools);
    }

    if (this.config.extraFlags?.length) {
      args.push(...this.config.extraFlags);
    }

    return args;
  }

  // ── I/O ──

  async *send(prompt: string): AsyncGenerator<{ type: string; content: string }> {
    if (this._busy) throw new Error("Session is busy");

    log("info", `send(): prompt="${prompt.slice(0, 60)}..."`);
    this._busy = true;

    try {
      yield* this.sendViaSessionFile(prompt);
    } finally {
      this._busy = false;
      // Notify background reviewer that a turn completed
      try { this.onTurnComplete?.(); } catch { /* intentional */ }
    }
  }

  // Fallback: tmux capture-pane polling (used when session file unavailable)
  private async *sendViaTmux(prompt: string): AsyncGenerator<{ type: string; content: string }> {
    this.sendKeys(prompt);
    await sleep(1500);

    let lastContent = "";
    let stableCount = 0;
    // Need 15 consecutive unchanged polls (~3s) to consider done
    // This handles tool use pauses and rendering delays
    const stableThreshold = STABLE_THRESHOLD;
    let responseStarted = false;
    let firstResponseAt = 0;
    const startTime = Date.now();

    while (true) {
      await sleep(POLL_INTERVAL_MS);

      const pane = this.capturePane();

      // Find the prompt echo — use the last occurrence since the same
      // text might appear multiple times in history
      const promptEcho = `❯ ${prompt}`;
      const echoIdx = pane.lastIndexOf(promptEcho);

      let afterEcho!: string;
      if (echoIdx === -1) {
        // Prompt might have been truncated by tmux or wrapped — try shorter match
        const shortPrompt = `❯ ${prompt.slice(0, 40)}`;
        const shortIdx = pane.lastIndexOf(shortPrompt);
        if (shortIdx === -1) {
          if (Date.now() - startTime > 60_000) {
            yield { type: "error", content: "Timeout waiting for prompt echo" };
            return;
          }
          continue;
        }
        // Use short match — find end of line
        const lineEnd = pane.indexOf("\n", shortIdx);
        afterEcho = pane.slice(lineEnd !== -1 ? lineEnd : shortIdx + shortPrompt.length);
      } else {
        afterEcho = pane.slice(echoIdx + promptEcho.length);
      }

      // Extract everything between the prompt echo and the next idle prompt
      const nextPromptIdx = afterEcho.indexOf("\n❯\n");
      const hasNextPrompt = nextPromptIdx !== -1 && responseStarted &&
        (Date.now() - firstResponseAt > 2000);

      const block = (hasNextPrompt
        ? afterEcho.slice(0, nextPromptIdx)
        : afterEcho
      );

      // Parse the block into structured events
      const parsed = this.parseResponseBlock(block);

      if (parsed.length > lastContent.length) {
        const delta = parsed.slice(lastContent.length);
        lastContent = parsed;
        if (!responseStarted) {
          responseStarted = true;
          firstResponseAt = Date.now();
        }
        stableCount = 0;

        // Emit typed events from the delta
        for (const line of delta.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Tool use: "  Ran 1 bash command" / "  Listed 1 directory" / "  Read 3 files"
          if (line.match(/^\s{2}(Ran|Listed|Read|Wrote|Edited|Searched|Created|Deleted|Fetched)\s/)) {
            yield { type: "tool", content: trimmed };
          }
          // Tool output: "  ⎿  $ command" or "  ⎿  output"
          else if (line.match(/^\s{2}⎿/)) {
            yield { type: "tool", content: trimmed.replace(/^⎿\s*/, "") };
          }
          // Regular assistant text
          else {
            yield { type: "chunk", content: trimmed };
          }
        }
      } else if (responseStarted) {
        stableCount++;
        if (hasNextPrompt && stableCount >= 3) break;
        if (stableCount >= stableThreshold) break;
      }

      if (Date.now() - startTime > 5 * 60 * 1000) {
        yield { type: "error", content: "Response timeout" };
        return;
      }
    }

    yield { type: "done", content: lastContent };
  }

  /**
   * Send via tmux keystroke + watch the session JSONL file for responses.
   * This gives us the same structured data that remote control sees —
   * full tool_use, tool_result, and text blocks.
   */
  private async *sendViaSessionFile(prompt: string): AsyncGenerator<{ type: string; content: string }> {
    log("debug", `sendViaSessionFile: prompt="${prompt.slice(0, 50)}..."`);

    // Find the current session JSONL file (most recently modified)
    const projectDir = join(
      join(process.env.HOME || "/home/agent", ".claude"),
      "projects",
      PROJECT_DIR_SUFFIX
    );
    let sessionFile = "";
    try {
      const files = readdirSync(projectDir)
        .filter(f => f.endsWith(".jsonl") && !f.includes("/"))
        .map(f => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) sessionFile = join(projectDir, files[0].name);
    } catch { /* intentional */ }

    if (!sessionFile) {
      log("warn", "No session file found, falling back to tmux");
      yield* this.sendViaTmux(prompt);
      return;
    }

    log("debug", `sendViaSessionFile: watching ${sessionFile.split("/").pop()}`);

    // Record current file size (we only want new lines)
    let fileSize = 0;
    try { fileSize = statSync(sessionFile).size; } catch { /* intentional */ }

    log("debug", `sendViaSessionFile: file size=${fileSize}, sending keys to tmux`);

    // Send the prompt to tmux
    this.sendKeys(prompt);

    // Watch for new JSONL lines
    let gotUserEcho = false;
    let lastAssistantText = "";
    const startTime = Date.now();

    while (true) {
      await sleep(POLL_INTERVAL_MS);

      // Check if a newer JSONL file appeared (session rotation)
      try {
        const files = readdirSync(projectDir)
          .filter(f => f.endsWith(".jsonl") && !f.includes("/"))
          .map(f => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          const newest = join(projectDir, files[0].name);
          if (newest !== sessionFile) {
            log("debug", `sendViaSessionFile: session file changed to ${files[0].name}`);
            sessionFile = newest;
            fileSize = 0; // Read from start of new file
          }
        }
      } catch { /* intentional */ }

      // Read new content from the file
      let newContent: string;
      try {
        const currentSize = statSync(sessionFile).size;
        if (currentSize <= fileSize) continue;

        const fd = openSync(sessionFile, "r");
        const buf = Buffer.alloc(currentSize - fileSize);
        readSync(fd, buf, 0, buf.length, fileSize);
        closeSync(fd);
        fileSize = currentSize;
        newContent = buf.toString("utf-8");
      } catch { continue; }

      // Parse each new JSONL line
      for (const line of newContent.split("\n")) {
        if (!line.trim()) continue;
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }

        const msg = entry.message || {};
        const content = msg.content;
        const entryType = entry.type;

        // Skip our own user message echo
        if (entryType === "user" && !gotUserEcho) {
          if (typeof content === "string" && content.includes(prompt.slice(0, 30))) {
            gotUserEcho = true;
          } else if (Array.isArray(content)) {
            const hasPrompt = content.some((c: any) => c.type === "text" && c.text?.includes(prompt.slice(0, 30)));
            if (hasPrompt) gotUserEcho = true;
          }
          continue;
        }

        // Tool results from user messages (tool execution output)
        if (entryType === "user" && entry.toolUseResult) {
          const stdout = entry.toolUseResult.stdout || "";
          if (stdout) {
            yield { type: "tool", content: stdout.slice(0, 500) };
          }
          continue;
        }

        // Assistant messages
        if (entryType === "assistant" && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              lastAssistantText = block.text;
              yield { type: "chunk", content: block.text };
            }
            if (block.type === "tool_use") {
              yield { type: "tool", content: `${block.name}: ${JSON.stringify(block.input || {}).slice(0, 200)}` };
            }
            if (block.type === "thinking" && block.thinking) {
              yield { type: "thinking", content: block.thinking.slice(0, 300) };
            }
          }

          // If this assistant message has no tool_use, it's the final response
          const hasToolUse = content.some((c: any) => c.type === "tool_use");
          if (!hasToolUse && lastAssistantText) {
            yield { type: "done", content: lastAssistantText };
            return;
          }
        }
      }

      // Timeout
      if (Date.now() - startTime > 5 * 60 * 1000) {
        yield { type: "error", content: "Response timeout" };
        return;
      }
    }
  }

  /** Parse a tmux response block, stripping TUI noise but preserving structure. */
  private parseResponseBlock(block: string): string {
    return block
      .split("\n")
      .filter((l) =>
        !l.match(/^[─━]+$/) &&
        !l.match(/^\s*\? for shortcu/) &&
        !l.match(/Remote Control/) &&
        !l.match(/^\s*[·•✻✶✷✸✹✺✽⊹⋆∗⁕※☆★]\s+\w+…/) &&
        !l.match(/^\s*[·•✻✶✷✸✹✺✽⊹⋆∗⁕※☆★]\s+\w+\.\.\.$/) &&
        !l.match(/\(thinking\)\s*$/) &&
        !l.match(/^\s*⏵⏵/) &&
        !l.match(/bypass permissions/) &&
        !l.match(/[◐◑◒◓]\s*(low|medium|high|max)\s*·\s*\/effort/) &&
        !l.match(/^\s*❯\s*$/) &&
        !l.match(/\/remote-control is active/) &&
        !l.match(/Please upgrade to the latest/) &&
        !l.match(/Claude Code has switched/) &&
        !l.match(/shift\+tab to cycle/) &&
        !l.match(/^\s*\/\w+\s*$/) &&
        !l.match(/ctrl\+o to expand/)
      )
      .map(l => l.replace(/^●\s*/, ""))
      .join("\n")
      .trim();
  }

  // ── tmux helpers ──

  private sendKeys(text: string): void {
    execSync(`tmux send-keys -t ${TMUX_SESSION} ${shellEscape(text)} Enter`);
  }

  private capturePane(): string {
    try {
      return execSync(`tmux capture-pane -t ${TMUX_SESSION} -p -S -200`, { encoding: "utf-8" });
    } catch { return ""; }
  }

  // ── MCP config ──

  /**
   * Write MCP servers to the workspace .mcp.json.
   *
   * This is the standard location Claude Code reads for project-scoped
   * MCP servers. No --strict-mcp-config needed — Claude reads it natively.
   *
   * Exoclaw-managed servers (from config) are merged with the exoclaw-channel
   * server. Existing entries in .mcp.json that weren't written by us are preserved.
   */
  private writeMcpConfig(servers: Record<string, McpServerDef>): string {
    const workspaceDir = join(process.env.HOME || "/tmp", "workspace");
    mkdirSync(workspaceDir, { recursive: true });

    // Fix ownership if workspace was created by root (stale Docker volume)
    try {
      writeFileSync(join(workspaceDir, ".mcp.json.probe"), "", { flag: "w" });
      unlinkSync(join(workspaceDir, ".mcp.json.probe"));
    } catch {
      try { execSync(`sudo chown -R $(id -u):$(id -g) ${workspaceDir}`, { stdio: "ignore" }); } catch { /* best effort */ }
    }

    const path = join(workspaceDir, ".mcp.json");

    // Read existing .mcp.json (may have been written by `claude mcp add` etc.)
    let existing: Record<string, any> = {};
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      existing = data.mcpServers || {};
    } catch { /* doesn't exist yet */ }

    // Filter our config servers to only enabled ones, strip the 'enabled' field
    const enabledServers: Record<string, any> = {};
    for (const [name, def] of Object.entries(servers)) {
      if (def.enabled === false) continue;
      const rest = Object.fromEntries(Object.entries(def).filter(([k]) => k !== "enabled"));
      enabledServers[name] = rest;
    }

    // Merge: exoclaw config servers + existing .mcp.json
    // Our config wins on name collisions
    // (exoclaw-channel is loaded as a plugin, not an MCP server)
    const allServers: Record<string, any> = {
      ...existing,
      ...enabledServers,
    };

    writeFileSync(path, JSON.stringify({ mcpServers: allServers }, null, 2));
    return path;
  }

  // ── Accessors ──

  get alive(): boolean { return this._alive; }
  get busy(): boolean { return this._busy; }
  get usingChannel(): boolean { return this.channelAvailable; }
  get remoteControlUrl(): string | null { return this._remoteControlUrl; }

  /** Update the in-memory config (e.g. after API config save). */
  updateConfig(config: ClaudeConfig): void {
    this.config = config;
    this.writeMcpConfig(config.mcpServers || {});
    log("info", `Config updated: model=${config.model}`);
  }

  restart(): void {
    log("info", "Restarting Claude session (continuing)");
    this.close();
    setTimeout(() => this.respawn(), 1000);
  }

  /** Kill session and start completely fresh — no --resume, no session history. */
  freshStart(): void {
    log("info", "Starting fresh Claude session");
    this.close();
    try { unlinkSync(this.sessionFilePath); } catch { /* intentional */ }
    setTimeout(() => this.respawn(), 1000);
  }

  /** Switch to a specific session by UUID. */
  switchSession(sessionId: string): void {
    log("info", `Switching to session: ${sessionId}`);
    this.close();
    const dir = join(process.env.HOME || "/tmp", ".exoclaw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.sessionFilePath, sessionId);
    setTimeout(() => this.respawn(), 1000);
  }

  /** Get the currently active session UUID. */
  get activeSessionId(): string | null {
    try { return readFileSync(this.sessionFilePath, "utf-8").trim() || null; }
    catch { return null; }
  }

  close(): void {
    try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch (err) {
      log("debug", `tmux kill-session (close): ${err}`);
    }
    this._alive = false;
    log("info", "Claude session closed");
  }
}

function shellEscape(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "claude", msg }) + "\n");
}
