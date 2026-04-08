<script setup lang="ts">
import { ref, computed, watchEffect, onMounted } from "vue";
import { useRoute } from "vue-router";
import { fetchSetupStatus } from "./composables/useApi";
import SetupWizard from "./views/SetupWizard.vue";

const route = useRoute();

// Tri-state: null = loading, false = needs setup, true = ready
const setupComplete = ref<boolean | null>(null);

onMounted(async () => {
  try {
    const { setupComplete: done } = await fetchSetupStatus();
    setupComplete.value = done;
  } catch {
    // If endpoint fails, assume setup is complete (backwards compat)
    setupComplete.value = true;
  }
});
const sidebarOpen = ref(false);
const showThemePicker = ref(false);

interface Theme {
  id: string;
  label: string;
  mode: "dark" | "light";
}

const themes: Theme[] = [
  { id: "midnight",        label: "Midnight",        mode: "dark" },
  { id: "github-dark",     label: "GitHub Dark",     mode: "dark" },
  { id: "one-dark",        label: "One Dark",        mode: "dark" },
  { id: "tokyo-night",     label: "Tokyo Night",     mode: "dark" },
  { id: "catppuccin",      label: "Catppuccin Mocha", mode: "dark" },
  { id: "dracula",         label: "Dracula",         mode: "dark" },
  { id: "nord",            label: "Nord",            mode: "dark" },
  { id: "rose-pine",       label: "Rosé Pine",       mode: "dark" },
  { id: "ayu-dark",        label: "Ayu Dark",        mode: "dark" },
  { id: "dark",            label: "Bootstrap Dark",  mode: "dark" },
  { id: "light",           label: "Bootstrap Light",  mode: "light" },
  { id: "github-light",    label: "GitHub Light",    mode: "light" },
];

const currentTheme = ref(localStorage.getItem("exoclaw-theme") || "midnight");

watchEffect(() => {
  const t = themes.find(x => x.id === currentTheme.value) || themes[0];
  document.documentElement.setAttribute("data-bs-theme", t.mode);
  document.documentElement.setAttribute("data-exoclaw-theme", t.id);
});

function setTheme(id: string) {
  currentTheme.value = id;
  localStorage.setItem("exoclaw-theme", id);
  showThemePicker.value = false;
}

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: "bi-speedometer2" },
  { to: "/chat", label: "Chat", icon: "bi-chat-dots" },
  { to: "/terminal", label: "Terminal", icon: "bi-terminal" },
];

const configSections = [
  { to: "/config", label: "Setup", icon: "bi-key" },
  { to: "/config/agents", label: "Agents", icon: "bi-robot" },
  { to: "/config/channels", label: "Channels", icon: "bi-broadcast" },
  { to: "/config/skills", label: "Skills", icon: "bi-lightning" },
  { to: "/config/json-files", label: "JSON Files", icon: "bi-braces" },
];

const isConfigPage = computed(() => route.path.startsWith("/config"));
</script>

