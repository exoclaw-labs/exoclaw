<script setup lang="ts">
import { ref, nextTick, computed, watch, onMounted, onUnmounted } from "vue";
import { fetchConfig, saveConfig } from "../composables/useApi";

const pane = ref("");
const input = ref("");
const busy = ref(false);
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
let timer: ReturnType<typeof setInterval>;

// ── Pane polling ──
function scrollBottom() {
  nextTick(() => { if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight; });
}

async function loadPane() {
  try {
    const content = (await (await fetch("/api/session/pane")).json()).content || "";
    if (content !== pane.value) pane.value = content;
  } catch {}
}

async function sendKeys(keys: string) {
  busy.value = true;
  await fetch("/api/session/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys }),
  });
  await new Promise(r => setTimeout(r, 500));
  await loadPane();
  busy.value = false;
  nextTick(() => inputEl.value?.focus());
}

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
  try { await fetch("/api/session/restart", { method: "POST" }); } catch {}
  restartNeeded.value = false;
}

async function freshSession() {
  closeAllPopups();
  try { await fetch("/api/session/fresh", { method: "POST" }); } catch {}
  restartNeeded.value = false;
}

// ── Session switcher ──
const sessions = ref<Array<{ uuid: string; title: string | null; started_at: string; message_count: number }>>([]);
const activeSessionId = ref<string | null>(null);

async function loadSessions() {
  try {
    const data = await (await fetch("/api/sessions?limit=15")).json();
    sessions.value = data.sessions || [];
    activeSessionId.value = data.activeSessionId;
  } catch {}
}

async function switchSession(uuid: string) {
  closeAllPopups();
  try { await fetch("/api/session/switch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: uuid }),
  }); } catch {}
}

// ── Slash commands (native + skills) ──
const showSlash = ref(false);
const customSkills = ref<{ name: string; content: string }[]>([]);
const slashFilter = ref("");

const LOCAL_COMMANDS = new Set(["clear", "model"]);

const CLI_COMMANDS = new Set([
  "compact", "cost", "status", "help", "diff", "plan", "review",
  "security-review", "context", "effort", "fast", "rewind", "usage",
  "permissions", "mcp", "hooks", "agents", "init", "doctor",
]);

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

function handleSlashCommand(name: string): boolean {
  if (LOCAL_COMMANDS.has(name)) {
    if (name === "model") {
      showModes.value = true;
      showSlash.value = false;
    }
    return true;
  }
  if (CLI_COMMANDS.has(name)) {
    sendKeys(`"/${name}" Enter`);
    return true;
  }
  return false;
}

function selectCommand(name: string) {
  closeAllPopups();
  if (handleSlashCommand(name)) return;
  input.value = `/${name}`;
  nextTick(() => { inputEl.value?.focus(); handleSend(); });
}

// ── File upload (+) ──
const fileInputEl = ref<HTMLInputElement | null>(null);

function triggerFileUpload() {
  closeAllPopups();
  fileInputEl.value?.click();
}

function handleFileUpload(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files) return;
  for (const file of Array.from(files)) {
    if (file.size > 1024 * 1024) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result as string;
      const tag = `[File: ${file.name}]\n\`\`\`\n${content.slice(0, 10000)}\n\`\`\``;
      input.value = input.value ? `${input.value}\n\n${tag}` : tag;
      nextTick(() => { autoResize(); inputEl.value?.focus(); });
    };
    reader.readAsText(file);
  }
  if (fileInputEl.value) fileInputEl.value.value = "";
}

// ── Input helpers ──
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

  const slashMatch = text.match(/^\/(\S+)$/);
  if (slashMatch && handleSlashCommand(slashMatch[1])) return;

  sendKeys(`"${text.replace(/"/g, '\\"')}" Enter`);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  if (e.key === "/" && !input.value) { e.preventDefault(); showSlash.value = true; showModes.value = false; }
}

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

const currentModel = computed(() => {
  const m = config.value?.claude?.model || "";
  return m.replace("claude-", "").replace(/-\d+$/, "") || "—";
});

watch(pane, scrollBottom);
onMounted(() => {
  loadPane(); loadConfig(); loadSkills();
  timer = setInterval(loadPane, 2000);
  window.addEventListener("keydown", onWindowKeydown);
  document.addEventListener("click", onDocClick);
});
/** Strip the Claude Code input prompt area from pane output.
 *  Removes the trailing block: ────, ❯ prompt, ────, ⏵⏵ permissions line */
const paneDisplay = computed(() => {
  const raw = pane.value;
  if (!raw) return "";
  const lines = raw.split("\n");
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯/.test(lines[i])) { promptIdx = i; break; }
  }
  if (promptIdx === -1) return lines.filter(l => l.trim() !== "").join("\n");
  let startIdx = promptIdx;
  for (let i = promptIdx - 1; i >= 0; i--) {
    if (/^[─━─\u2500\u2501]{4,}/.test(lines[i])) { startIdx = i; break; }
  }
  return lines.slice(0, startIdx).filter(l => l.trim() !== "").join("\n");
});

onUnmounted(() => {
  clearInterval(timer);
  window.removeEventListener("keydown", onWindowKeydown);
  document.removeEventListener("click", onDocClick);
});
</script>

