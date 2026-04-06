<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();

interface Trigger {
  id: string;
  name?: string;
  schedule?: string;
  cron?: string;
  enabled?: boolean;
  next_run?: string;
  next_run_at?: string;
  [key: string]: unknown;
}

const triggers = ref<Trigger[]>([]);
const unconfigured = ref(false);
const loading = ref(true);
const error = ref<string | null>(null);
const runningId = ref<string | null>(null);
const runFeedback = ref<Record<string, { ok: boolean; msg: string }>>({});
let pollTimer: ReturnType<typeof setInterval>;

async function load() {
  try {
    const res = await fetch("/api/agents");
    const data = await res.json() as { triggers?: Trigger[]; unconfigured?: boolean; error?: string };
    unconfigured.value = !!data.unconfigured;
    error.value = data.error ?? null;
    triggers.value = Array.isArray(data.triggers) ? data.triggers : [];
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function runNow(id: string) {
  runningId.value = id;
  delete runFeedback.value[id];
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}/run`, { method: "POST" });
    if (res.ok) {
      runFeedback.value[id] = { ok: true, msg: "Triggered successfully" };
    } else {
      const body = await res.json().catch(() => ({})) as { detail?: string; error?: string };
      runFeedback.value[id] = { ok: false, msg: body.detail || body.error || `Error ${res.status}` };
    }
  } catch (e) {
    runFeedback.value[id] = { ok: false, msg: String(e) };
  } finally {
    runningId.value = null;
  }
}

/** Strip "exoclaw-" prefix, replace hyphens with spaces, title-case each word. */
function formatName(raw: string | undefined): string {
  if (!raw) return "Unnamed Agent";
  const stripped = raw.replace(/^exoclaw-/i, "");
  return stripped
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parse a 5-field cron expression into something human-readable. */
function humanSchedule(cron: string | undefined): string {
  if (!cron) return "Manual";
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [minute, hour, dayMonth, , dayWeek] = parts;

  const days: Record<string, string> = {
    "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed",
    "4": "Thu", "5": "Fri", "6": "Sat",
    "sun": "Sun", "mon": "Mon", "tue": "Tue", "wed": "Wed",
    "thu": "Thu", "fri": "Fri", "sat": "Sat",
  };

  const h = hour === "*" ? null : parseInt(hour, 10);
  const m = minute === "*" ? null : parseInt(minute, 10);
  const timeStr = h !== null
    ? `${h === 0 ? 12 : h > 12 ? h - 12 : h}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"} UTC`
    : "every hour UTC";

  if (dayWeek !== "*" && dayWeek !== "?") {
    const dayName = days[dayWeek.toLowerCase()] ?? `day ${dayWeek}`;
    return `Every ${dayName} at ${timeStr}`;
  }
  if (dayMonth !== "*" && dayMonth !== "?") {
    return `Monthly on day ${dayMonth} at ${timeStr}`;
  }
  if (hour === "*") {
    return m !== null ? `Every hour at :${String(m).padStart(2, "0")}` : "Every minute";
  }
  return `Daily at ${timeStr}`;
}

/** Relative time from an ISO string. */
function relativeTime(isoStr: string | undefined): string {
  if (!isoStr) return "Unknown";
  const diff = new Date(isoStr).getTime() - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  if (abs < 60_000) return past ? "just now" : "in < 1 min";
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return past ? `${h}h ago` : `in ${h}h`;
  }
  const d = Math.round(abs / 86_400_000);
  return past ? `${d}d ago` : `in ${d}d`;
}

function nextRunField(t: Trigger): string | undefined {
  return (t.next_run as string | undefined) || (t.next_run_at as string | undefined);
}

function scheduleField(t: Trigger): string | undefined {
  return (t.schedule as string | undefined) || (t.cron as string | undefined);
}

onMounted(() => {
  load();
  pollTimer = setInterval(load, 30_000);
});
onUnmounted(() => clearInterval(pollTimer));
</script>

