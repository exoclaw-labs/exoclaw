<script setup lang="ts">
import { ref, nextTick, watch, onMounted, onUnmounted, computed } from "vue";
import { marked } from "marked";
import { useChatStore } from "../composables/useChatStore";
import { fetchConfig, saveConfig } from "../composables/useApi";

const { state, send, startPanePolling, stopPanePolling } = useChatStore();
const input = ref("");
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
const verbose = ref(false);
const showPane = ref(false);

// ── Model selector ──
const showModes = ref(false);
const config = ref<Record<string, any>>({});
const savingConfig = ref(false);

const models = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

const agentName = computed(() => {
  const n = config.value.name;
  if (!n || n === "agent") return "ExoClaw";
  return n.charAt(0).toUpperCase() + n.slice(1);
});

async function loadConfig() {
  try { config.value = await fetchConfig(); initThinkingLevel(); } catch {}
}

const thinkingLevels = [
  { value: "", label: "Default" },
  { value: "0", label: "None" },
  { value: "10000", label: "Low (10k)" },
  { value: "50000", label: "Medium (50k)" },
  { value: "100000", label: "High (100k)" },
];

const thinkingLevel = ref("");

function initThinkingLevel() {
  const flags = config.value?.claude?.extraFlags || [];
  const idx = flags.indexOf("--thinking-budget");
  thinkingLevel.value = idx >= 0 && idx < flags.length - 1 ? String(flags[idx + 1]) : "";
}

async function updateModel(value: string) {
  if (!config.value.claude) config.value.claude = {};
  config.value.claude.model = value;
  savingConfig.value = true;
  try { await saveConfig(config.value); } catch {}
  savingConfig.value = false;
}

async function updateThinkingLevel(value: string) {
  if (!config.value.claude) config.value.claude = {};
  const ef = (config.value.claude.extraFlags || []).filter(
    (f: string, i: number, arr: string[]) => f !== "--thinking-budget" && arr[i - 1] !== "--thinking-budget"
  );
  if (value) ef.push("--thinking-budget", value);
  config.value.claude.extraFlags = ef.length ? ef : undefined;
  thinkingLevel.value = value;
  savingConfig.value = true;
  try { await saveConfig(config.value); } catch {}
  savingConfig.value = false;
}

// ── Remote control toggle ──
const restartNeeded = ref(false);
const remoteControlEnabled = computed(() => config.value?.claude?.remoteControl !== false);

async function toggleRemoteControl() {
  if (!config.value.claude) config.value.claude = {};
  config.value.claude.remoteControl = !remoteControlEnabled.value;
  savingConfig.value = true;
  try { await saveConfig(config.value); restartNeeded.value = true; } catch {}
  savingConfig.value = false;
}

async function restartSession() {
  closeAllPopups();
  state.messages.push({ role: "assistant", content: "Restarting session..." });
  try { await fetch("/api/session/restart", { method: "POST" }); } catch {}
  restartNeeded.value = false;
}

// ── Slash commands (native + skills) ──
const showSlash = ref(false);
const customSkills = ref<{ name: string; content: string }[]>([]);
const slashFilter = ref("");

// Commands handled client-side (never sent to backend)
const LOCAL_COMMANDS = new Set(["clear", "model"]);

// Commands sent as tmux keystrokes to Claude Code CLI (not as prompts)
const CLI_COMMANDS = new Set([
  "compact", "cost", "status", "help", "diff", "plan", "review",
  "security-review", "context", "effort", "fast", "rewind", "usage",
  "permissions", "mcp", "hooks", "agents", "init", "doctor",
]);

