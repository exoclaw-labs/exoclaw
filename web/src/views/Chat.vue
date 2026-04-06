<script setup lang="ts">
import { ref, nextTick, watch, onMounted } from "vue";
import { marked } from "marked";
import { useChatStore } from "../composables/useChatStore";

const { state, send } = useChatStore();
const input = ref("");
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

function scrollBottom() {
  nextTick(() => { if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight; });
}

function renderMd(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

function handleSend() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  send(text);
  scrollBottom();
  nextTick(() => inputEl.value?.focus());
}

function copyText(text: string) { navigator.clipboard.writeText(text); }

// Scroll to bottom on mount and when messages change
onMounted(scrollBottom);
watch(() => state.messages.length, scrollBottom);
watch(() => state.messages[state.messages.length - 1]?.content, scrollBottom);

// Refocus input when busy clears (input was disabled during response)
watch(() => state.busy, (busy) => { if (!busy) nextTick(() => inputEl.value?.focus()); });
</script>

<template>
  <div class="d-flex flex-column h-100">
    <!-- Status -->
    <div class="px-3 py-2 border-bottom d-flex align-items-center gap-2 small">
      <span class="rounded-circle d-inline-block" style="width:8px;height:8px" :class="{
        'bg-success': state.connected && !state.busy,
        'bg-warning': state.busy,
        'bg-danger': !state.connected,
      }"></span>
      <span class="text-body-secondary">{{ state.connected ? (state.busy ? 'Responding...' : 'Connected') : 'Disconnected' }}</span>
      <span v-if="state.sessionId" class="ms-auto font-monospace text-body-tertiary" style="font-size:11px">{{ state.sessionId.slice(0, 8) }}</span>
    </div>

    <!-- Messages -->
    <div ref="scrollEl" class="flex-grow-1 overflow-auto p-3" style="min-height:0">
      <div v-if="!state.messages.length" class="h-100 d-flex align-items-center justify-content-center text-body-secondary">
        Send a message to start
      </div>

      <div v-for="(m, i) in state.messages" :key="i" class="mb-3" :class="{ 'text-end': m.role === 'user', 'text-center': m.role === 'error' }">
        <!-- User -->
        <div v-if="m.role === 'user'" class="d-inline-block rounded-3 px-3 py-2 text-start bg-primary text-white" style="max-width:75%">
          {{ m.content }}
        </div>

        <!-- Assistant -->
        <div v-else-if="m.role === 'assistant'" class="d-inline-block card px-3 py-2 text-start position-relative" style="max-width:80%">
          <div v-html="renderMd(m.content)" class="chat-md"></div>
          <button class="btn btn-sm position-absolute top-0 end-0 m-1 opacity-50 text-body-secondary" style="font-size:11px" @click="copyText(m.content)">
            <i class="bi bi-clipboard"></i>
          </button>
        </div>

        <!-- Thinking -->
        <div v-else-if="m.role === 'thinking'" class="d-inline-block card px-3 py-2 fst-italic text-body-secondary small text-start" style="max-width:75%">
          <i class="bi bi-lightbulb me-1"></i>{{ m.content }}
        </div>

        <!-- Tool -->
        <div v-else-if="m.role === 'tool'" class="d-inline-block card px-3 py-2 text-start" style="max-width:75%">
          <div v-if="m.toolName" class="fw-semibold text-primary small mb-1"><i class="bi bi-wrench me-1"></i>{{ m.toolName }}</div>
          <pre class="mb-0 small text-body-secondary" style="white-space:pre-wrap">{{ m.content.slice(0, 500) }}{{ m.content.length > 500 ? '...' : '' }}</pre>
        </div>

        <!-- Error -->
        <div v-else-if="m.role === 'error'" class="d-inline-block">
          <span class="badge bg-danger"><i class="bi bi-exclamation-triangle me-1"></i>{{ m.content }}</span>
        </div>
      </div>
    </div>

    <!-- Input -->
    <form @submit.prevent="handleSend" class="p-3 border-top d-flex gap-2">
      <input ref="inputEl" v-model="input" :disabled="state.busy" placeholder="Send a message..." autofocus class="form-control" />
      <button type="submit" class="btn btn-primary" :disabled="state.busy || !input.trim()">
        <i class="bi bi-send"></i>
      </button>
    </form>
  </div>
</template>

<style scoped>
.chat-md { line-height: 1.6; }
.chat-md :deep(pre) { background: var(--bs-tertiary-bg); border-radius: 6px; padding: 12px; overflow-x: auto; }
.chat-md :deep(code) { color: var(--bs-primary); background: var(--bs-tertiary-bg); padding: 2px 5px; border-radius: 3px; font-size: 0.875em; }
.chat-md :deep(pre code) { background: none; padding: 0; color: inherit; }
</style>
