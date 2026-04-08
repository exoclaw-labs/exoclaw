<script setup lang="ts">
import { ref, computed, nextTick } from "vue";
import TerminalPane from "../components/TerminalPane.vue";

// ── Types ──
type Layout = "single" | "split-h" | "split-v" | "quad";

interface Pane {
  id: string;
}

interface Tab {
  id: string;
  label: string;
  layout: Layout;
  panes: Pane[];
}

let nextId = 1;
function uid(): string { return `t${nextId++}`; }

// ── State ──
const tabs = ref<Tab[]>([
  { id: uid(), label: "Terminal 1", layout: "single", panes: [{ id: uid() }] },
]);
const activeTabId = ref(tabs.value[0].id);
const paneRefs = ref<Record<string, InstanceType<typeof TerminalPane>>>({});

const activeTab = computed(() => tabs.value.find(t => t.id === activeTabId.value)!);

// ── Tab management ──
function addTab() {
  const id = uid();
  const label = `Terminal ${tabs.value.length + 1}`;
  tabs.value.push({ id, label, layout: "single", panes: [{ id: uid() }] });
  activeTabId.value = id;
}

function closeTab(tabId: string) {
  if (tabs.value.length <= 1) return;
  const idx = tabs.value.findIndex(t => t.id === tabId);
  tabs.value = tabs.value.filter(t => t.id !== tabId);
  if (activeTabId.value === tabId) {
    activeTabId.value = tabs.value[Math.min(idx, tabs.value.length - 1)].id;
  }
}

function selectTab(tabId: string) {
  activeTabId.value = tabId;
  nextTick(() => {
    const tab = tabs.value.find(t => t.id === tabId);
    if (tab?.panes[0]) paneRefs.value[tab.panes[0].id]?.focus();
  });
}

// ── Split management ──
function splitHorizontal() {
  const tab = activeTab.value;
  if (!tab) return;
  if (tab.layout === "single") {
    tab.layout = "split-h";
    tab.panes.push({ id: uid() });
  } else if (tab.layout === "split-v") {
    tab.layout = "quad";
    tab.panes.push({ id: uid() }, { id: uid() });
  }
  // split-h and quad: already at limit for horizontal
}

function splitVertical() {
  const tab = activeTab.value;
  if (!tab) return;
  if (tab.layout === "single") {
    tab.layout = "split-v";
    tab.panes.push({ id: uid() });
  } else if (tab.layout === "split-h") {
    tab.layout = "quad";
    tab.panes.push({ id: uid() }, { id: uid() });
  }
  // split-v and quad: already at limit for vertical
}

function closePane(paneId: string) {
  const tab = activeTab.value;
  if (!tab || tab.panes.length <= 1) return;
  tab.panes = tab.panes.filter(p => p.id !== paneId);
  if (tab.panes.length === 1) tab.layout = "single";
  else if (tab.panes.length === 2) {
    // Keep current layout direction if it was quad, collapse to 2
    if (tab.layout === "quad") tab.layout = "split-h";
  }
}

function canSplitH() {
  const tab = activeTab.value;
  return tab && (tab.layout === "single" || tab.layout === "split-v");
}

function canSplitV() {
  const tab = activeTab.value;
  return tab && (tab.layout === "single" || tab.layout === "split-h");
}

function layoutClass(): string {
  return `layout-${activeTab.value?.layout || "single"}`;
}
</script>

<template>
  <div class="terminal-page d-flex flex-column h-100">
    <!-- Tab bar -->
    <div class="tab-bar">
      <div class="tab-list">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-item"
          :class="{ active: tab.id === activeTabId }"
          @click="selectTab(tab.id)"
        >
          <i class="bi bi-terminal" style="font-size:11px"></i>
          <span class="tab-label">{{ tab.label }}</span>
          <button
            v-if="tabs.length > 1"
            class="tab-close"
            @click.stop="closeTab(tab.id)"
            title="Close tab"
          >
            <i class="bi bi-x"></i>
          </button>
        </button>
        <button class="tab-add" @click="addTab" title="New terminal">
          <i class="bi bi-plus"></i>
        </button>
      </div>
      <div class="tab-actions">
        <button
          class="action-btn-sm"
          :disabled="!canSplitH()"
          @click="splitHorizontal"
          title="Split horizontal"
        >
          <i class="bi bi-layout-split"></i>
        </button>
        <button
          class="action-btn-sm"
          :disabled="!canSplitV()"
          @click="splitVertical"
          title="Split vertical"
        >
          <i class="bi bi-vr"></i>
        </button>
      </div>
    </div>

    <!-- Pane grid -->
    <div class="pane-grid" :class="layoutClass()">
      <div
        v-for="tab in tabs"
        v-show="tab.id === activeTabId"
        :key="tab.id"
        class="pane-grid-inner"
        :class="`layout-${tab.layout}`"
      >
        <div
          v-for="(pane, pi) in tab.panes"
          :key="pane.id"
          class="pane-cell"
        >
          <div class="pane-header" v-if="tab.panes.length > 1">
            <span class="pane-title">{{ pi + 1 }}</span>
            <button class="pane-close" @click="closePane(pane.id)" title="Close pane">
              <i class="bi bi-x"></i>
            </button>
          </div>
          <TerminalPane
            :ref="(el: any) => { if (el) paneRefs[pane.id] = el; }"
            :session-id="pane.id"
            @connected="() => {}"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-page { background: var(--bs-body-bg); }