<template>
  <!-- Loading state -->
  <div v-if="setupComplete === null" class="d-flex align-items-center justify-content-center vh-100">
    <div class="text-center">
      <div class="spinner-border text-primary mb-3"></div>
      <p class="text-body-secondary mb-0">Loading...</p>
    </div>
  </div>

  <!-- Setup wizard -->
  <SetupWizard v-else-if="!setupComplete" @complete="setupComplete = true" />

  <!-- Main app -->
  <div v-else class="d-flex vh-100">
    <!-- Sidebar -->
    <div
      class="offcanvas-md offcanvas-start d-md-flex flex-column flex-shrink-0 border-end sidebar-bg"
      :class="{ show: sidebarOpen }"
      style="width: 230px"
      tabindex="-1"
    >
      <div class="offcanvas-header d-md-none">
        <h6 class="offcanvas-title">Menu</h6>
        <button type="button" class="btn-close" @click="sidebarOpen = false"></button>
      </div>

      <div class="p-3 border-bottom">
        <div class="d-flex align-items-center gap-2">
          <i class="bi bi-cpu fs-5 text-primary"></i>
          <span class="fw-semibold">exoclaw</span>
        </div>
      </div>

      <ul class="nav nav-pills flex-column p-2 gap-1 flex-grow-1 overflow-auto">
        <li v-for="n in nav" :key="n.to" class="nav-item">
          <router-link
            :to="n.to"
            class="nav-link d-flex align-items-center gap-2"
            :class="{ active: route.path === n.to }"
            @click="sidebarOpen = false"
          >
            <i :class="['bi', n.icon]"></i>
            {{ n.label }}
          </router-link>
        </li>
        <li class="nav-item">
          <router-link
            to="/config"
            class="nav-link d-flex align-items-center gap-2"
            :class="{ active: isConfigPage }"
            @click="sidebarOpen = false"
          >
            <i class="bi bi-gear"></i>
            Config
          </router-link>
          <ul v-if="isConfigPage" class="nav flex-column ms-3 mt-1 gap-1">
            <li v-for="s in configSections" :key="s.to" class="nav-item">
              <router-link
                :to="s.to"
                class="nav-link py-1 px-2 d-flex align-items-center gap-2 small"
                :class="{ active: route.path === s.to }"
                @click="sidebarOpen = false"
              >
                <i :class="['bi', s.icon]" style="font-size:12px"></i>
                {{ s.label }}
              </router-link>
            </li>
          </ul>
        </li>
      </ul>

      <div class="p-3 border-top text-center small text-body-tertiary">
        exoclaw runtime
      </div>
    </div>

    <!-- Backdrop -->
    <div v-if="sidebarOpen" class="offcanvas-backdrop fade show d-md-none" @click="sidebarOpen = false"></div>

    <!-- Main -->
    <div class="flex-grow-1 d-flex flex-column overflow-hidden" style="min-width: 0">
      <nav class="navbar border-bottom px-3 py-2">
        <div class="d-flex align-items-center">
          <button class="btn btn-sm btn-outline-secondary d-md-none me-2" @click="sidebarOpen = !sidebarOpen">
            <i class="bi bi-list"></i>
          </button>
          <span class="navbar-text fw-semibold">{{ (route.meta as any)?.title || 'exoclaw' }}</span>
        </div>
        <div class="position-relative">
          <button class="btn btn-sm btn-outline-secondary" @click="showThemePicker = !showThemePicker" title="Theme">
            <i class="bi bi-palette"></i>
          </button>
          <div v-if="showThemePicker" class="dropdown-menu show end-0 mt-1 p-1" style="position:absolute;min-width:180px;max-height:400px;overflow-y:auto;z-index:9999">
            <div class="px-2 py-1 text-body-secondary small fw-semibold">Dark</div>
            <button
              v-for="t in themes.filter(x => x.mode === 'dark')" :key="t.id"
              class="dropdown-item rounded small py-1"
              :class="{ active: currentTheme === t.id }"
              @click="setTheme(t.id)"
            >{{ t.label }}</button>
            <hr class="my-1">
            <div class="px-2 py-1 text-body-secondary small fw-semibold">Light</div>
            <button
              v-for="t in themes.filter(x => x.mode === 'light')" :key="t.id"
              class="dropdown-item rounded small py-1"
              :class="{ active: currentTheme === t.id }"
              @click="setTheme(t.id)"
            >{{ t.label }}</button>
          </div>
        </div>
      </nav>

      <main class="flex-grow-1 overflow-auto">
        <router-view v-slot="{ Component }">
          <keep-alive>
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </main>
    </div>
  </div>
</template>

<style>
@import url("https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css");

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--bs-border-color); border-radius: 3px; }

/*
 * Force Bootstrap components to use CSS variables instead of
 * Sass-compiled colors. This makes themes actually work.
 */
.btn-primary {
  --bs-btn-bg: var(--bs-primary);
  --bs-btn-border-color: var(--bs-primary);
  --bs-btn-hover-bg: var(--bs-primary);
  --bs-btn-hover-border-color: var(--bs-primary);
  --bs-btn-active-bg: var(--bs-primary);
  --bs-btn-active-border-color: var(--bs-primary);
  --bs-btn-disabled-bg: var(--bs-primary);
  --bs-btn-disabled-border-color: var(--bs-primary);
  filter: brightness(1);
}
.btn-primary:hover { filter: brightness(1.15); }
.btn-primary:active { filter: brightness(0.9); }

.btn-outline-primary {
  --bs-btn-color: var(--bs-primary);
  --bs-btn-border-color: var(--bs-primary);
  --bs-btn-hover-bg: var(--bs-primary);
  --bs-btn-hover-border-color: var(--bs-primary);
  --bs-btn-active-bg: var(--bs-primary);
  --bs-btn-active-border-color: var(--bs-primary);
}