<template>
  <div class="console-panel d-flex flex-column h-100">
    <!-- Header -->
    <div class="console-header">
      <div class="d-flex align-items-center gap-2">
        <i class="bi bi-braces text-primary" style="font-size:14px"></i>
        <span class="fw-semibold" style="font-size:12px">Code</span>
      </div>
      <div class="d-flex align-items-center gap-2">
        <button class="header-btn" @click="loadPane" title="Refresh"><i class="bi bi-arrow-clockwise"></i></button>
      </div>
    </div>

    <!-- Pane -->
    <div ref="scrollEl" class="flex-grow-1 overflow-auto p-0" style="min-height:0">
      <pre class="pane-content">{{ paneDisplay || 'Loading...' }}</pre>
    </div>

    <!-- Quick keys -->
    <div class="quick-keys">
      <button class="qk-btn" :disabled="busy" @click="sendKeys('Enter')">Enter</button>
      <button class="qk-btn" :disabled="busy" @click="sendKeys('Up')"><i class="bi bi-arrow-up"></i></button>
      <button class="qk-btn" :disabled="busy" @click="sendKeys('Down')"><i class="bi bi-arrow-down"></i></button>
      <button class="qk-btn" :disabled="busy" @click="sendKeys('Escape')">Esc</button>
      <button class="qk-btn" :disabled="busy" @click="sendKeys('Tab')">Tab</button>
    </div>

    <!-- Input area (same as Code view) -->
    <div class="console-input-area">
      <input ref="fileInputEl" type="file" multiple accept=".txt,.md,.ts,.js,.tsx,.jsx,.json,.yml,.yaml,.py,.sh,.css,.html,.xml,.csv,.sql,.rs,.go,.java,.c,.cpp,.h,.rb,.php,.swift,.kt,.toml,.ini,.cfg,.env,.log" style="display:none" @change="handleFileUpload" />

      <form @submit.prevent="handleSend" class="code-input-form">
        <textarea ref="inputEl" v-model="input" :disabled="busy"
          :placeholder="`Send to ${agentName}...`" autofocus rows="1" class="code-input"
          @keydown="handleKeydown" @input="autoResize"></textarea>
        <button type="submit" class="code-send-btn" :disabled="busy || !input.trim()">
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
          <button class="mode-bar-btn" @click.stop="showModes = !showModes; showSlash = false; if (showModes) loadSessions()">
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
            <div class="popup-section-label">Sessions</div>
            <div class="popup-scroll" style="max-height:140px">
              <button v-for="s in sessions" :key="s.uuid" class="popup-item"
                :class="{ active: s.uuid === activeSessionId }"
                @click="switchSession(s.uuid)">
                <i class="bi bi-chat-left-text"></i>
                <span class="session-title">{{ s.title || s.uuid?.slice(0, 8) }}</span>
                <span class="popup-item-desc">{{ s.message_count }}msg</span>
                <i v-if="s.uuid === activeSessionId" class="bi bi-check2 ms-auto"></i>
              </button>
              <div v-if="!sessions.length" class="popup-empty">No sessions</div>
            </div>
            <div class="popup-divider"></div>
            <div class="popup-section-label">Controls</div>
            <button class="popup-item" @click="toggleRemoteControl">
              <i class="bi bi-broadcast"></i>
              <span>Remote control</span>
              <i class="bi ms-auto" :class="remoteControlEnabled ? 'bi-toggle-on text-success' : 'bi-toggle-off'"></i>
            </button>
            <button class="popup-item" @click="restartSession">
              <i class="bi bi-arrow-clockwise"></i>
              <span>Restart session</span>
            </button>
            <button class="popup-item popup-item-danger" @click="freshSession">
              <i class="bi bi-plus-circle"></i>
              <span>New session</span>
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
.console-panel {
  background: var(--bs-body-bg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

/* ── Header ── */
.console-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--bs-border-color); background: var(--bs-tertiary-bg);
  flex-shrink: 0;
}
.header-btn {
  background: none; border: none; color: var(--bs-tertiary-color);
  font-size: 12px; padding: 2px 6px; cursor: pointer; border-radius: 3px;
}
.header-btn:hover { color: var(--bs-secondary-color); background: var(--bs-secondary-bg); }

/* ── Pane ── */
.pane-content {
  padding: 12px 16px; margin: 0;
  font-family: "SF Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", var(--bs-font-monospace);
  font-size: 13px; line-height: 1.45; color: var(--bs-body-color);
  white-space: pre-wrap; word-break: break-all;
}

/* ── Quick keys ── */
.quick-keys {
  display: flex; flex-wrap: wrap; gap: 4px;
  padding: 6px 12px; border-top: 1px solid var(--bs-border-color);
  background: var(--bs-tertiary-bg); flex-shrink: 0;
}
.qk-btn {
  height: 26px; padding: 0 10px; border-radius: 4px;
  border: 1px solid var(--bs-border-color);
  background: var(--bs-secondary-bg); color: var(--bs-secondary-color);
  font-size: 11px; font-weight: 500; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.qk-btn:hover { background: var(--bs-tertiary-bg); color: var(--bs-emphasis-color); }
.qk-btn:disabled { opacity: 0.4; cursor: default; }

/* ── Input area ── */
.console-input-area {
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
.session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
.slash-popup { min-width: 300px; max-width: 360px; }
.popup-section-label { padding: 6px 10px 2px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--bs-tertiary-color); }
.popup-divider { height: 1px; background: var(--bs-border-color); margin: 4px 0; }
.popup-footer { padding: 4px 10px; font-size: 10px; color: var(--bs-tertiary-color); border-top: 1px solid var(--bs-border-color); text-align: center; }
.popup-footer-warn { color: var(--bs-warning); }
.popup-item-danger { color: var(--bs-danger); }
.popup-item-danger:hover { background: color-mix(in srgb, var(--bs-danger) 10%, transparent); }
.popup-empty { padding: 16px; text-align: center; color: var(--bs-tertiary-color); font-size: 12px; }
</style>
