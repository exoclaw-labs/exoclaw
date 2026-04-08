<script setup lang="ts">
import { ref, nextTick, computed, watch, onMounted, onUnmounted } from "vue";
import { marked } from "marked";
import { fetchConfig, saveConfig } from "../composables/useApi";

const pane = ref("");
const input = ref("");
const busy = ref(false);
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
const historyBtnEl = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setInterval>;

// ── Pane polling ──
function scrollBottom() {
  nextTick(() => { if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight; });
}

async function loadPane() {
  try {
    const content = (await (await fetch("/api/session/pane?lines=300")).json()).content || "";
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
const showHistory = ref(false);
const historyPopupStyle = ref<Record<string, string>>({});

function toggleHistory() {
  showHistory.value = !showHistory.value;
  if (showHistory.value) {
    loadSessions();
    nextTick(() => {
      if (historyBtnEl.value) {
        const rect = historyBtnEl.value.getBoundingClientRect();
        historyPopupStyle.value = {
          top: `${rect.bottom + 4}px`,
          right: `${window.innerWidth - rect.right}px`,
        };
      }
    });
  }
}

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

async function clearHistory() {
  closeAllPopups();
  try { await fetch("/api/sessions", { method: "DELETE" }); } catch {}
  sessions.value = [];
}

// ── Slash commands ──
const showSlash = ref(false);
const customSkills = ref<{ name: string; content: string }[]>([]);
const slashFilter = ref("");
const LOCAL_COMMANDS = new Set(["model"]);
const CLI_COMMANDS = new Set([
  "compact", "cost", "status", "help", "diff", "plan", "review",
  "security-review", "context", "effort", "fast", "rewind", "usage",
  "permissions", "mcp", "hooks", "agents", "init", "doctor",
]);

const nativeCommands = [
  { name: "compact", desc: "Compact conversation to save context", icon: "bi-arrows-collapse" },
  { name: "model", desc: "Change the AI model", icon: "bi-cpu" },
  { name: "cost", desc: "Show token usage statistics", icon: "bi-cash-coin" },
  { name: "status", desc: "Show version, model, account info", icon: "bi-info-circle" },
  { name: "help", desc: "Show help and available commands", icon: "bi-question-circle" },
  { name: "diff", desc: "View uncommitted changes", icon: "bi-file-diff" },
  { name: "review", desc: "Review code changes", icon: "bi-search" },
  { name: "plan", desc: "Enter plan mode", icon: "bi-map" },
  { name: "effort", desc: "Set model effort level", icon: "bi-speedometer" },
  { name: "context", desc: "Visualize context usage", icon: "bi-pie-chart" },
  { name: "fast", desc: "Toggle fast mode", icon: "bi-lightning-charge" },
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
    if (name === "model") { showModes.value = true; showSlash.value = false; }
    return true;
  }
  if (CLI_COMMANDS.has(name)) { sendKeys(`"/${name}" Enter`); return true; }
  return false;
}

function selectCommand(name: string) {
  closeAllPopups();
  if (handleSlashCommand(name)) return;
  input.value = `/${name}`;
  nextTick(() => { inputEl.value?.focus(); handleSend(); });
}

// ── File upload ──
const fileInputEl = ref<HTMLInputElement | null>(null);
function triggerFileUpload() { closeAllPopups(); fileInputEl.value?.click(); }
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

function renderMd(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

function closeAllPopups() { showSlash.value = false; showModes.value = false; showHistory.value = false; slashFilter.value = ""; }
function onDocClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (!el.closest(".popup-anchor") && !el.closest(".history-popup")) closeAllPopups();
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

// ── Parse tmux pane into chat blocks ──
interface ChatBlock {
  type: "user" | "assistant" | "tool" | "diff" | "thinking" | "status";
  content: string;
  file?: string;      // for diff blocks
  added?: string[];   // diff added lines
  removed?: string[]; // diff removed lines
}

const expandedBlocks = ref<Set<number>>(new Set());
function toggleBlock(idx: number) {
  if (expandedBlocks.value.has(idx)) expandedBlocks.value.delete(idx);
  else expandedBlocks.value.add(idx);
}

const chatBlocks = computed((): ChatBlock[] => {
  const raw = pane.value;
  if (!raw) return [];
  const lines = raw.split("\n");
  const blocks: ChatBlock[] = [];
  let i = 0;

  // TUI noise: dividers, status bars, prompts, UI chrome, startup banner
  const isNoise = (l: string) =>
    /^[─━╌╍┄┅┈┉\u2500\u2501]{3,}/.test(l) ||
    /^[╭╰│╮╯┌└┐┘├┤┬┴┼]/.test(l) ||
    /^\s*[·•✻✶✷✸✹✺✽⊹⋆∗⁕※☆★]\s+\w/.test(l) ||
    /bypass permissions/i.test(l) ||
    /Remote Control/i.test(l) ||
    /\/remote-control is active/.test(l) ||
    /shift\+tab to cycle/.test(l) ||
    /ctrl\+o to expand/.test(l) ||
    /\? for shortcu/.test(l) ||
    /Please upgrade/.test(l) ||
    /Claude Code has switched.*native installer/.test(l) ||
    /Run `claude install`/.test(l) ||
    /tmux detected.*PgUp\/PgDn/.test(l) ||
    /set -g mouse on.*\.tmux\.conf/.test(l) ||
    /^\s*⏵⏵/.test(l) ||
    /[▐▛▜▌▝▘█]/.test(l) ||
    /[◐◑◒◓]\s*(low|medium|high|max)\s*·\s*\/effort/.test(l) ||
    /^\s*\d+\.\d+\.\d+\s/.test(l) || // version banners
    /^Session:/.test(l) ||
    /^Model:/.test(l) ||
    /^Context:/.test(l) ||
    /^Cost:/.test(l) ||
    // Startup banner lines
    /Claude Code\s+v/i.test(l) ||
    /Claude Max/i.test(l) ||
    /Claude Pro/i.test(l) ||
    /Claude Team/i.test(l) ||
    /Claude Enterprise/i.test(l) ||
    /^\s*~\//.test(l) ||             // working directory line (~/workspace)
    /^\s*Tips:/.test(l) ||
    /^\s*Tip:/.test(l) ||
    /press Enter to send/i.test(l) ||
    /Sonnet \d|Opus \d|Haiku \d/i.test(l) ||
    /^Resume Session/i.test(l) ||
    /^Type to search/i.test(l) ||
    /^\s*\/\w+\s*$/.test(l);

  const isToolLine = (l: string) =>
    /^\s{2}(Edited|Ran|Read|Wrote|Listed|Searched|Created|Deleted|Fetched|Glob|Grep)\s/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    // User prompt: ❯ text (skip bare slash commands like /remote-control)
    if (/^❯\s+\S/.test(line)) {
      const cmd = line.replace(/^❯\s+/, "");
      if (/^\/[\w-]+\s*$/.test(cmd)) { i++; continue; }
      blocks.push({ type: "user", content: cmd });
      i++;
      continue;
    }

    // Idle prompt — skip
    if (/^❯\s*$/.test(line)) { i++; continue; }

    // Tool use line
    const toolMatch = line.match(/^\s{2}(Edited|Ran|Read|Wrote|Listed|Searched|Created|Deleted|Fetched|Glob|Grep)\s+(.*)/);
    if (toolMatch) {
      const toolName = toolMatch[1];
      const detail = toolMatch[2];

      // Collect ⎿ output lines following the tool
      let j = i + 1;
      const outputLines: string[] = [];
      while (j < lines.length && /^\s{2}⎿/.test(lines[j])) {
        outputLines.push(lines[j].replace(/^\s{2}⎿\s?/, ""));
        j++;
      }

      // Edit tools: parse as diff
      if (toolName === "Edited" || toolName === "Wrote") {
        const added: string[] = [];
        const removed: string[] = [];
        for (const ol of outputLines) {
          if (/^\s*\+/.test(ol)) added.push(ol.replace(/^\s*\+\s?/, ""));
          else if (/^\s*-/.test(ol)) removed.push(ol.replace(/^\s*-\s?/, ""));
        }
        if (added.length || removed.length) {
          blocks.push({ type: "diff", content: `${toolName} ${detail}`, file: detail, added, removed });
        } else {
          blocks.push({ type: "tool", content: `${toolName} ${detail}` });
        }
      } else {
        blocks.push({ type: "tool", content: `${toolName} ${detail}` });
      }
      i = j;
      continue;
    }

    // Thinking indicator — skip (but NOT ● which marks assistant response start)
    if (/\(thinking\)/.test(line)) { i++; continue; }

    // Empty line — skip (but preserve inside assistant blocks below)
    if (!line.trim()) { i++; continue; }

    // Noise — skip
    if (isNoise(line)) { i++; continue; }

    // Assistant text — collect consecutive lines, preserving structure
    const textLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (/^❯/.test(l)) break;
      if (isToolLine(l)) break;
      if (isNoise(l)) { i++; continue; }
      if (/\(thinking\)/.test(l)) { i++; continue; }
      // Strip TUI bullet prefix but preserve the text
      const cleaned = l.replace(/^●\s*/, "").replace(/^\s{2}⎿\s*/, "  ");
      textLines.push(cleaned);
      i++;
    }
    // Trim trailing empty lines, preserve internal structure
    while (textLines.length && !textLines[textLines.length - 1].trim()) textLines.pop();
    while (textLines.length && !textLines[0].trim()) textLines.shift();
    if (textLines.length) {
      blocks.push({ type: "assistant", content: textLines.join("\n") });
    }
  }

  return blocks;
});

