<script setup lang="ts">
import { ref, nextTick, computed, watch, onMounted, onUnmounted } from "vue";
import { marked } from "marked";
import { fetchConfig, saveConfig, fetchStatus } from "../composables/useApi";

// ── Message types ──
interface ToolEntry {
  kind: "tool" | "thinking";
  name?: string;
  args?: string;       // raw JSON string
  content?: string;    // for thinking
}

interface ChatMessage {
  type: "user" | "assistant" | "activity" | "error";
  content: string;
  tools?: ToolEntry[];
}

const messages = ref<ChatMessage[]>([]);
const input = ref("");
const busy = ref(false);
const connected = ref(false);
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
const historyBtnEl = ref<HTMLElement | null>(null);
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ── Scrollback limit (from CHAT_SCROLLBACK env var via config API) ──
const maxScrollback = ref(5000);

function trimScrollback() {
  if (messages.value.length > maxScrollback.value) {
    messages.value.splice(0, messages.value.length - maxScrollback.value);
  }
}

// ── Activity detail modal ──
const modalActivity = ref<ChatMessage | null>(null);
function openActivityModal(m: ChatMessage) { modalActivity.value = m; }
function closeModal() { modalActivity.value = null; }

// ── Tool helpers ──
function toolIcon(name: string): string {
  if (/Bash|bash/i.test(name)) return "bi-terminal";
  if (/Read/i.test(name)) return "bi-file-earmark-text";
  if (/Grep|Glob|Search/i.test(name)) return "bi-search";
  if (/Edit/i.test(name)) return "bi-pencil-square";
  if (/Write/i.test(name)) return "bi-file-earmark-plus";
  if (/WebFetch|WebSearch/i.test(name)) return "bi-globe";
  if (/Agent/i.test(name)) return "bi-people";
  if (/ToolSearch/i.test(name)) return "bi-wrench";
  if (/mcp/i.test(name)) return "bi-plug";
  return "bi-gear";
}

/** Compact pill label like "Bash x2, Edit" capped at ~30 chars */
function pillLabel(tools: ToolEntry[]): string {
  const toolCalls = tools.filter(t => t.kind === "tool");
  if (toolCalls.length === 0) return "Thinking";
  const counts = new Map<string, number>();
  for (const t of toolCalls) {
    const n = (t.name || "tool").replace(/^mcp__.*__/, "");
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  let result = "";
  for (const [n, c] of counts) {
    const part = c > 1 ? `${n} x${c}` : n;
    if (result) {
      if (result.length + 2 + part.length > 30) { result += ", …"; break; }
      result += ", ";
    }
    result += part;
  }
  return result;
}

/** Check if a tool entry has "large" content (long diff or output) */
function isLargeTool(t: ToolEntry): boolean {
  if (t.kind !== "tool") return false;
  const args = parseArgs(t.args);
  if (!args) return false;
  const hasLongDiff = !!(args.old_string && args.old_string.length > 200);
  const hasLongCmd = !!(args.command && args.command.length > 300);
  return hasLongDiff || hasLongCmd;
}

/** Try to parse tool args as JSON, return key/value pairs for display. */
function parseArgs(raw?: string): Record<string, string> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return out;
  } catch { return null; }
}

/** Check if a tool entry is an Edit with old_string/new_string. */
function isEditDiff(t: ToolEntry): boolean {
  if (t.kind !== "tool" || !/Edit/i.test(t.name || "")) return false;
  const args = parseArgs(t.args);
  return !!(args && args.old_string && args.new_string);
}

function getEditStrings(t: ToolEntry): { old: string; new: string; file: string } {
  const args = parseArgs(t.args) || {};
  return {
    old: args.old_string || "",
    new: args.new_string || "",
    file: (args.file_path || "").split("/").pop() || "file",
  };
}

// ── Scrolling ──
function scrollBottom() {
  nextTick(() => { if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight; });
}