// Native Claude Code commands shown in the slash menu
const nativeCommands = [
  { name: "clear", desc: "Clear conversation history", icon: "bi-x-circle" },
  { name: "compact", desc: "Compact conversation to save context", icon: "bi-arrows-collapse" },
  { name: "model", desc: "Change the AI model", icon: "bi-cpu" },
  { name: "cost", desc: "Show token usage statistics", icon: "bi-cash-coin" },
  { name: "status", desc: "Show version, model, account info", icon: "bi-info-circle" },
  { name: "help", desc: "Show help and available commands", icon: "bi-question-circle" },
  { name: "diff", desc: "View uncommitted changes", icon: "bi-file-diff" },
  { name: "review", desc: "Review code changes", icon: "bi-search" },
  { name: "security-review", desc: "Security analysis of pending changes", icon: "bi-shield-check" },
  { name: "plan", desc: "Enter plan mode", icon: "bi-map" },
  { name: "effort", desc: "Set model effort level", icon: "bi-speedometer" },
  { name: "context", desc: "Visualize context usage", icon: "bi-pie-chart" },
  { name: "fast", desc: "Toggle fast mode", icon: "bi-lightning-charge" },
  { name: "rewind", desc: "Rewind conversation to checkpoint", icon: "bi-skip-backward" },
  { name: "usage", desc: "Show plan usage and rate limits", icon: "bi-bar-chart" },
  { name: "permissions", desc: "Manage tool permissions", icon: "bi-shield-lock" },
  { name: "mcp", desc: "Manage MCP server connections", icon: "bi-plug" },
  { name: "hooks", desc: "View hook configurations", icon: "bi-link-45deg" },
  { name: "agents", desc: "Manage agent configurations", icon: "bi-people" },
  { name: "init", desc: "Initialize project with CLAUDE.md", icon: "bi-file-earmark-plus" },
  { name: "doctor", desc: "Diagnose installation issues", icon: "bi-heart-pulse" },
];

const allCommands = computed(() => {
  const cmds = [
    ...nativeCommands.map(c => ({ ...c, type: "native" as const })),
    ...customSkills.value.map(s => ({ name: s.name, desc: "Custom skill", icon: "bi-lightning", type: "skill" as const })),
  ];
  const q = slashFilter.value.toLowerCase();
  return q ? cmds.filter(c => c.name.includes(q) || c.desc.toLowerCase().includes(q)) : cmds;
});

async function loadSkills() {
  try { customSkills.value = ((await (await fetch("/api/skills")).json()).skills || []); } catch {}
}

async function sendTmuxKeys(keys: string) {
  try {
    await fetch("/api/session/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys }),
    });
  } catch {}
}

function handleSlashCommand(name: string): boolean {
  if (LOCAL_COMMANDS.has(name)) {
    if (name === "clear") {
      state.messages.length = 0;
      state.messages.push({ role: "assistant", content: "Conversation cleared." });
    } else if (name === "model") {
      showModes.value = true;
      showSlash.value = false;
    }
    return true;
  }
  if (CLI_COMMANDS.has(name)) {
    // Send as tmux keystrokes — Claude Code CLI intercepts these
    sendTmuxKeys(`"/${name}" Enter`);
    state.messages.push({ role: "assistant", content: `Sent \`/${name}\` to Claude Code session.` });
    scrollBottom();
    return true;
  }
  return false; // Not a recognized command — treat as prompt
}

function selectCommand(name: string) {
  closeAllPopups();
  if (handleSlashCommand(name)) return;
  // Custom skill — send as regular prompt
  input.value = `/${name}`;
  nextTick(() => { inputEl.value?.focus(); handleSend(); });
}

// ── File upload (+) ──
const fileInputEl = ref<HTMLInputElement | null>(null);
const uploadedFiles = ref<{ name: string; content: string }[]>([]);

function triggerFileUpload() {
  closeAllPopups();
  fileInputEl.value?.click();
}

function handleFileUpload(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files) return;
  for (const file of Array.from(files)) {
    // Max 1MB text files
    if (file.size > 1024 * 1024) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result as string;
      uploadedFiles.value.push({ name: file.name, content });
      // Append file content as context in the message
      const tag = `[File: ${file.name}]\n\`\`\`\n${content.slice(0, 10000)}\n\`\`\``;
      input.value = input.value ? `${input.value}\n\n${tag}` : tag;
      nextTick(() => { autoResize(); inputEl.value?.focus(); });
    };
    reader.readAsText(file);
  }
  // Reset so same file can be re-selected
  if (fileInputEl.value) fileInputEl.value.value = "";
}

// ── Tool classification ──
function isEditTool(name?: string): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes("edit") || n.includes("write") || n.includes("notebook");
}

// Try to parse diff-like content from edit tool args
function parseDiff(content: string): { file: string; oldStr: string; newStr: string } | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.file_path && (parsed.old_string !== undefined || parsed.new_string !== undefined)) {
      return {
        file: parsed.file_path,
        oldStr: parsed.old_string || "",
        newStr: parsed.new_string || "",
      };
    }
    // Write tool: just show content as "added"
    if (parsed.file_path && parsed.content) {
      return { file: parsed.file_path, oldStr: "", newStr: parsed.content.slice(0, 500) };
    }
  } catch {
    // Content is the "toolName: {json}" format from the server
    const match = content.match(/^[\w]+:\s*(\{.*\})$/s);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.file_path && (parsed.old_string !== undefined || parsed.new_string !== undefined)) {
          return { file: parsed.file_path, oldStr: parsed.old_string || "", newStr: parsed.new_string || "" };
        }
      } catch {}
    }
  }
  return null;
}

