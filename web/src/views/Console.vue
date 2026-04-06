<script setup lang="ts">
import { ref, nextTick, watch, onMounted, onUnmounted } from "vue";

const pane = ref("");
const input = ref("");
const busy = ref(false);
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
let timer: ReturnType<typeof setInterval>;

function scrollBottom() {
  nextTick(() => { if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight; });
}

async function loadPane() {
  try { pane.value = (await (await fetch("/api/session/pane")).json()).content || ""; }
  catch {}
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

async function sendText() {
  const text = input.value;
  if (!text) return;
  input.value = "";
  await sendKeys(`"${text.replace(/"/g, '\\"')}" Enter`);
}

watch(pane, scrollBottom);
onMounted(() => { loadPane(); timer = setInterval(loadPane, 2000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="d-flex flex-column h-100">
    <!-- Pane -->
    <div ref="scrollEl" class="flex-grow-1 overflow-auto p-0" style="min-height:0">
      <pre class="p-3 mb-0 small" style="white-space:pre-wrap">{{ pane || 'Loading...' }}</pre>
    </div>

    <!-- Input -->
    <div class="p-3 border-top">
      <form @submit.prevent="sendText" class="input-group input-group-sm mb-2">
        <input ref="inputEl" v-model="input" class="form-control font-monospace" placeholder="Send text..." :disabled="busy" />
        <button class="btn btn-primary" type="submit" :disabled="busy || !input">Send</button>
      </form>
      <div class="d-flex flex-wrap gap-1">
        <button class="btn btn-sm btn-outline-secondary" :disabled="busy" @click="sendKeys('Enter')">Enter</button>
        <button class="btn btn-sm btn-outline-secondary" :disabled="busy" @click="sendKeys('Up')"><i class="bi bi-arrow-up"></i></button>
        <button class="btn btn-sm btn-outline-secondary" :disabled="busy" @click="sendKeys('Down')"><i class="bi bi-arrow-down"></i></button>
        <button class="btn btn-sm btn-outline-secondary" :disabled="busy" @click="sendKeys('Escape')">Esc</button>
        <button class="btn btn-sm btn-outline-secondary" :disabled="busy" @click="sendKeys('Tab')">Tab</button>
        <button class="btn btn-sm btn-outline-secondary" @click="loadPane"><i class="bi bi-arrow-clockwise"></i></button>
      </div>
    </div>
  </div>
</template>