watch(chatBlocks, scrollBottom);
onMounted(() => {
  loadPane(); loadConfig(); loadSkills();
  timer = setInterval(loadPane, 2000);
  window.addEventListener("keydown", onWindowKeydown);
  document.addEventListener("click", onDocClick);
});
onUnmounted(() => {
  clearInterval(timer);
  window.removeEventListener("keydown", onWindowKeydown);
  document.removeEventListener("click", onDocClick);
});
</script>

<template>
  <div class="chat-panel d-flex flex-column h-100">
    <!-- Header -->
    <div class="chat-header">
      <div></div>
      <div class="d-flex align-items-center gap-2">
        <button ref="historyBtnEl" class="btn btn-primary btn-sm header-action-btn" @click.stop="toggleHistory" title="History">
          <i class="bi bi-clock-history"></i>
        </button>
        <Teleport to="body">
          <div v-if="showHistory" class="history-popup" :style="historyPopupStyle" @click.stop>
            <div class="popup-section-label">Sessions</div>
            <div class="popup-scroll" style="max-height:260px">
              <button v-for="s in sessions" :key="s.uuid" class="popup-item"
                :class="{ active: s.uuid === activeSessionId }"
                @click="switchSession(s.uuid); showHistory = false">
                <i class="bi bi-chat-left-text"></i>
                <span class="session-title">{{ s.title || s.uuid?.slice(0, 8) }}</span>
                <span class="popup-item-desc">{{ s.message_count }}msg</span>
                <i v-if="s.uuid === activeSessionId" class="bi bi-check2 ms-auto"></i>
              </button>
              <div v-if="!sessions.length" class="popup-empty">No sessions</div>
            </div>
            <div v-if="sessions.length" class="popup-divider"></div>
            <button v-if="sessions.length" class="popup-item popup-item-danger" @click="clearHistory">
              <i class="bi bi-trash3"></i>
              <span>Clear history</span>
            </button>
          </div>
        </Teleport>
        <button class="btn btn-primary btn-sm header-action-btn" @click="freshSession" title="New chat">
          <i class="bi bi-chat-dots"></i>
        </button>
      </div>
    </div>

    <!-- Messages -->
    <div ref="scrollEl" class="flex-grow-1 overflow-auto chat-messages" style="min-height:0">
      <div v-if="!chatBlocks.length" class="h-100 d-flex flex-column align-items-center justify-content-center text-body-secondary px-4">
        <i class="bi bi-chat-dots" style="font-size:40px;opacity:0.12"></i>
        <p class="mt-2 mb-0 small text-center" style="max-width:260px">Ask {{ agentName }} to write code, fix bugs, refactor, or explain.</p>
      </div>

      <template v-for="(b, i) in chatBlocks" :key="i">
        <!-- User bubble (right) -->
        <div v-if="b.type === 'user'" class="bubble-row bubble-right">
          <div class="bubble bubble-user">{{ b.content }}</div>
        </div>

        <!-- Assistant bubble (left) -->
        <div v-else-if="b.type === 'assistant'" class="bubble-row bubble-left">
          <div class="bubble bubble-assistant">
            <div v-html="renderMd(b.content)" class="chat-md"></div>
          </div>
        </div>

        <!-- Tool pill (center) -->
        <div v-else-if="b.type === 'tool'" class="tool-pill">
          <i class="bi" :class="{
            'bi-terminal': /Ran/.test(b.content),
            'bi-file-earmark-text': /Read/.test(b.content),
            'bi-search': /Searched|Glob|Grep|Listed/.test(b.content),
            'bi-pencil-square': /Edited|Wrote/.test(b.content),
            'bi-wrench': true,
          }"></i>
          <span>{{ b.content }}</span>
        </div>

        <!-- Diff (compact, expandable) -->
        <div v-else-if="b.type === 'diff'" class="diff-pill">
          <div class="diff-pill-header" @click="toggleBlock(i)">
            <i class="bi bi-pencil-square"></i>
            <span class="diff-pill-file">{{ (b.file || '').split('/').pop() }}</span>
            <span class="diff-pill-counts">
              <span v-if="b.removed?.length" class="diff-count-rm">-{{ b.removed.length }}</span>
              <span v-if="b.added?.length" class="diff-count-add">+{{ b.added.length }}</span>
            </span>
            <i class="bi ms-auto" :class="expandedBlocks.has(i) ? 'bi-chevron-up' : 'bi-chevron-down'" style="font-size:10px"></i>
          </div>
          <div v-if="expandedBlocks.has(i)" class="diff-pill-body">
            <div v-for="(line, li) in (b.removed || [])" :key="'r'+li" class="diff-line diff-removed">
              <span class="diff-gutter">-</span><span>{{ line }}</span>
            </div>
            <div v-for="(line, li) in (b.added || [])" :key="'a'+li" class="diff-line diff-added">
              <span class="diff-gutter">+</span><span>{{ line }}</span>
            </div>
          </div>
        </div>
      </template>

      <div v-if="busy" class="tool-pill">
        <span class="busy-spinner"></span>
        <span>Working...</span>
      </div>
    </div>

    <!-- Input area -->
    <div class="chat-input-area">
      <input ref="fileInputEl" type="file" multiple accept=".txt,.md,.ts,.js,.tsx,.jsx,.json,.yml,.yaml,.py,.sh,.css,.html,.xml,.csv,.sql,.rs,.go,.java,.c,.cpp,.h,.rb,.php,.swift,.kt,.toml,.ini,.cfg,.env,.log" style="display:none" @change="handleFileUpload" />

      <form @submit.prevent="handleSend" class="chat-input-form">
        <textarea ref="inputEl" v-model="input" :disabled="busy"
          :placeholder="`Message ${agentName}...`" autofocus rows="1" class="chat-input"
          @keydown="handleKeydown" @input="autoResize"></textarea>
        <button type="submit" class="chat-send-btn" :disabled="busy || !input.trim()">
          <i class="bi bi-arrow-up"></i>
        </button>
      </form>

      <div class="input-bottom-bar">
        <button class="action-btn" @click="triggerFileUpload" title="Upload file"><i class="bi bi-plus-lg"></i></button>
        <div class="popup-anchor">
          <button class="action-btn" @click.stop="showSlash = !showSlash; showModes = false" title="Commands"><i class="bi bi-slash"></i></button>
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
.chat-panel {
  background: var(--bs-body-bg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

/* ── Header ── */
.chat-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--bs-border-color); background: var(--bs-tertiary-bg);
  flex-shrink: 0; position: relative; z-index: 1050; overflow: visible;
}
.status-text { font-size: 11px; color: var(--bs-tertiary-color); }
.header-action-btn {
  font-size: 14px; padding: 4px 10px; line-height: 1;
}
.history-popup {
  position: fixed; min-width: 240px; z-index: 1050;
  background: var(--bs-body-bg); border: 1px solid var(--bs-border-color);
  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25); overflow: hidden;
}