const expandedDiffs = ref<Set<number>>(new Set());

function toggleDiff(idx: number) {
  if (expandedDiffs.value.has(idx)) expandedDiffs.value.delete(idx);
  else expandedDiffs.value.add(idx);
}

// ── Chat helpers ──
function scrollBottom() {
  nextTick(() => { if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight; });
}

function renderMd(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

function autoResize() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function handleSend() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  nextTick(autoResize);

  // Check if it's a slash command
  const slashMatch = text.match(/^\/(\S+)$/);
  if (slashMatch && handleSlashCommand(slashMatch[1])) return;

  send(text);
  scrollBottom();
  nextTick(() => inputEl.value?.focus());
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  if (e.key === "/" && !input.value) { e.preventDefault(); showSlash.value = true; showModes.value = false; }
}

function copyText(text: string) { navigator.clipboard.writeText(text); }

function closeAllPopups() {
  showSlash.value = false;
  showModes.value = false;
  slashFilter.value = "";
}

function onDocClick(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".popup-anchor")) closeAllPopups();
}

function onWindowKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") { closeAllPopups(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.activeElement === inputEl.value) return;
  if (showSlash.value || showModes.value) return;
  inputEl.value?.focus();
}

onMounted(() => {
  scrollBottom(); loadConfig(); loadSkills();
  window.addEventListener("keydown", onWindowKeydown);
  document.addEventListener("click", onDocClick);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onWindowKeydown);
  document.removeEventListener("click", onDocClick);
});

watch(() => state.messages.length, scrollBottom);
watch(() => state.messages[state.messages.length - 1]?.content, scrollBottom);
watch(() => state.busy, (busy) => { if (!busy) nextTick(() => inputEl.value?.focus()); });

// Pane polling: start/stop based on toggle
const paneEl = ref<HTMLElement | null>(null);
watch(showPane, (on) => { if (on) startPanePolling(); else stopPanePolling(); });
watch(() => state.paneContent, () => {
  nextTick(() => { if (paneEl.value) paneEl.value.scrollTop = paneEl.value.scrollHeight; });
});

const currentModel = computed(() => {
  const m = config.value?.claude?.model || "";
  return m.replace("claude-", "").replace(/-\d+$/, "") || "—";
});
const statusText = computed(() => {
  if (!state.connected) return "Disconnected";
  if (state.busy) return "Responding...";
  if (state.agentBusy) return "Agent working...";
  if (!state.agentAlive) return "Agent offline";
  return "Ready";
});

const isWorking = computed(() => state.busy || state.agentBusy);

/** Show tmux pane content, stripping the Claude Code input prompt area. */
const paneDisplay = computed(() => {
  const raw = state.paneContent;
  if (!raw) return "";
  const lines = raw.split("\n");
  // Strip trailing idle prompt (❯) and anything after it (the typing area)
  let endIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(0, endIdx).filter(l => l.trim() !== "").join("\n");
});

// On mobile, which panel is active
const mobileView = ref<'chat' | 'pane'>('chat');
</script>

