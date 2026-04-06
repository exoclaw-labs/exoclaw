<script setup lang="ts">
import { ref, onMounted } from "vue";
import { fetchConfig, saveConfig } from "../composables/useApi";

type ChannelType = "slack" | "discord" | "telegram" | "webhook";

const DEFS: Record<ChannelType, { label: string; icon: string; fields: { key: string; label: string; placeholder: string }[] }> = {
  slack: { label: "Slack", icon: "bi-slack", fields: [
    { key: "botToken", label: "Bot Token", placeholder: "xoxb-..." },
    { key: "signingSecret", label: "Signing Secret", placeholder: "Slack signing secret" },
  ]},
  discord: { label: "Discord", icon: "bi-discord", fields: [
    { key: "botToken", label: "Bot Token", placeholder: "Discord bot token" },
  ]},
  telegram: { label: "Telegram", icon: "bi-telegram", fields: [
    { key: "botToken", label: "Bot Token", placeholder: "Token from @BotFather" },
  ]},
  webhook: { label: "Webhook", icon: "bi-globe", fields: [
    { key: "secret", label: "Secret", placeholder: "Shared secret (optional)" },
  ]},
};

const config = ref<Record<string, any>>({});
const channels = ref<Record<string, any>>({});
const saving = ref(false);
const msg = ref<{ type: string; text: string } | null>(null);
const showAdd = ref(false);

const available = () => (Object.keys(DEFS) as ChannelType[]).filter((t) => !channels.value[t]);

async function load() {
  config.value = await fetchConfig();
  channels.value = config.value.channels || {};
}

function add(type: ChannelType) {
  channels.value[type] = { enabled: true };
  showAdd.value = false;
}

function remove(name: string) {
  delete channels.value[name];
}

function toggle(name: string) {
  channels.value[name].enabled = !channels.value[name].enabled;
}

async function handleSave() {
  saving.value = true;
  msg.value = null;
  try {
    config.value.channels = channels.value;
    await saveConfig(config.value);
    msg.value = { type: "success", text: "Saved. Restart container to apply." };
  } catch (e) {
    msg.value = { type: "danger", text: String(e) };
  }
  saving.value = false;
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h6 class="mb-0 text-body">Channels</h6>
      <div class="d-flex gap-2">
        <div v-if="available().length" class="dropdown">
          <button class="btn btn-outline-info btn-sm dropdown-toggle" @click="showAdd = !showAdd">
            <i class="bi bi-plus me-1"></i>Add
          </button>
          <ul class="dropdown-menu dropdown-menu-dark" :class="{ show: showAdd }">
            <li v-for="t in available()" :key="t">
              <button class="dropdown-item" @click="add(t)">
                <i :class="['bi', DEFS[t].icon, 'me-2']"></i>{{ DEFS[t].label }}
              </button>
            </li>
          </ul>
        </div>
        <button class="btn btn-primary btn-sm" :disabled="saving" @click="handleSave">
          <i class="bi bi-save me-1"></i>{{ saving ? 'Saving...' : 'Save' }}
        </button>
      </div>
    </div>

    <div v-if="msg" class="alert py-2 px-3" :class="`alert-${msg.type}`">
      {{ msg.text }}
    </div>

    <div v-if="!Object.keys(channels).length" class="card card">
      <div class="card-body text-center text-body-secondary py-5">
        No channels configured. Click "Add" to get started.
      </div>
    </div>

    <div v-for="(ch, name) in channels" v-show="name !== 'websocket'" :key="name" class="card card mb-3">
      <div class="card-header  d-flex align-items-center justify-content-between">
        <div class="d-flex align-items-center gap-2">
          <i :class="['bi', DEFS[name as ChannelType]?.icon || 'bi-plug']"></i>
          <span class="fw-semibold">{{ DEFS[name as ChannelType]?.label || name }}</span>
          <span class="badge" :class="ch.enabled ? 'bg-success' : 'bg-secondary'" style="cursor:pointer" @click="toggle(name)">
            {{ ch.enabled ? 'Enabled' : 'Disabled' }}
          </span>
        </div>
        <button class="btn btn-sm btn-outline-danger" @click="remove(name)">
          <i class="bi bi-trash"></i>
        </button>
      </div>
      <div v-if="DEFS[name as ChannelType]?.fields.length" class="card-body">
        <div v-for="f in DEFS[name as ChannelType].fields" :key="f.key" class="mb-2">
          <label class="form-label small text-body-secondary mb-1">{{ f.label }}</label>
          <input
            v-model="ch[f.key]"
            type="password"
            :placeholder="f.placeholder"
            class="form-control form-control-sm font-monospace"
          />
        </div>
      </div>
    </div>
  </div>
</template>
