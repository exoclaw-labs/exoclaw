<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { fetchLogList, fetchLog, type LogUnitSummary } from "../composables/useApi";

const units = ref<LogUnitSummary[]>([]);
const selected = ref<string | null>(null);
const rotated = ref(0);
const tail = ref(500);
const autoRefresh = ref(true);
const lines = ref<string[]>([]);
const meta = ref<{ size: number; mtime: string; truncated: boolean } | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const logDir = ref("");
const stickToBottom = ref(true);
const viewport = ref<HTMLElement | null>(null);

let refreshTimer: number | null = null;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadList() {
  try {
    const res = await fetchLogList();
    units.value = res.units;
    logDir.value = res.logDir;
    error.value = null;
    if (!selected.value && units.value.length > 0) {
      selected.value = units.value[0].unit;
    }
  } catch (err) {
    error.value = `Failed to list logs: ${(err as Error).message}`;
  }
}

async function loadLog() {
  if (!selected.value) return;
  loading.value = true;
  try {
    const res = await fetchLog(selected.value, { rotated: rotated.value, tail: tail.value }) as unknown as
      | { error: string; detail?: string }
      | { unit: string; rotated: number; size: number; mtime: string; truncated: boolean; lines: string[] };
    if ("error" in res) {
      error.value = res.error;
      lines.value = [];
      meta.value = null;
      return;
    }
    lines.value = res.lines;
    meta.value = { size: res.size, mtime: res.mtime, truncated: res.truncated };
    error.value = null;
    if (stickToBottom.value) {
      await nextTick();
      const el = viewport.value;
      if (el) el.scrollTop = el.scrollHeight;
    }
  } catch (err) {
    error.value = `Failed to load log: ${(err as Error).message}`;
  } finally {
    loading.value = false;
  }
}

function onScroll() {
  const el = viewport.value;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
  stickToBottom.value = atBottom;
}

function selectUnit(u: string) {
  selected.value = u;
  rotated.value = 0;
  stickToBottom.value = true;
}

const availableRotated = computed(() => {
  if (!selected.value) return [] as number[];
  const u = units.value.find((x) => x.unit === selected.value);
  return u ? [0, ...u.rotated] : [0];
});

function startAutoRefresh() {
  stopAutoRefresh();
  if (!autoRefresh.value) return;
  refreshTimer = window.setInterval(() => {
    loadList();
    if (rotated.value === 0) loadLog();
  }, 3000);
}

function stopAutoRefresh() {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

watch([selected, rotated, tail], () => { loadLog(); });
watch(autoRefresh, (on) => { on ? startAutoRefresh() : stopAutoRefresh(); });

onMounted(async () => {
  await loadList();
  await loadLog();
  startAutoRefresh();
});

onBeforeUnmount(() => { stopAutoRefresh(); });
</script>

<template>
  <div class="d-flex flex-column h-100">
    <div class="p-3 border-bottom d-flex flex-wrap align-items-center gap-2">
      <h6 class="mb-0 me-2">Logs</h6>
      <span v-if="logDir" class="text-body-secondary small font-monospace">{{ logDir }}</span>

      <div class="ms-auto d-flex align-items-center gap-2">
        <label class="form-label small mb-0">Rotated</label>
        <select v-model.number="rotated" class="form-select form-select-sm" style="width: auto" :disabled="!selected">
          <option v-for="r in availableRotated" :key="r" :value="r">
            {{ r === 0 ? "current" : `.${r}` }}
          </option>
        </select>

        <label class="form-label small mb-0 ms-2">Tail</label>
        <select v-model.number="tail" class="form-select form-select-sm" style="width: auto">
          <option :value="100">100</option>
          <option :value="500">500</option>
          <option :value="2000">2000</option>
          <option :value="10000">10000</option>
        </select>

        <div class="form-check form-switch ms-2 mb-0">
          <input class="form-check-input" type="checkbox" id="autoRefresh" v-model="autoRefresh">
          <label class="form-check-label small" for="autoRefresh">Auto-refresh</label>
        </div>

        <button class="btn btn-sm btn-outline-secondary" @click="loadList(); loadLog()" :disabled="loading">
          <i class="bi bi-arrow-clockwise"></i>
        </button>
      </div>
    </div>

    <div class="flex-grow-1 d-flex overflow-hidden">
      <!-- Unit list -->
      <div class="border-end overflow-auto" style="width: 220px; min-width: 220px;">
        <div v-if="units.length === 0" class="p-3 text-body-secondary small">
          No log files yet.
        </div>
        <ul class="list-group list-group-flush">
          <li
            v-for="u in units"
            :key="u.unit"
            class="list-group-item list-group-item-action"
            :class="{ active: selected === u.unit }"
            style="cursor: pointer;"
            @click="selectUnit(u.unit)"
          >
            <div class="d-flex justify-content-between align-items-center">
              <span class="fw-semibold text-truncate">{{ u.unit }}</span>
              <span class="badge bg-secondary-subtle text-body-secondary">{{ humanSize(u.size) }}</span>
            </div>
            <div class="small text-body-secondary">
              {{ new Date(u.mtime).toLocaleTimeString() }}
              <span v-if="u.rotated.length > 0" class="ms-1">
                · +{{ u.rotated.length }} rotated
              </span>
            </div>
          </li>
        </ul>
      </div>

      <!-- Viewer -->
      <div class="flex-grow-1 d-flex flex-column overflow-hidden">
        <div v-if="error" class="alert alert-warning m-2 mb-0 small">{{ error }}</div>
        <div v-if="meta" class="px-3 py-1 border-bottom small text-body-secondary d-flex gap-3">
          <span>Size: {{ humanSize(meta.size) }}</span>
          <span>Modified: {{ new Date(meta.mtime).toLocaleString() }}</span>
          <span v-if="meta.truncated" class="text-warning">Head truncated to last {{ tail }} lines</span>
          <span class="ms-auto" v-if="!stickToBottom">
            <button class="btn btn-sm btn-link p-0" @click="stickToBottom = true; loadLog();">Jump to bottom</button>
          </span>
        </div>
        <div
          ref="viewport"
          class="flex-grow-1 overflow-auto p-2 font-monospace small"
          style="white-space: pre-wrap; word-break: break-all;"
          @scroll="onScroll"
        >
          <div v-for="(line, i) in lines" :key="i">{{ line }}</div>
          <div v-if="!selected" class="text-body-secondary">Select a unit to view its log.</div>
          <div v-else-if="lines.length === 0 && !error" class="text-body-secondary">No output yet.</div>
        </div>
      </div>
    </div>
  </div>
</template>