<template>
  <div class="code-panel d-flex flex-column h-100">
    <!-- Header -->
    <div class="code-header">
      <div class="d-flex align-items-center gap-2">
        <i class="bi bi-braces text-primary" style="font-size:14px"></i>
        <span class="fw-semibold" style="font-size:12px">Claude Code</span>
      </div>
      <div class="d-flex align-items-center gap-2">
        <button class="header-btn" :class="{ active: verbose }" @click="verbose = !verbose"
          :title="verbose ? 'Hide tool details' : 'Show tool details'">
          <i class="bi" :class="verbose ? 'bi-eye-fill' : 'bi-eye'"></i>
        </button>
        <span class="status-text">{{ statusText }}</span>
        <span class="status-dot" :class="{
          connected: state.connected && !isWorking,
          busy: isWorking,
          disconnected: !state.connected || !state.agentAlive,
        }"></span>
      </div>
    </div>

    <!-- Body: chat + pane side by side -->
    <div class="code-body">
      <!-- Chat panel -->
      <div ref="scrollEl" class="chat-side" :class="{ 'mobile-hidden': showPane && mobileView === 'pane' }">
        <div v-if="!state.messages.length" class="h-100 d-flex flex-column align-items-center justify-content-center text-body-secondary px-4">
          <i class="bi bi-braces" style="font-size:40px;opacity:0.12"></i>
          <p class="mt-2 mb-0 small text-center" style="max-width:260px">Ask {{ agentName }} to write code, fix bugs, refactor, or explain.</p>
        </div>

        <template v-for="(m, i) in state.messages" :key="i">
          <!-- User -->
          <div v-if="m.role === 'user'" class="msg msg-user">
            <div class="msg-label">You</div>
            <div class="msg-body">{{ m.content }}</div>
          </div>

          <!-- Assistant -->
          <div v-else-if="m.role === 'assistant'" class="msg msg-assistant">
            <div class="msg-label">{{ agentName }}</div>
            <div class="msg-body msg-md">
              <div v-html="renderMd(m.content)" class="chat-md"></div>
              <button class="copy-btn" @click="copyText(m.content)" title="Copy"><i class="bi bi-clipboard"></i></button>
            </div>
          </div>

          <!-- Thinking -->
          <div v-else-if="m.role === 'thinking'" class="tool-line thinking-line">
            <i class="bi bi-lightbulb"></i>
            <span class="tool-line-label">Thinking</span>
            <span class="tool-line-detail">{{ m.content.slice(0, 80) }}{{ m.content.length > 80 ? '...' : '' }}</span>
          </div>

          <!-- Tool calls -->
          <template v-else-if="m.role === 'tool'">
            <!-- Edit tool → diff box -->
            <div v-if="isEditTool(m.toolName) && parseDiff(m.content)" class="diff-box">
              <div class="diff-header">
                <i class="bi bi-pencil-square diff-icon"></i>
                <span class="diff-file">{{ parseDiff(m.content)!.file.split('/').pop() }}</span>
                <span class="diff-path">{{ parseDiff(m.content)!.file }}</span>
              </div>
              <div class="diff-body" :class="{ 'diff-collapsed': !expandedDiffs.has(i) }">
                <template v-if="parseDiff(m.content)!.oldStr">
                  <div v-for="(line, li) in parseDiff(m.content)!.oldStr.split('\n')" :key="'r'+li" class="diff-line diff-removed">
                    <span class="diff-gutter">-</span><span>{{ line }}</span>
                  </div>
                </template>
                <template v-if="parseDiff(m.content)!.newStr">
                  <div v-for="(line, li) in parseDiff(m.content)!.newStr.split('\n')" :key="'a'+li" class="diff-line diff-added">
                    <span class="diff-gutter">+</span><span>{{ line }}</span>
                  </div>
                </template>
              </div>
              <button v-if="parseDiff(m.content)!.oldStr.split('\n').length + parseDiff(m.content)!.newStr.split('\n').length > 8" class="diff-expand" @click="toggleDiff(i)">
                {{ expandedDiffs.has(i) ? 'Show less' : 'Show more' }}
              </button>
            </div>

            <!-- Other tools: shown in verbose mode -->
            <div v-else-if="verbose" class="tool-verbose">
              <div class="tool-verbose-header">
                <i class="bi" :class="{
                  'bi-terminal': m.toolName?.toLowerCase().includes('bash'),
                  'bi-file-earmark-text': m.toolName?.toLowerCase().includes('read'),
                  'bi-search': m.toolName?.toLowerCase().includes('glob') || m.toolName?.toLowerCase().includes('grep'),
                  'bi-wrench': !m.toolName,
                }"></i>
                <span>{{ m.toolName || 'Tool' }}</span>
              </div>
              <pre class="tool-verbose-body">{{ m.content.slice(0, 600) }}{{ m.content.length > 600 ? '\n...' : '' }}</pre>
            </div>
          </template>

          <!-- Error -->
          <div v-else-if="m.role === 'error'" class="msg-error">
            <i class="bi bi-exclamation-triangle"></i> {{ m.content }}
          </div>
        </template>

        <div v-if="isWorking" class="busy-bar">
          <span class="busy-spinner"></span>
          <span>{{ statusText }}</span>
        </div>
      </div>

      <!-- Pane toggle rail -->
      <button class="pane-toggle" @click="showPane = !showPane; if (showPane) mobileView = 'pane'; else mobileView = 'chat';"
        :title="showPane ? 'Hide session' : 'Show session'">
        <i class="bi" :class="showPane ? 'bi-chevron-right' : 'bi-chevron-left'"></i>
      </button>

      <!-- Session pane -->
      <div v-if="showPane" class="pane-side" :class="{ 'mobile-hidden': mobileView === 'chat' }">
        <div class="pane-header">
          <i class="bi bi-terminal" style="font-size:12px"></i>
          <span>Session</span>
          <!-- Mobile: switch back to chat -->
          <button class="pane-mobile-back" @click="mobileView = 'chat'">
            <i class="bi bi-chat-dots"></i> Chat
          </button>
        </div>
        <pre ref="paneEl" class="pane-content">{{ paneDisplay || 'Waiting for session output...' }}</pre>
      </div>
    </div>

    <!-- Input area — always at bottom, full width -->
    <div class="code-input-area">
      <input ref="fileInputEl" type="file" multiple accept=".txt,.md,.ts,.js,.tsx,.jsx,.json,.yml,.yaml,.py,.sh,.css,.html,.xml,.csv,.sql,.rs,.go,.java,.c,.cpp,.h,.rb,.php,.swift,.kt,.toml,.ini,.cfg,.env,.log" style="display:none" @change="handleFileUpload" />

      <!-- Mobile: tab switcher when pane is open -->
      <div v-if="showPane" class="mobile-tabs">
        <button class="mobile-tab" :class="{ active: mobileView === 'chat' }" @click="mobileView = 'chat'">
          <i class="bi bi-chat-dots"></i> Chat
        </button>
        <button class="mobile-tab" :class="{ active: mobileView === 'pane' }" @click="mobileView = 'pane'">
          <i class="bi bi-terminal"></i> Session
        </button>
      </div>

      <form @submit.prevent="handleSend" class="code-input-form">
        <textarea ref="inputEl" v-model="input" :disabled="!state.connected"
          :placeholder="`Ask ${agentName}...`" autofocus rows="1" class="code-input"
          @keydown="handleKeydown" @input="autoResize"></textarea>
        <button type="submit" class="code-send-btn" :disabled="!state.connected || !input.trim()">
          <i class="bi bi-arrow-up"></i>
        </button>
      </form>

      <!-- Bottom bar: +, /, mode -->
      <div class="input-bottom-bar">
        <button class="action-btn" @click="triggerFileUpload" title="Upload file">
          <i class="bi bi-plus-lg"></i>
        </button>
        <div class="popup-anchor">
          <button class="action-btn" @click.stop="showSlash = !showSlash; showModes = false" title="Commands">
            <i class="bi bi-slash"></i>
          </button>
          <div v-if="showSlash" class="popup slash-popup">
            <div class="popup-header">
              <input v-model="slashFilter" class="popup-search" placeholder="Search commands..." @keydown.stop autofocus />
            </div>
            <div class="popup-scroll">
              <div v-if="!allCommands.length" class="popup-empty">No matching commands</div>
              <button v-for="c in allCommands" :key="c.name" class="popup-item" @click="selectCommand(c.name)">
                <i :class="['bi', c.icon]" style="font-size:11px"></i>
                <span class="slash-name">/{{ c.name }}</span>
                <span class="popup-item-desc">{{ c.desc }}</span>
              </button>
            </div>
          </div>
        </div>
        <div class="popup-anchor">
          <button class="mode-bar-btn" @click.stop="showModes = !showModes; showSlash = false">
            <span class="mode-bar-model">{{ currentModel }}</span>
            <i class="bi bi-chevron-up" style="font-size:9px"></i>
          </button>
          <div v-if="showModes" class="popup modes-popup">
            <div class="popup-section-label">Model</div>
            <button v-for="m in models" :key="m" class="popup-item" :class="{ active: config.claude?.model === m }" @click="updateModel(m)">
              <i class="bi bi-cpu"></i>
              <span>{{ m.replace('claude-', '').replace(/-\d+$/, '') }}</span>
              <i v-if="config.claude?.model === m" class="bi bi-check2 ms-auto"></i>
            </button>
            <div class="popup-divider"></div>
            <div class="popup-section-label">Thinking</div>
            <button v-for="t in thinkingLevels" :key="t.value" class="popup-item" :class="{ active: thinkingLevel === t.value }" @click="updateThinkingLevel(t.value)">
              <i class="bi bi-lightbulb"></i>
              <span>{{ t.label }}</span>
              <i v-if="thinkingLevel === t.value" class="bi bi-check2 ms-auto"></i>
            </button>
            <div class="popup-divider"></div>
            <div class="popup-section-label">Session</div>
            <button class="popup-item" @click="toggleRemoteControl">
              <i class="bi bi-broadcast"></i>
              <span>Remote control</span>
              <i class="bi ms-auto" :class="remoteControlEnabled ? 'bi-toggle-on text-success' : 'bi-toggle-off'"></i>
            </button>
            <div class="popup-divider"></div>
            <button class="popup-item popup-item-danger" @click="restartSession">
              <i class="bi bi-arrow-clockwise"></i>
              <span>Restart session</span>
            </button>
            <div v-if="savingConfig" class="popup-footer">Saving...</div>
            <div v-if="restartNeeded" class="popup-footer popup-footer-warn">Restart needed</div>
          </div>
        </div>
        <span class="mode-bar-info">Bypass permissions</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.code-panel {
  background: var(--bs-body-bg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

/* ── Header ── */
.code-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--bs-border-color); background: var(--bs-tertiary-bg);
  flex-shrink: 0;
}
.header-btn {
  background: none; border: none; color: var(--bs-tertiary-color);
  font-size: 12px; padding: 2px 6px; cursor: pointer; border-radius: 3px;
  display: flex; align-items: center; gap: 4px;
}
.header-btn:hover { color: var(--bs-secondary-color); background: var(--bs-secondary-bg); }
.header-btn.active { color: var(--bs-primary); }