/* ── Messages area ── */
.chat-messages { padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; }

/* ── Bubble layout ── */
.bubble-row { display: flex; }
.bubble-right { justify-content: flex-end; }
.bubble-left { justify-content: flex-start; }

.bubble {
  max-width: 80%; padding: 8px 12px; border-radius: 14px;
  font-size: 14px; line-height: 1.5; word-break: break-word;
}
.bubble-user {
  background: var(--bs-primary); color: #fff;
  border-bottom-right-radius: 4px;
  white-space: pre-wrap;
}
.bubble-assistant {
  background: var(--bs-tertiary-bg); color: var(--bs-body-color);
  border-bottom-left-radius: 4px;
}

/* ── Tool pills (centered) ── */
.tool-pill {
  display: flex; align-items: center; gap: 6px; align-self: center;
  padding: 3px 10px; border-radius: 12px;
  background: var(--bs-secondary-bg);
  font-size: 11px; color: var(--bs-tertiary-color);
  max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tool-pill .bi { font-size: 10px; }

/* ── Diff pills ── */
.diff-pill {
  align-self: center; width: 80%; max-width: 400px;
  border: 1px solid var(--bs-border-color); border-radius: 8px;
  overflow: hidden; background: var(--bs-tertiary-bg);
}
.diff-pill-header {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; font-size: 12px; cursor: pointer; user-select: none;
}
.diff-pill-header:hover { background: var(--bs-secondary-bg); }
.diff-pill-header .bi { font-size: 11px; color: var(--bs-warning); }
.diff-pill-file { font-weight: 500; color: var(--bs-emphasis-color); font-family: var(--bs-font-monospace); font-size: 11px; }
.diff-pill-counts { display: flex; gap: 4px; font-size: 10px; font-weight: 600; font-family: var(--bs-font-monospace); }
.diff-count-rm { color: var(--bs-danger); }
.diff-count-add { color: var(--bs-success); }
.diff-pill-body {
  border-top: 1px solid var(--bs-border-color);
  font-family: var(--bs-font-monospace); font-size: 11px; line-height: 1.5;
  max-height: 200px; overflow-y: auto;
}
.diff-line { display: flex; padding: 0 8px; white-space: pre-wrap; word-break: break-all; }
.diff-gutter { width: 14px; flex-shrink: 0; text-align: center; user-select: none; font-weight: 600; }
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

/* ── Busy ── */
.busy-spinner {
  width: 10px; height: 10px;
  border: 2px solid var(--bs-border-color); border-top-color: var(--bs-primary);
  border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Input area ── */
.chat-input-area {
  border-top: 1px solid var(--bs-border-color);
  padding: 10px 12px 12px; background: var(--bs-tertiary-bg);
  width: 100%; flex-shrink: 0;
}
.input-bottom-bar { display: flex; align-items: center; gap: 6px; padding: 8px 0 2px; }
.action-btn {
  height: 32px; padding: 0 14px; border-radius: 6px; border: none;
  background: var(--bs-primary); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 500; cursor: pointer; transition: filter 0.15s;
}
.action-btn:hover { filter: brightness(1.15); }

.chat-input-form {
  display: flex; align-items: flex-end; gap: 8px;
  background: var(--bs-body-bg); border: 1px solid var(--bs-border-color);
  border-radius: 8px; padding: 6px 6px 6px 12px; transition: border-color 0.15s;
}
.chat-input-form:focus-within { border-color: var(--bs-primary); }
.chat-input {
  flex: 1; border: none; background: transparent; color: var(--bs-body-color);
  font-size: 15px; line-height: 1.5; resize: none; overflow-y: hidden;
  outline: none; padding: 4px 0; font-family: inherit;
}
.chat-input::placeholder { color: var(--bs-tertiary-color); }
.chat-send-btn {
  width: 26px; height: 26px; border-radius: 6px; border: none;
  background: var(--bs-primary); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; cursor: pointer; flex-shrink: 0;
}
.chat-send-btn:disabled { opacity: 0.3; cursor: default; }
.chat-send-btn:not(:disabled):hover { filter: brightness(1.15); }

/* ── Mode button ── */
.mode-bar-btn {
  height: 32px; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
  font-size: 14px; color: #fff; padding: 0 14px; border-radius: 6px;
  border: none; background: var(--bs-primary); font-weight: 500; transition: filter 0.15s;
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

/* ── Markdown in bubbles ── */
.chat-md { line-height: 1.5; }
.chat-md :deep(p) { margin: 0 0 6px; }
.chat-md :deep(p:last-child) { margin-bottom: 0; }
.chat-md :deep(pre) {
  background: rgba(0,0,0,0.15); border-radius: 5px;
  padding: 8px 10px; overflow-x: auto; font-size: 12px; margin: 6px 0;
}
.chat-md :deep(code) {
  color: var(--bs-code-color, var(--bs-primary)); background: rgba(0,0,0,0.1);
  padding: 1px 4px; border-radius: 3px; font-size: 12px;
}
.chat-md :deep(pre code) { background: none; padding: 0; color: inherit; }
.chat-md :deep(ul), .chat-md :deep(ol) { padding-left: 16px; margin: 4px 0; }
.chat-md :deep(li) { margin: 2px 0; }
.chat-md :deep(h1), .chat-md :deep(h2), .chat-md :deep(h3) { font-size: 15px; font-weight: 600; margin: 8px 0 4px; }
.chat-md :deep(blockquote) { border-left: 3px solid var(--bs-border-color); padding-left: 8px; color: var(--bs-secondary-color); margin: 6px 0; }
</style>