.btn-success {
  --bs-btn-bg: var(--bs-success);
  --bs-btn-border-color: var(--bs-success);
  --bs-btn-hover-bg: var(--bs-success);
  --bs-btn-hover-border-color: var(--bs-success);
}
.btn-success:hover { filter: brightness(1.15); }

.btn-danger {
  --bs-btn-bg: var(--bs-danger);
  --bs-btn-border-color: var(--bs-danger);
  --bs-btn-hover-bg: var(--bs-danger);
  --bs-btn-hover-border-color: var(--bs-danger);
}

.btn-warning {
  --bs-btn-bg: var(--bs-warning);
  --bs-btn-border-color: var(--bs-warning);
  --bs-btn-hover-bg: var(--bs-warning);
  --bs-btn-hover-border-color: var(--bs-warning);
}

.btn-info {
  --bs-btn-bg: var(--bs-info);
  --bs-btn-border-color: var(--bs-info);
  --bs-btn-hover-bg: var(--bs-info);
  --bs-btn-hover-border-color: var(--bs-info);
}

.badge.bg-primary, .badge.text-bg-primary { background-color: var(--bs-primary) !important; }
.badge.bg-success, .badge.text-bg-success { background-color: var(--bs-success) !important; }
.badge.bg-danger, .badge.text-bg-danger { background-color: var(--bs-danger) !important; }
.badge.bg-warning, .badge.text-bg-warning { background-color: var(--bs-warning) !important; }
.badge.bg-info, .badge.text-bg-info { background-color: var(--bs-info) !important; }

.text-primary { color: var(--bs-primary) !important; }
.text-success { color: var(--bs-success) !important; }
.text-danger { color: var(--bs-danger) !important; }
.text-warning { color: var(--bs-warning) !important; }
.text-info { color: var(--bs-info) !important; }

.border-primary { border-color: var(--bs-primary) !important; }

.nav-link {
  color: var(--bs-secondary-color) !important;
}
.nav-link:hover {
  color: var(--bs-emphasis-color) !important;
}
.nav-pills .nav-link.active {
  background-color: var(--bs-primary) !important;
  color: #fff !important;
}
.nav-tabs .nav-link.active {
  color: var(--bs-primary) !important;
  border-bottom-color: var(--bs-primary) !important;
}

a { color: var(--bs-link-color); }
a:hover { color: var(--bs-link-hover-color, var(--bs-link-color)); }

/* Sidebar slightly offset from main bg */
.sidebar-bg {
  background-color: var(--bs-tertiary-bg);
}

/* Inputs subtly different from card/body bg */
.form-control, .form-select, textarea.form-control {
  background-color: var(--bs-tertiary-bg) !important;
}
.form-control:focus, .form-select:focus {
  background-color: var(--bs-secondary-bg) !important;
}

/* ── Midnight (default) ── */
[data-exoclaw-theme="midnight"] {
  --bs-body-bg: #0b0b14; --bs-body-color: #d4d4dc;
  --bs-secondary-bg: #111119; --bs-tertiary-bg: #191924;
  --bs-border-color: #26263a;
  --bs-primary: #7c3aed; --bs-primary-rgb: 124,58,237;
  --bs-emphasis-color: #ededf4; --bs-emphasis-color-rgb: 237,237,244;
  --bs-secondary-color: #a0a0b8; --bs-tertiary-color: #5c5c74;
  --bs-link-color: #a78bfa; --bs-link-hover-color: #c4b5fd;
  --bs-code-color: #c084fc;
  --bs-success: #10b981; --bs-success-rgb: 16,185,129;
  --bs-warning: #f59e0b; --bs-warning-rgb: 245,158,11;
  --bs-danger: #ef4444; --bs-danger-rgb: 239,68,68;
  --bs-info: #06b6d4; --bs-info-rgb: 6,182,212;
}

/* ── GitHub Dark (dimmed) ── */
[data-exoclaw-theme="github-dark"] {
  --bs-body-bg: #0d1117; --bs-body-color: #c9d1d9;
  --bs-secondary-bg: #161b22; --bs-tertiary-bg: #1c2128;
  --bs-border-color: #30363d;
  --bs-primary: #238636; --bs-primary-rgb: 35,134,54;
  --bs-emphasis-color: #f0f6fc; --bs-emphasis-color-rgb: 240,246,252;
  --bs-secondary-color: #8b949e; --bs-tertiary-color: #484f58;
  --bs-link-color: #58a6ff; --bs-link-hover-color: #79c0ff;
  --bs-code-color: #79c0ff;
  --bs-success: #238636; --bs-success-rgb: 35,134,54;
  --bs-warning: #d29922; --bs-warning-rgb: 210,153,34;
  --bs-danger: #da3633; --bs-danger-rgb: 218,54,51;
  --bs-info: #58a6ff; --bs-info-rgb: 88,166,255;
}