.status-text { font-size: 11px; color: var(--bs-tertiary-color); }
.status-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.status-dot.connected { background: var(--bs-success); }
.status-dot.busy { background: var(--bs-warning); animation: pulse 1.5s infinite; }
.status-dot.disconnected { background: var(--bs-danger); }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

/* ── Body: split layout ── */
.code-body {
  flex: 1; display: flex; min-height: 0; overflow: hidden;
}

/* ── Chat side ── */
.chat-side {
  flex: 1; overflow-y: auto; min-width: 0;
  padding: 0;
}

/* ── Pane toggle rail ── */
.pane-toggle {
  flex-shrink: 0; width: 24px;
  display: flex; align-items: center; justify-content: center;
  background: var(--bs-tertiary-bg);
  border: none; border-left: 1px solid var(--bs-border-color); border-right: 1px solid var(--bs-border-color);
  color: var(--bs-tertiary-color);
  cursor: pointer; font-size: 14px;
  transition: color 0.15s, background 0.15s;
}
.pane-toggle:hover {
  background: var(--bs-secondary-bg);
  color: var(--bs-primary);
}

/* ── Pane side ── */
.pane-side {
  flex: 1; display: flex; flex-direction: column; min-width: 0;
  background: #1a1a2e;
}
.pane-header {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px; font-size: 11px; font-weight: 600;
  color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 0.5px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0;
}
.pane-mobile-back {
  display: none; /* shown on mobile only */
  margin-left: auto; background: none; border: none;
  color: rgba(255,255,255,0.5); font-size: 11px; cursor: pointer;
  gap: 4px; align-items: center;
}
.pane-mobile-back:hover { color: rgba(255,255,255,0.8); }
.pane-content {
  flex: 1; margin: 0; padding: 10px 12px; overflow-y: auto;
  font-family: "SF Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", var(--bs-font-monospace);
  font-size: 12px; line-height: 1.45; color: #e0e0e0;
  white-space: pre-wrap; word-break: break-all;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.15) transparent;
}

