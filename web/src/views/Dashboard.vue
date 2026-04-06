<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { fetchStatus } from "../composables/useApi";

const status = ref<any>(null);
const error = ref<string | null>(null);
let timer: ReturnType<typeof setInterval>;

async function load() {
  try { status.value = await fetchStatus(); error.value = null; }
  catch (e) { error.value = String(e); }
}

function uptime(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

onMounted(() => { load(); timer = setInterval(load, 5000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="p-4">
    <div v-if="error" class="alert alert-danger">{{ error }}</div>
    <div v-else-if="!status" class="text-body-secondary">Loading...</div>
    <template v-else>
      <div class="row g-3 mb-4">
        <div class="col-sm-6 col-lg-3">
          <div class="card h-100">
            <div class="card-body">
              <div class="text-primary small text-uppercase mb-1"><i class="bi bi-cpu me-1"></i>Model</div>
              <div class="fs-5 fw-semibold">{{ status.model }}</div>
              <div class="text-body-secondary small">{{ status.provider }}</div>
            </div>
          </div>
        </div>
        <div class="col-sm-6 col-lg-3">
          <div class="card h-100">
            <div class="card-body">
              <div class="text-primary small text-uppercase mb-1"><i class="bi bi-clock me-1"></i>Uptime</div>
              <div class="fs-5 fw-semibold">{{ uptime(status.uptime_seconds) }}</div>
            </div>
          </div>
        </div>
        <div class="col-sm-6 col-lg-3">
          <div class="card h-100">
            <div class="card-body">
              <div class="text-primary small text-uppercase mb-1"><i class="bi bi-hdd-network me-1"></i>Gateway</div>
              <div class="fs-5 fw-semibold">:{{ status.gateway_port }}</div>
            </div>
          </div>
        </div>
        <div class="col-sm-6 col-lg-3">
          <div class="card h-100">
            <div class="card-body">
              <div class="text-primary small text-uppercase mb-1"><i class="bi bi-activity me-1"></i>Session</div>
              <div class="fs-5 fw-semibold" :class="{
                'text-success': status.session.alive && !status.session.busy,
                'text-warning': status.session.busy,
                'text-danger': !status.session.alive,
              }">
                {{ status.session.alive ? (status.session.busy ? 'Busy' : 'Idle') : 'Down' }}
              </div>
              <div class="text-body-secondary small">I/O: {{ status.session.io || 'tmux' }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header fw-semibold">System Info</div>
        <div class="card-body">
          <table class="table table-sm mb-0">
            <tbody>
              <tr><td class="text-body-secondary" style="width:160px">Provider</td><td class="font-monospace">{{ status.provider }}</td></tr>
              <tr><td class="text-body-secondary">Model</td><td class="font-monospace">{{ status.model }}</td></tr>
              <tr><td class="text-body-secondary">Port</td><td class="font-monospace">{{ status.gateway_port }}</td></tr>
              <tr><td class="text-body-secondary">Paired</td><td>{{ status.paired ? 'Yes' : 'No' }}</td></tr>
              <tr><td class="text-body-secondary">Session I/O</td><td>{{ status.session.io || 'tmux' }}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>
