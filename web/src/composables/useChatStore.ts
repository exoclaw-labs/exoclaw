import { reactive } from "vue";
import { chatWsUrl } from "./useApi";

export interface Msg {
  role: "user" | "assistant" | "thinking" | "tool" | "error";
  content: string;
  toolName?: string;
}

// Singleton state — survives component mount/unmount
const state = reactive({
  messages: [] as Msg[],
  busy: false,
  connected: false,
  sessionId: null as string | null,
  historyLoaded: false,
});

let ws: WebSocket | null = null;
let current = "";
let initialized = false;

async function loadHistory() {
  if (state.historyLoaded) return;
  try {
    const res = await fetch("/api/session/history");
    const { messages } = await res.json();
    if (messages?.length && state.messages.length === 0) {
      state.messages = messages;
    }
    state.historyLoaded = true;
  } catch { /* ignore */ }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(chatWsUrl(state.sessionId ?? undefined));

  ws.onopen = () => { state.connected = true; };
  ws.onclose = () => { state.connected = false; setTimeout(connect, 3000); };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case "session_start":
        state.sessionId = m.session_id;
        break;
      case "chunk":
        current += m.content;
        { const last = state.messages[state.messages.length - 1];
          if (last?.role === "assistant") last.content = current;
          else state.messages.push({ role: "assistant", content: current }); }
        break;
      case "thinking":
        state.messages.push({ role: "thinking", content: m.content }); break;
      case "tool_call":
        state.messages.push({ role: "tool", content: JSON.stringify(m.args, null, 2), toolName: m.name }); break;
      case "tool_result":
        state.messages.push({ role: "tool", content: m.output, toolName: m.name }); break;
      case "done":
        if (!current && m.full_response) state.messages.push({ role: "assistant", content: m.full_response });
        current = "";
        state.busy = false;
        break;
      case "error":
        state.messages.push({ role: "error", content: m.message });
        current = "";
        state.busy = false;
        break;
    }
  };
}

function send(text: string) {
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  state.messages.push({ role: "user", content: text });
  ws.send(JSON.stringify({ type: "message", content: text }));
  state.busy = true;
  current = "";
}

export function useChatStore() {
  if (!initialized) {
    initialized = true;
    loadHistory();
    connect();
  }

  return { state, send, loadHistory };
}