/* ── Messages ── */
.msg { padding: 12px 16px 8px; border-bottom: 1px solid var(--bs-border-color); }
.msg:last-child { border-bottom: none; }
.msg-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px; }
.msg-user .msg-label { color: var(--bs-secondary-color); }
.msg-assistant .msg-label { color: var(--bs-primary); }
.msg-body { font-size: 15px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.msg-md { position: relative; white-space: normal; }
.copy-btn {
  position: absolute; top: -2px; right: 0; background: none; border: none;
  color: var(--bs-tertiary-color); font-size: 11px; padding: 2px 4px;
  opacity: 0; transition: opacity 0.15s; cursor: pointer;
}
.msg-md:hover .copy-btn { opacity: 1; }
.copy-btn:hover { color: var(--bs-emphasis-color); }

/* ── Diff box (edit tools) ── */
.diff-box {
  margin: 4px 16px;
  border: 1px solid var(--bs-border-color);
  border-radius: 6px; overflow: hidden; background: var(--bs-tertiary-bg);
}
.diff-header {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; font-size: 13px; cursor: pointer; user-select: none;
}
.diff-header:hover { background: var(--bs-secondary-bg); }
.diff-icon { color: var(--bs-warning); font-size: 13px; }
.diff-file { font-weight: 500; color: var(--bs-emphasis-color); }
.diff-path {
  font-family: var(--bs-font-monospace); font-size: 10px; color: var(--bs-tertiary-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;
}
.diff-body {
  border-top: 1px solid var(--bs-border-color);
  font-family: var(--bs-font-monospace);
  font-size: 12px; line-height: 1.5;
  overflow: hidden;
}
.diff-collapsed { max-height: 120px; }
.diff-expand {
  display: block; width: 100%; padding: 3px; border: none;
  border-top: 1px solid var(--bs-border-color);
  background: var(--bs-secondary-bg); color: var(--bs-primary);
  font-size: 11px; cursor: pointer; text-align: center;
}
.diff-expand:hover { background: var(--bs-tertiary-bg); }
.diff-line {
  display: flex; padding: 0 8px; white-space: pre-wrap; word-break: break-all;
}
.diff-gutter {
  width: 16px; flex-shrink: 0; text-align: center; user-select: none; font-weight: 600;
}
.diff-removed {
  background: color-mix(in srgb, var(--bs-danger) 12%, transparent);
  color: color-mix(in srgb, var(--bs-danger) 80%, var(--bs-body-color));
}
.diff-removed .diff-gutter { color: var(--bs-danger); }
.diff-added {
  background: color-mix(in srgb, var(--bs-success) 12%, transparent);
  color: color-mix(in srgb, var(--bs-success) 80%, var(--bs-body-color));
}
.diff-added .diff-gutter { color: var(--bs-success); }

/* ── Tool verbose ── */
.tool-verbose {
  margin: 4px 16px; border: 1px solid var(--bs-border-color);
  border-radius: 5px; overflow: hidden; background: var(--bs-tertiary-bg);
}
.tool-verbose-header {
  display: flex; align-items: center; gap: 6px; padding: 5px 10px;
  font-size: 13px; font-weight: 500; color: var(--bs-secondary-color);
  border-bottom: 1px solid var(--bs-border-color);
}
.tool-verbose-header .bi { font-size: 12px; color: var(--bs-primary); }
.tool-verbose-body {
  padding: 8px 10px; font-size: 12px; line-height: 1.4; margin: 0;
  white-space: pre-wrap; word-break: break-all; color: var(--bs-secondary-color);
  max-height: 200px; overflow-y: auto;
}

/* ── Thinking ── */
.tool-line {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 16px; font-size: 13px; color: var(--bs-tertiary-color);
}
.tool-line .bi { font-size: 12px; }
.tool-line-label { color: var(--bs-secondary-color); }
.tool-line-detail {
  font-size: 12px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; max-width: 200px; font-style: italic;
}

/* ── Busy ── */
.busy-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 16px; font-size: 14px; color: var(--bs-tertiary-color);
}
.busy-spinner {
  width: 10px; height: 10px;
  border: 2px solid var(--bs-border-color); border-top-color: var(--bs-primary);
  border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Error ── */
.msg-error {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 16px; font-size: 14px; color: var(--bs-danger);
}

/* ── Input area ── */
.code-input-area {
  border-top: 1px solid var(--bs-border-color);
  padding: 10px 12px 12px; background: var(--bs-tertiary-bg);
  width: 100%; flex-shrink: 0;
}
.input-bottom-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 0 2px;
}
.action-btn {
  height: 32px; padding: 0 14px; border-radius: 6px;
  border: none;
  background: var(--bs-primary); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 500; cursor: pointer;
  transition: filter 0.15s;
}
.action-btn:hover { filter: brightness(1.15); }

.code-input-form {
  display: flex; align-items: flex-end; gap: 8px;
  background: var(--bs-body-bg); border: 1px solid var(--bs-border-color);
  border-radius: 8px; padding: 6px 6px 6px 12px; transition: border-color 0.15s;
}
.code-input-form:focus-within { border-color: var(--bs-primary); }
.code-input {
  flex: 1; border: none; background: transparent; color: var(--bs-body-color);
  font-size: 15px; line-height: 1.5; resize: none; overflow-y: hidden;
  outline: none; padding: 4px 0; font-family: inherit;
}
.code-input::placeholder { color: var(--bs-tertiary-color); }
.code-send-btn {
  width: 26px; height: 26px; border-radius: 6px; border: none;
  background: var(--bs-primary); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; cursor: pointer; flex-shrink: 0;
}
.code-send-btn:disabled { opacity: 0.3; cursor: default; }
.code-send-btn:not(:disabled):hover { filter: brightness(1.15); }

/* ── Mode button ── */
.mode-bar-btn {
  height: 32px; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
  font-size: 14px; color: #fff;
  padding: 0 14px; border-radius: 6px;
  border: none;
  background: var(--bs-primary);
  font-weight: 500;
  transition: filter 0.15s;
}
.mode-bar-btn:hover { filter: brightness(1.15); }
.mode-bar-model { font-weight: 500; }
.mode-bar-info { font-size: 11px; color: var(--bs-tertiary-color); margin-left: auto; }

/* ── Popups ── */
.popup-anchor { position: relative; }
.popup {
  position: absolute; bottom: calc(100% + 6px); left: 0;
  min-width: 220px; max-width: 280px;
  background: var(--bs-body-bg); border: 1px solid var(--bs-border-color);
  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  z-index: 100; overflow: hidden;
}
.modes-popup { left: 0; min-width: 260px; }
.popup-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; border-bottom: 1px solid var(--bs-border-color);
}
.popup-search { width: 100%; border: none; background: transparent; color: var(--bs-body-color); font-size: 12px; outline: none; padding: 0; }
.popup-search::placeholder { color: var(--bs-tertiary-color); }
.popup-scroll { max-height: 240px; overflow-y: auto; padding: 4px 0; }
.popup-item {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px;
  background: none; border: none; color: var(--bs-body-color); font-size: 12px; cursor: pointer; text-align: left;
}
.popup-item:hover { background: var(--bs-secondary-bg); }
.popup-item.active { color: var(--bs-primary); }
.popup-item .bi { font-size: 12px; flex-shrink: 0; }
.popup-item-desc { font-size: 10px; color: var(--bs-tertiary-color); margin-left: auto; }
.slash-name { font-weight: 500; font-family: var(--bs-font-monospace); font-size: 12px; }
.slash-popup { min-width: 300px; max-width: 360px; }
.popup-section-label { padding: 6px 10px 2px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--bs-tertiary-color); }
.popup-divider { height: 1px; background: var(--bs-border-color); margin: 4px 0; }
.popup-footer { padding: 4px 10px; font-size: 10px; color: var(--bs-tertiary-color); border-top: 1px solid var(--bs-border-color); text-align: center; }
.popup-footer-warn { color: var(--bs-warning); }
.popup-item-danger { color: var(--bs-danger); }
.popup-item-danger:hover { background: color-mix(in srgb, var(--bs-danger) 10%, transparent); }
.popup-empty { padding: 16px; text-align: center; color: var(--bs-tertiary-color); font-size: 12px; }