/* ── One Dark (Atom) ── */
[data-exoclaw-theme="one-dark"] {
  --bs-body-bg: #1e2127; --bs-body-color: #abb2bf;
  --bs-secondary-bg: #242830; --bs-tertiary-bg: #2c313a;
  --bs-border-color: #3e4452;
  --bs-primary: #61afef; --bs-primary-rgb: 97,175,239;
  --bs-emphasis-color: #dcdfe4; --bs-emphasis-color-rgb: 220,223,228;
  --bs-secondary-color: #848b98; --bs-tertiary-color: #5c6370;
  --bs-link-color: #61afef; --bs-link-hover-color: #8ac5f3;
  --bs-code-color: #d19a66;
  --bs-success: #98c379; --bs-success-rgb: 152,195,121;
  --bs-warning: #e5c07b; --bs-warning-rgb: 229,192,123;
  --bs-danger: #e06c75; --bs-danger-rgb: 224,108,117;
  --bs-info: #56b6c2; --bs-info-rgb: 86,182,194;
}

/* ── Tokyo Night ── */
[data-exoclaw-theme="tokyo-night"] {
  --bs-body-bg: #1a1b26; --bs-body-color: #a9b1d6;
  --bs-secondary-bg: #1f2335; --bs-tertiary-bg: #24283b;
  --bs-border-color: #33394e;
  --bs-primary: #7aa2f7; --bs-primary-rgb: 122,162,247;
  --bs-emphasis-color: #c0caf5; --bs-emphasis-color-rgb: 192,202,245;
  --bs-secondary-color: #737aa2; --bs-tertiary-color: #545c7e;
  --bs-link-color: #7aa2f7; --bs-link-hover-color: #89b4fa;
  --bs-code-color: #bb9af7;
  --bs-success: #9ece6a; --bs-success-rgb: 158,206,106;
  --bs-warning: #e0af68; --bs-warning-rgb: 224,175,104;
  --bs-danger: #f7768e; --bs-danger-rgb: 247,118,142;
  --bs-info: #7dcfff; --bs-info-rgb: 125,207,255;
}

/* ── Catppuccin Mocha ── */
[data-exoclaw-theme="catppuccin"] {
  --bs-body-bg: #1e1e2e; --bs-body-color: #cdd6f4;
  --bs-secondary-bg: #24243b; --bs-tertiary-bg: #313244;
  --bs-border-color: #45475a;
  --bs-primary: #cba6f7; --bs-primary-rgb: 203,166,247;
  --bs-emphasis-color: #e4e7f5; --bs-emphasis-color-rgb: 228,231,245;
  --bs-secondary-color: #a6adc8; --bs-tertiary-color: #6c7086;
  --bs-link-color: #89b4fa; --bs-link-hover-color: #b4d0fb;
  --bs-code-color: #f5c2e7;
  --bs-success: #a6e3a1; --bs-success-rgb: 166,227,161;
  --bs-warning: #f9e2af; --bs-warning-rgb: 249,226,175;
  --bs-danger: #f38ba8; --bs-danger-rgb: 243,139,168;
  --bs-info: #89dceb; --bs-info-rgb: 137,220,235;
}

/* ── Dracula ── */
[data-exoclaw-theme="dracula"] {
  --bs-body-bg: #282a36; --bs-body-color: #f8f8f2;
  --bs-secondary-bg: #2e3140; --bs-tertiary-bg: #383a4a;
  --bs-border-color: #44475a;
  --bs-primary: #bd93f9; --bs-primary-rgb: 189,147,249;
  --bs-emphasis-color: #f8f8f2; --bs-emphasis-color-rgb: 248,248,242;
  --bs-secondary-color: #bfbfbf; --bs-tertiary-color: #6272a4;
  --bs-link-color: #8be9fd; --bs-link-hover-color: #bd93f9;
  --bs-code-color: #ff79c6;
  --bs-success: #50fa7b; --bs-success-rgb: 80,250,123;
  --bs-warning: #f1fa8c; --bs-warning-rgb: 241,250,140;
  --bs-danger: #ff5555; --bs-danger-rgb: 255,85,85;
  --bs-info: #8be9fd; --bs-info-rgb: 139,233,253;
}

