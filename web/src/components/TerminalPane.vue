<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ (e: "connected", val: boolean): void }>();

const containerEl = ref<HTMLElement | null>(null);

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
  return `${proto}//${location.host}/ws/terminal?id=${encodeURIComponent(props.sessionId)}`;
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
    emit("connected", true);
    term?.focus();
    if (term) ws?.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };
  ws.onclose = () => {
    emit("connected", false);
    term?.write("\r\n\x1b[31m[Disconnected]\x1b[0m\r\n");
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) term?.write(new Uint8Array(ev.data));
    else term?.write(ev.data);
  };

  term.onData((data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(data); });
  term.onResize(({ cols, rows }) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows })); });

  resizeObserver = new ResizeObserver(() => { fitAddon?.fit(); });
  resizeObserver.observe(containerEl.value);
}

function cleanup() {
  ws?.close();
  term?.dispose();
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
  term = null;
  fitAddon = null;
  ws = null;
}

function focus() {
  term?.focus();
}

defineExpose({ focus });

onMounted(() => { nextTick(connect); });
onUnmounted(cleanup);

// Reconnect if sessionId changes
watch(() => props.sessionId, () => {
  cleanup();
  nextTick(connect);
});
</script>

<template>
  <div ref="containerEl" class="terminal-pane-container"></div>
</template>

<style scoped>
.terminal-pane-container { width: 100%; height: 100%; min-height: 0; padding: 4px; }
.terminal-pane-container :deep(.xterm) { height: 100%; }
.terminal-pane-container :deep(.xterm-viewport) { overflow-y: auto !important; }
</style>
