<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const containerEl = ref<HTMLElement | null>(null);
const connected = ref(false);

let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let ws: WebSocket | null = null;
let resizeObserver: ResizeObserver | null = null;

function getThemeColors(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue("--bs-body-bg").trim() || "#0b0b14";
  const fg = style.getPropertyValue("--bs-body-color").trim() || "#d4d4dc";
  const cursor = style.getPropertyValue("--bs-primary").trim() || "#7c3aed";
  return { bg, fg, cursor };
}

function termWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/terminal`;
}

function connect() {
  if (!containerEl.value) return;
  const colors = getThemeColors();

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace",
    theme: { background: colors.bg, foreground: colors.fg, cursor: colors.cursor, selectionBackground: colors.cursor + "44" },
    allowTransparency: true,
    scrollback: 5000,
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(containerEl.value);
  nextTick(() => { fitAddon?.fit(); });

  ws = new WebSocket(termWsUrl());
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    connected.value = true;
    term?.focus();
    if (term) ws?.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };
  ws.onclose = () => { connected.value = false; term?.write("\r\n\x1b[31m[Disconnected]\x1b[0m\r\n"); };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) term?.write(new Uint8Array(ev.data));
    else term?.write(ev.data);
  };

  term.onData((data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(data); });
  term.onResize(({ cols, rows }) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows })); });

  resizeObserver = new ResizeObserver(() => { fitAddon?.fit(); });
  resizeObserver.observe(containerEl.value);
}

function reconnect() {
  ws?.close(); term?.dispose();
  if (resizeObserver && containerEl.value) resizeObserver.unobserve(containerEl.value);
  connect();
}

onMounted(() => { nextTick(connect); });
onUnmounted(() => { ws?.close(); term?.dispose(); resizeObserver?.disconnect(); });
</script>

<template>
  <div class="terminal-page d-flex flex-column h-100">
    <div class="terminal-header">
      <div class="d-flex align-items-center gap-2">
        <i class="bi bi-terminal" style="font-size:14px"></i>
        <span class="fw-semibold" style="font-size:12px">Console</span>
      </div>
      <div class="d-flex align-items-center gap-2">
        <span class="status-dot" :class="connected ? 'connected' : 'disconnected'"></span>
        <button class="header-btn" @click="reconnect" title="Reconnect"><i class="bi bi-arrow-clockwise"></i></button>
      </div>
    </div>
    <div ref="containerEl" class="terminal-container"></div>
  </div>
</template>

<style scoped>
.terminal-page { background: var(--bs-body-bg); }
.terminal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--bs-border-color);
  background: var(--bs-tertiary-bg); color: var(--bs-body-color);
}
.header-btn { background: none; border: none; color: var(--bs-tertiary-color); font-size: 12px; padding: 2px 6px; cursor: pointer; border-radius: 3px; }
.header-btn:hover { color: var(--bs-secondary-color); background: var(--bs-secondary-bg); }
.status-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.status-dot.connected { background: var(--bs-success); }
.status-dot.disconnected { background: var(--bs-danger); }
.terminal-container { flex: 1; min-height: 0; padding: 4px; }
.terminal-container :deep(.xterm) { height: 100%; }
.terminal-container :deep(.xterm-viewport) { overflow-y: auto !important; }
</style>