<template>
  <div class="p-4">
    <div class="d-flex align-items-center justify-content-between mb-4">
      <div>
        <h5 class="mb-0 fw-semibold"><i class="bi bi-robot me-2 text-primary"></i>Agent Team</h5>
        <div class="text-body-secondary small mt-1">Scheduled remote agents from Claude.ai</div>
      </div>
      <button class="btn btn-sm btn-outline-secondary" @click="load" :disabled="loading">
        <i class="bi bi-arrow-clockwise" :class="{ 'spin': loading }"></i>
        Refresh
      </button>
    </div>

    <!-- Unconfigured notice -->
    <div v-if="unconfigured" class="alert alert-warning d-flex align-items-start gap-3">
      <i class="bi bi-key fs-5 mt-1"></i>
      <div>
        <div class="fw-semibold mb-1">Claude API Token not configured</div>
        <div class="small mb-2">
          Add your <code>claudeApiToken</code> to the gateway config to view and manage scheduled agents.
        </div>
        <router-link to="/config" class="btn btn-sm btn-warning">
          <i class="bi bi-gear me-1"></i>Open Config
        </router-link>
      </div>
    </div>

    <!-- API error -->
    <div v-else-if="error && !loading" class="alert alert-danger small">
      <i class="bi bi-exclamation-triangle me-2"></i>Could not fetch agents: {{ error }}
    </div>

    <!-- Loading -->
    <div v-else-if="loading" class="text-body-secondary d-flex align-items-center gap-2">
      <span class="spinner-border spinner-border-sm"></span> Loading agents...
    </div>

    <!-- Empty state (configured but no triggers) -->
    <div v-else-if="triggers.length === 0" class="card">
      <div class="card-body text-center py-5 text-body-secondary">
        <i class="bi bi-robot fs-1 d-block mb-3 opacity-25"></i>
        <div class="fw-semibold mb-1">No scheduled agents found</div>
        <div class="small">Create triggers at <a href="https://claude.ai" target="_blank" rel="noopener">claude.ai</a> to see them here.</div>
      </div>
    </div>

    <!-- Agent cards -->
    <div v-else class="row g-3">
      <div v-for="t in triggers" :key="t.id" class="col-md-6 col-xl-4">
        <div class="card h-100">
          <div class="card-body">
            <div class="d-flex align-items-start justify-content-between mb-2">
              <div class="fw-semibold">{{ formatName(t.name) }}</div>
              <span
                class="badge ms-2 flex-shrink-0"
                :class="t.enabled === false ? 'text-bg-secondary' : 'text-bg-success'"
              >
                {{ t.enabled === false ? "Disabled" : "Enabled" }}
              </span>
            </div>

            <div class="text-body-secondary small mb-1">
              <i class="bi bi-clock me-1"></i>{{ humanSchedule(scheduleField(t)) }}
            </div>

            <div v-if="nextRunField(t)" class="text-body-secondary small mb-3">
              <i class="bi bi-calendar-event me-1"></i>Next run: {{ relativeTime(nextRunField(t)) }}
            </div>
            <div v-else class="mb-3"></div>

            <!-- Run feedback -->
            <div v-if="runFeedback[t.id]" class="alert py-1 px-2 small mb-2"
              :class="runFeedback[t.id].ok ? 'alert-success' : 'alert-danger'">
              {{ runFeedback[t.id].msg }}
            </div>

            <button
              class="btn btn-sm btn-primary w-100"
              :disabled="runningId === t.id"
              @click="runNow(t.id)"
            >
              <span v-if="runningId === t.id" class="spinner-border spinner-border-sm me-1"></span>
              <i v-else class="bi bi-play-fill me-1"></i>
              Run Now
            </button>
          </div>

          <div class="card-footer text-body-tertiary small font-monospace text-truncate" :title="t.id">
            {{ t.id }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes spin { to { transform: rotate(360deg); } }
.spin { display: inline-block; animation: spin 0.8s linear infinite; }
</style>