// ── WebSocket ──
function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/chat`;
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    connected.value = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  ws.onclose = () => {
    connected.value = false;
    busy.value = false;
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => { ws?.close(); };

  ws.onmessage = (ev) => {
    let msg: any;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case "session_start":
        break;

      case "chunk": {
        const last = messages.value[messages.value.length - 1];
        if (last && last.type === "assistant") {
          last.content += msg.content;
        } else {
          messages.value.push({ type: "assistant", content: msg.content });
        }
        scrollBottom();
        break;
      }

      case "thinking": {
        // Group into current activity block
        const last = messages.value[messages.value.length - 1];
        if (last && last.type === "activity") {
          const lastEntry = last.tools![last.tools!.length - 1];
          if (lastEntry && lastEntry.kind === "thinking") {
            lastEntry.content = (lastEntry.content || "") + msg.content;
          } else {
            last.tools!.push({ kind: "thinking", content: msg.content });
          }
        } else {
          messages.value.push({ type: "activity", content: "", tools: [{ kind: "thinking", content: msg.content }] });
        }
        scrollBottom();
        break;
      }

      case "tool_call": {
        const entry: ToolEntry = { kind: "tool", name: msg.name, args: msg.args };
        const last = messages.value[messages.value.length - 1];
        if (isLargeTool(entry)) {
          // Large diffs/outputs get their own standalone pill
          messages.value.push({ type: "activity", content: "", tools: [entry] });
        } else if (last && last.type === "activity") {
          last.tools!.push(entry);
        } else {
          messages.value.push({ type: "activity", content: "", tools: [entry] });
        }
        scrollBottom();
        break;
      }

      case "tool_result":
        // Tool results are informational — skip (don't add to activity pane)
        break;

      case "done":
        busy.value = false;
        trimScrollback();
        scrollBottom();
        break;

      case "error":
        messages.value.push({ type: "error", content: msg.message || "Unknown error" });
        busy.value = false;
        scrollBottom();
        break;

      case "queued":
        break;
    }
  };
}

function sendMessage() {
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  const slashMatch = text.match(/^\/(\S+)$/);
  if (slashMatch && handleSlashCommand(slashMatch[1])) {
    input.value = "";
    nextTick(autoResize);
    return;
  }

  messages.value.push({ type: "user", content: text });
  busy.value = true;
  ws.send(JSON.stringify({ type: "message", content: text }));
  input.value = "";
  nextTick(() => { autoResize(); scrollBottom(); });
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
  try {
    config.value = await fetchConfig();
    if (config.value.chatScrollback) maxScrollback.value = config.value.chatScrollback;
    initThinkingLevel();
  } catch {}
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
  const tb = config.value?.claude?.thinkingBudget;
  thinkingLevel.value = tb !== undefined ? String(tb) : "";
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
  config.value.claude.thinkingBudget = value ? parseInt(value, 10) : undefined;
  thinkingLevel.value = value;
  savingConfig.value = true;
  try { await saveConfig(config.value); } catch {}
  savingConfig.value = false;
}

// ── Remote control toggle ──
const remoteControlRunning = ref(false);

async function pollRemoteControlState() {
  try {
    const status = await fetchStatus();
    remoteControlRunning.value = status?.session?.remoteControlRunning === true;
  } catch {}
}

const remoteControlEnabled = computed(() => remoteControlRunning.value);

async function toggleRemoteControl() {
  if (!config.value.claude) config.value.claude = {};
  config.value.claude.remoteControl = !remoteControlRunning.value;
  savingConfig.value = true;
  try {
    await saveConfig(config.value);
    // Poll after a short delay to let the process start/stop
    setTimeout(pollRemoteControlState, 1500);
  } catch {}
  savingConfig.value = false;
}

async function freshSession() {
  closeAllPopups();
  messages.value = [];
  try { await fetch("/api/session/fresh", { method: "POST" }); } catch {}
}

// ── Session switcher ──
const sessions = ref<Array<{ id: number; uuid: string; title: string | null; started_at: string; message_count: number }>>([]);
const activeSessionId = ref<string | null>(null);
const editingSessionId = ref<number | null>(null);
const editingTitle = ref("");

async function loadSessions() {
  try {
    const data = await (await fetch("/api/sessions?limit=30")).json();
    sessions.value = data.sessions || [];
    activeSessionId.value = data.activeSessionId;
  } catch {}
}

async function switchSession(uuid: string) {
  closeAllPopups();
  messages.value = [];
  try { await fetch("/api/session/switch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: uuid }),
  }); } catch {}
}

function startRename(s: { id: number; title: string | null; uuid: string }) {
  editingSessionId.value = s.id;
  editingTitle.value = s.title || s.uuid?.slice(0, 8) || "";
}

async function saveRename(id: number) {
  const title = editingTitle.value.trim();
  if (!title) { editingSessionId.value = null; return; }
  try {
    await fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const s = sessions.value.find(s => s.id === id);
    if (s) s.title = title;
  } catch {}
  editingSessionId.value = null;
}

function handleRenameKeydown(e: KeyboardEvent, id: number) {
  if (e.key === "Enter") { e.preventDefault(); saveRename(id); }
  if (e.key === "Escape") { editingSessionId.value = null; }
}

async function deleteSession(id: number) {
  try {
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    sessions.value = sessions.value.filter(s => s.id !== id);
  } catch {}
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
// Commands handled entirely in the UI (not sent to SDK)
const LOCAL_COMMANDS = new Set(["model", "clear"]);

// Only commands that work via the Agent SDK query() interface.
// Excluded: /diff (interactive viewer), /review (deprecated), /fast (TUI),
// /rewind, /permissions, /mcp, /hooks, /agents, /init, /doctor (all interactive TUI)
const nativeCommands = [
  { name: "clear", desc: "Clear conversation history", icon: "bi-x-circle" },
  { name: "compact", desc: "Compact conversation to save context", icon: "bi-arrows-collapse" },
  { name: "model", desc: "Change the AI model", icon: "bi-cpu" },
  { name: "cost", desc: "Show token usage statistics", icon: "bi-cash-coin" },
  { name: "status", desc: "Show version, model, account info", icon: "bi-info-circle" },
  { name: "usage", desc: "Show plan usage and rate limits", icon: "bi-bar-chart" },
  { name: "context", desc: "Visualize context usage", icon: "bi-pie-chart" },
  { name: "effort", desc: "Set model effort level", icon: "bi-speedometer" },
  { name: "plan", desc: "Enter plan mode", icon: "bi-map" },
  { name: "memory", desc: "View and edit CLAUDE.md memory", icon: "bi-journal-text" },
  { name: "help", desc: "Show help and available commands", icon: "bi-question-circle" },
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
    if (name === "clear") { messages.value = []; }
    return true;
  }
  return false;
}

function selectCommand(name: string) {
  closeAllPopups();
  if (handleSlashCommand(name)) return;
  input.value = `/${name}`;
  nextTick(() => { inputEl.value?.focus(); sendMessage(); });
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

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  if (e.key === "/" && !input.value) { e.preventDefault(); showSlash.value = true; showModes.value = false; }
}

function renderMd(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

function closeAllPopups() { showSlash.value = false; showModes.value = false; showHistory.value = false; slashFilter.value = ""; }
function onDocClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (!el.closest(".popup-anchor") && !el.closest(".history-popup") && !el.closest(".activity-modal")) closeAllPopups();
}
function onWindowKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") { if (modalActivity.value) { closeModal(); return; } closeAllPopups(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.activeElement === inputEl.value) return;
  if (showSlash.value || showModes.value) return;
  inputEl.value?.focus();
}

const currentModel = computed(() => {
  const m = config.value?.claude?.model || "";
  return m.replace("claude-", "").replace(/-\d+$/, "") || "\u2014";
});

watch(messages, scrollBottom, { deep: true });
onMounted(() => {
  connect();
  loadConfig();
  loadSkills();
  pollRemoteControlState();
  window.addEventListener("keydown", onWindowKeydown);
  document.addEventListener("click", onDocClick);
});
onUnmounted(() => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close();
  ws = null;
  window.removeEventListener("keydown", onWindowKeydown);
  document.removeEventListener("click", onDocClick);
});
</script>

<template>
  <div class="chat-panel d-flex flex-column h-100">
    <!-- Header -->
    <div class="chat-header">
      <div class="d-flex align-items-center gap-2">
        <span class="status-dot" :class="connected ? 'bg-success' : 'bg-danger'"></span>
        <span class="status-text">{{ connected ? "Connected" : "Reconnecting..." }}</span>
      </div>
      <div class="d-flex align-items-center gap-2">
        <button ref="historyBtnEl" class="btn btn-primary btn-sm header-action-btn" @click.stop="toggleHistory" title="History">
          <i class="bi bi-clock-history"></i>
        </button>
        <Teleport to="body">
          <div v-if="showHistory" class="history-popup" :style="historyPopupStyle" @click.stop>
            <div class="popup-section-label">Sessions</div>
            <div class="popup-scroll" style="max-height:320px">
              <div v-for="s in sessions" :key="s.id" class="session-row" :class="{ active: s.uuid === activeSessionId }">
                <!-- Inline rename mode -->
                <template v-if="editingSessionId === s.id">
                  <input v-model="editingTitle" class="session-rename-input" autofocus
                    @keydown="handleRenameKeydown($event, s.id)" @blur="saveRename(s.id)" />
                </template>
                <!-- Normal display -->
                <template v-else>
                  <button class="session-row-main" @click="switchSession(s.uuid); showHistory = false">
                    <i class="bi bi-chat-left-text"></i>
                    <span class="session-title">{{ s.title || s.uuid?.slice(0, 8) }}</span>
                    <span class="popup-item-desc">{{ s.message_count }}msg</span>
                    <i v-if="s.uuid === activeSessionId" class="bi bi-check2 ms-auto"></i>
                  </button>
                  <div class="session-row-actions">
                    <button class="session-action-btn" @click.stop="startRename(s)" title="Rename">
                      <i class="bi bi-pencil"></i>
                    </button>
                    <button class="session-action-btn session-action-danger" @click.stop="deleteSession(s.id)" title="Delete">
                      <i class="bi bi-trash3"></i>
                    </button>
                  </div>
                </template>
              </div>
              <div v-if="!sessions.length" class="popup-empty">No sessions</div>
            </div>
            <div v-if="sessions.length" class="popup-divider"></div>
            <button v-if="sessions.length" class="popup-item popup-item-danger" @click="clearHistory">
              <i class="bi bi-trash3"></i>
              <span>Clear all history</span>
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
      <div v-if="!messages.length" class="h-100 d-flex flex-column align-items-center justify-content-center text-body-secondary px-4">
        <i class="bi bi-chat-dots" style="font-size:40px;opacity:0.12"></i>
        <p class="mt-2 mb-0 small text-center" style="max-width:260px">Ask {{ agentName }} to write code, fix bugs, refactor, or explain.</p>
      </div>

      <template v-for="(m, i) in messages" :key="i">
        <!-- User bubble (right) -->
        <div v-if="m.type === 'user'" class="bubble-row bubble-right">
          <div class="bubble bubble-user">{{ m.content }}</div>
        </div>

        <!-- Assistant bubble (left) -->
        <div v-else-if="m.type === 'assistant'" class="bubble-row bubble-left">
          <div class="bubble bubble-assistant">
            <div v-html="renderMd(m.content)" class="chat-md"></div>
          </div>
        </div>

        <!-- Activity block (collapsed tools + thinking) -->
        <div v-else-if="m.type === 'activity'" class="activity-pill" @click="openActivityModal(m)">
          <div class="activity-icons">
            <i v-for="(t, ti) in m.tools!.filter(t => t.kind === 'tool').slice(0, 5)" :key="ti"
               :class="['bi', toolIcon(t.name || '')]"></i>
            <i v-if="m.tools!.some(t => t.kind === 'thinking')" class="bi bi-lightbulb thinking-icon"></i>
          </div>
          <span class="activity-label">{{ pillLabel(m.tools!) }}</span>
          <span class="activity-count" v-if="m.tools!.filter(t => t.kind === 'tool').length > 1">
            {{ m.tools!.filter(t => t.kind === 'tool').length }}
          </span>
          <i class="bi bi-chevron-right activity-chevron"></i>
        </div>

        <!-- Error -->
        <div v-else-if="m.type === 'error'" class="bubble-row bubble-left">
          <div class="bubble bubble-error">{{ m.content }}</div>
        </div>
      </template>

      <div v-if="busy" class="activity-pill busy-pill">
        <span class="busy-spinner"></span>
        <span>Working...</span>
      </div>
    </div>

    <!-- Activity detail modal -->
    <Teleport to="body">
      <div v-if="modalActivity" class="modal-backdrop" @click.self="closeModal">
        <div class="activity-modal">
          <div class="modal-header-bar">
            <span class="modal-title">Activity</span>
            <button class="modal-close" @click="closeModal"><i class="bi bi-x-lg"></i></button>
          </div>
          <div class="modal-body-scroll">
            <template v-for="(t, ti) in modalActivity.tools" :key="ti">
              <!-- Thinking entry -->
              <div v-if="t.kind === 'thinking'" class="modal-entry">
                <div class="modal-entry-header thinking-header">
                  <i class="bi bi-lightbulb"></i>
                  <span>Thinking</span>
                </div>
                <pre class="modal-thinking">{{ t.content }}</pre>
              </div>

              <!-- Edit with diff -->
              <div v-else-if="isEditDiff(t)" class="modal-entry">
                <div class="modal-entry-header">
                  <i :class="['bi', toolIcon(t.name || '')]"></i>
                  <span>{{ t.name }}</span>
                  <span class="modal-entry-file">{{ getEditStrings(t).file }}</span>
                </div>
                <div class="diff-side-by-side">
                  <div class="diff-pane diff-old">
                    <div class="diff-pane-label">Old</div>
                    <pre>{{ getEditStrings(t).old }}</pre>
                  </div>
                  <div class="diff-pane diff-new">
                    <div class="diff-pane-label">New</div>
                    <pre>{{ getEditStrings(t).new }}</pre>
                  </div>
                </div>
              </div>

              <!-- Generic tool -->
              <div v-else class="modal-entry">
                <div class="modal-entry-header">
                  <i :class="['bi', toolIcon(t.name || '')]"></i>
                  <span>{{ t.name }}</span>
                </div>
                <table v-if="parseArgs(t.args)" class="modal-args-table">
                  <tr v-for="(val, key) in parseArgs(t.args)!" :key="key">
                    <td class="arg-key">{{ key }}</td>
                    <td class="arg-val"><pre>{{ val }}</pre></td>
                  </tr>
                </table>
                <pre v-else-if="t.args" class="modal-raw-args">{{ t.args }}</pre>
              </div>
            </template>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Input area -->
    <div class="chat-input-area">
      <input ref="fileInputEl" type="file" multiple accept=".txt,.md,.ts,.js,.tsx,.jsx,.json,.yml,.yaml,.py,.sh,.css,.html,.xml,.csv,.sql,.rs,.go,.java,.c,.cpp,.h,.rb,.php,.swift,.kt,.toml,.ini,.cfg,.env,.log" style="display:none" @change="handleFileUpload" />

      <form @submit.prevent="sendMessage" class="chat-input-form">
        <textarea ref="inputEl" v-model="input" :disabled="!connected"
          :placeholder="`Message ${agentName}...`" autofocus rows="1" class="chat-input"
          @keydown="handleKeydown" @input="autoResize"></textarea>
        <button type="submit" class="chat-send-btn" :disabled="!connected || !input.trim()">
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
            <div v-if="savingConfig" class="popup-footer">Saving...</div>
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

/* -- Header -- */
.chat-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--bs-border-color); background: var(--bs-tertiary-bg);
  flex-shrink: 0; position: relative; z-index: 1050; overflow: visible;
}
.status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.status-text { font-size: 11px; color: var(--bs-tertiary-color); }
.header-action-btn { font-size: 14px; padding: 4px 10px; line-height: 1; }
.history-popup {
  position: fixed; min-width: 240px; z-index: 1050;
  background: var(--bs-body-bg); border: 1px solid var(--bs-border-color);
  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25); overflow: hidden;
}

/* -- Messages area -- */
.chat-messages { padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; }

/* -- Bubble layout -- */
.bubble-row { display: flex; }
.bubble-right { justify-content: flex-end; }
.bubble-left { justify-content: flex-start; }
.bubble {
  max-width: 80%; padding: 8px 12px; border-radius: 14px;
  font-size: 14px; line-height: 1.5; word-break: break-word;
}
.bubble-user {
  background: var(--bs-primary); color: #fff;
  border-bottom-right-radius: 4px; white-space: pre-wrap;
}
.bubble-assistant {
  background: var(--bs-tertiary-bg); color: var(--bs-body-color);
  border-bottom-left-radius: 4px;
}
.bubble-error {
  background: color-mix(in srgb, var(--bs-danger) 15%, var(--bs-tertiary-bg));
  color: var(--bs-danger); border-bottom-left-radius: 4px;
}

/* -- Activity pill (collapsed tools) -- */
.activity-pill {
  display: flex; align-items: center; gap: 8px; align-self: center;
  padding: 5px 12px; border-radius: 14px;
  background: var(--bs-secondary-bg); cursor: pointer;
  font-size: 12px; color: var(--bs-secondary-color);
  max-width: 85%; transition: background 0.15s;
}
.activity-pill:hover { background: var(--bs-tertiary-bg); }
.busy-pill { cursor: default; }
.busy-pill:hover { background: var(--bs-secondary-bg); }
.activity-icons {
  display: flex; align-items: center; gap: 3px;
  font-size: 11px; color: var(--bs-tertiary-color); flex-shrink: 0;
}
.thinking-icon { color: var(--bs-warning); }
.activity-label {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 30ch;
}
.activity-count {
  flex-shrink: 0; font-size: 10px; font-weight: 600;
  color: var(--bs-tertiary-color);
  background: var(--bs-body-bg); padding: 1px 6px; border-radius: 8px;
}

.activity-chevron { font-size: 9px; color: var(--bs-tertiary-color); flex-shrink: 0; margin-left: auto; }

/* -- Busy -- */
.busy-spinner {
  width: 10px; height: 10px;
  border: 2px solid var(--bs-border-color); border-top-color: var(--bs-primary);
  border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* -- Activity detail modal -- */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 2000;
  background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;
}
.activity-modal {
  width: 90%; max-width: 700px; max-height: 80vh;
  background: var(--bs-body-bg); border: 1px solid var(--bs-border-color);
  border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  display: flex; flex-direction: column; overflow: hidden;
}
.modal-header-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; border-bottom: 1px solid var(--bs-border-color);
  background: var(--bs-tertiary-bg); flex-shrink: 0;
}
.modal-title { font-size: 13px; font-weight: 600; }
.modal-close {
  background: none; border: none; color: var(--bs-secondary-color);
  font-size: 14px; cursor: pointer; padding: 2px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--bs-secondary-bg); }
.modal-body-scroll {
  overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column;
  gap: 8px; flex: 1 1 0; min-height: 0;
}
.modal-body-scroll pre { white-space: pre-wrap; word-break: break-word; max-height: none; }

/* Modal entries */
.modal-entry {
  border: 1px solid var(--bs-border-color); border-radius: 8px; overflow: hidden;
}
.modal-entry-header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; background: var(--bs-tertiary-bg);
  font-size: 12px; font-weight: 600; color: var(--bs-body-color);
  border-bottom: 1px solid var(--bs-border-color);
}
.modal-entry-header .bi { font-size: 12px; color: var(--bs-primary); }
.thinking-header .bi { color: var(--bs-warning); }
.modal-entry-file {
  margin-left: auto; font-weight: 400; font-size: 11px;
  color: var(--bs-tertiary-color); font-family: var(--bs-font-monospace);
}

/* Args table */
.modal-args-table {
  width: 100%; font-size: 12px; border-collapse: collapse;
  font-family: "SF Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", var(--bs-font-monospace);
}
.modal-args-table tr { border-bottom: 1px solid var(--bs-border-color); }
.modal-args-table tr:last-child { border-bottom: none; }
.arg-key {
  padding: 5px 10px; font-weight: 600; color: var(--bs-tertiary-color);
  white-space: nowrap; vertical-align: top; width: 1%;
  background: var(--bs-tertiary-bg);
}
.arg-val { padding: 5px 10px; color: var(--bs-body-color); }
.arg-val pre {
  margin: 0; white-space: pre-wrap; word-break: break-all;
  font-size: 12px; line-height: 1.45; max-height: 200px; overflow-y: auto;
}
.modal-raw-args {
  margin: 0; padding: 8px 10px; font-size: 12px; line-height: 1.4;
  white-space: pre-wrap; word-break: break-all; color: var(--bs-body-color);
}
.modal-thinking {
  margin: 0; padding: 8px 10px; font-size: 12px; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word;
  color: var(--bs-secondary-color); font-style: italic;
  max-height: 200px; overflow-y: auto;
}

/* Side-by-side diff */
.diff-side-by-side {
  display: grid; grid-template-columns: 1fr 1fr; min-height: 0;
}
.diff-pane {
  overflow: auto; max-height: 300px;
  font-family: "SF Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", var(--bs-font-monospace);
}
.diff-pane pre {
  margin: 0; padding: 8px 10px; font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-all;
}
.diff-pane-label {
  padding: 3px 10px; font-size: 10px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.5px;
}
.diff-old {
  border-right: 1px solid var(--bs-border-color);
  background: color-mix(in srgb, var(--bs-danger) 5%, var(--bs-body-bg));
}
.diff-old .diff-pane-label { color: var(--bs-danger); }
.diff-old pre { color: color-mix(in srgb, var(--bs-danger) 70%, var(--bs-body-color)); }
.diff-new {
  background: color-mix(in srgb, var(--bs-success) 5%, var(--bs-body-bg));
}
.diff-new .diff-pane-label { color: var(--bs-success); }
.diff-new pre { color: color-mix(in srgb, var(--bs-success) 70%, var(--bs-body-color)); }

/* -- Input area -- */
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

/* -- Mode button -- */
.mode-bar-btn {
  height: 32px; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
  font-size: 14px; color: #fff; padding: 0 14px; border-radius: 6px;
  border: none; background: var(--bs-primary); font-weight: 500; transition: filter 0.15s;
}
.mode-bar-btn:hover { filter: brightness(1.15); }
.mode-bar-model { font-weight: 500; }
.mode-bar-info { font-size: 11px; color: var(--bs-tertiary-color); margin-left: auto; }

/* -- Popups -- */
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
.session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }

/* Session row with hover actions */
.session-row {
  display: flex; align-items: center; position: relative;
}
.session-row.active { color: var(--bs-primary); }
.session-row-main {
  display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;
  padding: 6px 10px; background: none; border: none;
  color: inherit; font-size: 12px; cursor: pointer; text-align: left;
}
.session-row:hover .session-row-main { background: var(--bs-secondary-bg); }
.session-row-actions {
  display: none; align-items: center; gap: 2px;
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
  background: var(--bs-secondary-bg); border-radius: 4px; padding: 0 2px;
}
.session-row:hover .session-row-actions { display: flex; }
.session-action-btn {
  background: none; border: none; color: var(--bs-tertiary-color);
  font-size: 11px; padding: 3px 5px; cursor: pointer; border-radius: 3px;
  display: flex; align-items: center;
}
.session-action-btn:hover { background: var(--bs-tertiary-bg); color: var(--bs-body-color); }
.session-action-danger:hover { color: var(--bs-danger); }
.session-rename-input {
  flex: 1; margin: 4px 8px; padding: 3px 8px; font-size: 12px;
  background: var(--bs-tertiary-bg); border: 1px solid var(--bs-primary);
  border-radius: 4px; color: var(--bs-body-color); outline: none;
}
.slash-popup { min-width: 300px; max-width: 360px; }
.popup-section-label { padding: 6px 10px 2px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--bs-tertiary-color); }
.popup-divider { height: 1px; background: var(--bs-border-color); margin: 4px 0; }
.popup-footer { padding: 4px 10px; font-size: 10px; color: var(--bs-tertiary-color); border-top: 1px solid var(--bs-border-color); text-align: center; }
.popup-footer-warn { color: var(--bs-warning); }
.popup-item-danger { color: var(--bs-danger); }
.popup-item-danger:hover { background: color-mix(in srgb, var(--bs-danger) 10%, transparent); }
.popup-empty { padding: 16px; text-align: center; color: var(--bs-tertiary-color); font-size: 12px; }

/* -- Markdown in bubbles -- */
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