/* ── Nord ── */
[data-exoclaw-theme="nord"] {
  --bs-body-bg: #2e3440; --bs-body-color: #d8dee9;
  --bs-secondary-bg: #353c4a; --bs-tertiary-bg: #3b4252;
  --bs-border-color: #4c566a;
  --bs-primary: #5e81ac; --bs-primary-rgb: 94,129,172;
  --bs-emphasis-color: #eceff4; --bs-emphasis-color-rgb: 236,239,244;
  --bs-secondary-color: #b4bccc; --bs-tertiary-color: #7b88a1;
  --bs-link-color: #88c0d0; --bs-link-hover-color: #8fbcbb;
  --bs-code-color: #88c0d0;
  --bs-success: #a3be8c; --bs-success-rgb: 163,190,140;
  --bs-warning: #ebcb8b; --bs-warning-rgb: 235,203,139;
  --bs-danger: #bf616a; --bs-danger-rgb: 191,97,106;
  --bs-info: #81a1c1; --bs-info-rgb: 129,161,193;
}

/* ── Rosé Pine ── */
[data-exoclaw-theme="rose-pine"] {
  --bs-body-bg: #191724; --bs-body-color: #e0def4;
  --bs-secondary-bg: #1f1d2e; --bs-tertiary-bg: #26233a;
  --bs-border-color: #393552;
  --bs-primary: #c4a7e7; --bs-primary-rgb: 196,167,231;
  --bs-emphasis-color: #e0def4; --bs-emphasis-color-rgb: 224,222,244;
  --bs-secondary-color: #908caa; --bs-tertiary-color: #6e6a86;
  --bs-link-color: #ebbcba; --bs-link-hover-color: #f0d0ce;
  --bs-code-color: #f6c177;
  --bs-success: #9ccfd8; --bs-success-rgb: 156,207,216;
  --bs-warning: #f6c177; --bs-warning-rgb: 246,193,119;
  --bs-danger: #eb6f92; --bs-danger-rgb: 235,111,146;
  --bs-info: #c4a7e7; --bs-info-rgb: 196,167,231;
}

/* ── Ayu Dark ── */
[data-exoclaw-theme="ayu-dark"] {
  --bs-body-bg: #0b0e14; --bs-body-color: #bfbdb6;
  --bs-secondary-bg: #11151c; --bs-tertiary-bg: #1a1f29;
  --bs-border-color: #272d38;
  --bs-primary: #e6b450; --bs-primary-rgb: 230,180,80;
  --bs-emphasis-color: #d9d7ce; --bs-emphasis-color-rgb: 217,215,206;
  --bs-secondary-color: #8a8579; --bs-tertiary-color: #565b66;
  --bs-link-color: #39bae6; --bs-link-hover-color: #59c9ef;
  --bs-code-color: #ffb454;
  --bs-success: #7fd962; --bs-success-rgb: 127,217,98;
  --bs-warning: #e6b450; --bs-warning-rgb: 230,180,80;
  --bs-danger: #d95757; --bs-danger-rgb: 217,87,87;
  --bs-info: #39bae6; --bs-info-rgb: 57,186,230;
}

/* ── GitHub Light ── */
[data-exoclaw-theme="github-light"] {
  --bs-body-bg: #ffffff; --bs-body-color: #1f2328;
  --bs-secondary-bg: #f6f8fa; --bs-tertiary-bg: #eef1f4;
  --bs-border-color: #d0d7de;
  --bs-primary: #1f6feb; --bs-primary-rgb: 31,111,235;
  --bs-emphasis-color: #1f2328; --bs-emphasis-color-rgb: 31,35,40;
  --bs-secondary-color: #656d76; --bs-tertiary-color: #8c959f;
  --bs-link-color: #0969da; --bs-link-hover-color: #0550ae;
  --bs-code-color: #0550ae;
  --bs-success: #1a7f37; --bs-success-rgb: 26,127,55;
  --bs-warning: #9a6700; --bs-warning-rgb: 154,103,0;
  --bs-danger: #cf222e; --bs-danger-rgb: 207,34,46;
  --bs-info: #0969da; --bs-info-rgb: 9,105,218;
}
</style>