/* ── Tab bar ── */
.tab-bar {
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--bs-border-color);
  background: var(--bs-tertiary-bg); flex-shrink: 0;
  padding: 0 4px; height: 36px; gap: 4px;
}
.tab-list {
  display: flex; align-items: center; gap: 2px;
  overflow-x: auto; flex: 1; min-width: 0;
}
.tab-list::-webkit-scrollbar { height: 0; }
.tab-item {
  display: flex; align-items: center; gap: 5px;
  padding: 4px 10px; border: none; background: none;
  color: var(--bs-tertiary-color); font-size: 12px;
  border-radius: 5px 5px 0 0; cursor: pointer;
  white-space: nowrap; flex-shrink: 0; position: relative;
  transition: color 0.15s, background 0.15s;
}
.tab-item:hover { color: var(--bs-secondary-color); background: var(--bs-secondary-bg); }
.tab-item.active {
  color: var(--bs-emphasis-color); background: var(--bs-body-bg);
  border-bottom: 2px solid var(--bs-primary);
}
.tab-label { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.tab-close {
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border: none; background: none;
  color: var(--bs-tertiary-color); font-size: 12px; border-radius: 3px;
  cursor: pointer; padding: 0; margin-left: 2px;
}
.tab-close:hover { background: var(--bs-secondary-bg); color: var(--bs-danger); }
.tab-add {
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: none; background: none;
  color: var(--bs-tertiary-color); font-size: 14px; border-radius: 5px;
  cursor: pointer; flex-shrink: 0;
}
.tab-add:hover { background: var(--bs-secondary-bg); color: var(--bs-secondary-color); }

/* ── Tab actions (split buttons) ── */
.tab-actions { display: flex; gap: 2px; flex-shrink: 0; padding-right: 4px; }
.action-btn-sm {
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: none; background: none;
  color: var(--bs-tertiary-color); font-size: 13px; border-radius: 4px;
  cursor: pointer;
}
.action-btn-sm:hover:not(:disabled) { background: var(--bs-secondary-bg); color: var(--bs-secondary-color); }
.action-btn-sm:disabled { opacity: 0.3; cursor: default; }

/* ── Pane grid ── */
.pane-grid { flex: 1; min-height: 0; overflow: hidden; }
.pane-grid-inner {
  width: 100%; height: 100%; display: grid; gap: 1px;
  background: var(--bs-border-color);
}
.pane-grid-inner.layout-single {
  grid-template-columns: 1fr; grid-template-rows: 1fr;
}
.pane-grid-inner.layout-split-h {
  grid-template-columns: 1fr; grid-template-rows: 1fr 1fr;
}
.pane-grid-inner.layout-split-v {
  grid-template-columns: 1fr 1fr; grid-template-rows: 1fr;
}
.pane-grid-inner.layout-quad {
  grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
}

/* ── Pane cell ── */
.pane-cell {
  display: flex; flex-direction: column; min-height: 0; min-width: 0;
  background: var(--bs-body-bg); overflow: hidden;
}
.pane-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 2px 8px; background: var(--bs-tertiary-bg);
  border-bottom: 1px solid var(--bs-border-color); flex-shrink: 0;
}
.pane-title {
  font-size: 10px; color: var(--bs-tertiary-color); font-weight: 600;
}
.pane-close {
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border: none; background: none;
  color: var(--bs-tertiary-color); font-size: 12px; border-radius: 3px;
  cursor: pointer; padding: 0;
}
.pane-close:hover { background: var(--bs-secondary-bg); color: var(--bs-danger); }
</style>