/* ── Markdown ── */
.chat-md { line-height: 1.6; }
.chat-md :deep(p) { margin: 0 0 8px; }
.chat-md :deep(p:last-child) { margin-bottom: 0; }
.chat-md :deep(pre) {
  background: var(--bs-tertiary-bg); border: 1px solid var(--bs-border-color);
  border-radius: 5px; padding: 10px 12px; overflow-x: auto; font-size: 13px; margin: 8px 0;
}
.chat-md :deep(code) {
  color: var(--bs-code-color, var(--bs-primary)); background: var(--bs-tertiary-bg);
  padding: 1px 4px; border-radius: 3px; font-size: 13px;
}
.chat-md :deep(pre code) { background: none; padding: 0; color: inherit; }
.chat-md :deep(ul), .chat-md :deep(ol) { padding-left: 18px; margin: 4px 0; }
.chat-md :deep(li) { margin: 2px 0; }
.chat-md :deep(h1), .chat-md :deep(h2), .chat-md :deep(h3) { font-size: 16px; font-weight: 600; margin: 12px 0 4px; }
.chat-md :deep(blockquote) { border-left: 3px solid var(--bs-border-color); padding-left: 10px; color: var(--bs-secondary-color); margin: 8px 0; }

/* ── Mobile tabs ── */
.mobile-tabs { display: none; }
.mobile-tab {
  flex: 1; padding: 6px; border: none; border-radius: 6px;
  background: var(--bs-secondary-bg); color: var(--bs-tertiary-color);
  font-size: 12px; font-weight: 500; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 4px;
}
.mobile-tab.active { background: var(--bs-primary); color: #fff; }

/* ── Responsive: small screens ── */
@media (max-width: 768px) {
  .chat-side { flex: none; width: 100%; height: 100%; }
  .pane-side { flex: none; width: 100%; height: 100%; }
  .mobile-hidden { display: none !important; }
  .pane-toggle { display: none; }
  .mobile-tabs {
    display: flex; gap: 4px; margin-bottom: 8px;
  }
  .pane-mobile-back { display: flex; }
}
</style>
