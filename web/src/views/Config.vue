<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRoute } from "vue-router";
import { fetchConfig, saveConfig, fetchClaudeFiles, saveClaudeFile, fetchSubAgents, saveSubAgentFile, deleteSubAgent, deleteSubAgentFile } from "../composables/useApi";
import Setup from "./Setup.vue";

const route = useRoute();
const section = computed(() => (route.params.section as string) || "overview");

const config = ref<Record<string, any>>({});
const claudeFiles = ref<Record<string, string>>({});
const jsonText = ref("");
const saving = ref(false);
const showPersonaWizard = ref(false);
const activeMdFile = ref("CLAUDE.md");
const activeJsonFile = ref(".mcp.json");
const skills = ref<{ name: string; content: string }[]>([]);
const activeSkill = ref<string | null>(null);
const skillContent = ref("");
const newSkillName = ref("");
const dragging = ref(false);

async function loadSkills() {
  try {
    const res = await fetch("/api/skills");
    skills.value = (await res.json()).skills || [];
  } catch {}
}

function selectSkill(name: string) {
  activeSkill.value = name;
  const s = skills.value.find(x => x.name === name);
  skillContent.value = s?.content || "";
}

async function saveSkill() {
  if (!activeSkill.value) return;
  await fetch(`/api/skills/${encodeURIComponent(activeSkill.value)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: skillContent.value }),
  });
  await loadSkills();
  msg.value = { type: "success", text: `Skill "${activeSkill.value}" saved.` };
}

async function addSkill() {
  const name = newSkillName.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!name) return;
  await fetch(`/api/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `# ${name}\n\nDescribe this skill...\n` }),
  });
  newSkillName.value = "";
  await loadSkills();
  selectSkill(name);
}

async function deleteSkill(name: string) {
  if (!confirm(`Delete skill "${name}"?`)) return;
  await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (activeSkill.value === name) { activeSkill.value = null; skillContent.value = ""; }
  await loadSkills();
}

function handleDrop(e: DragEvent) {
  dragging.value = false;
  const files = e.dataTransfer?.files;
  if (!files) return;
  for (const file of Array.from(files)) {
    if (!file.name.endsWith(".md")) continue;
    const name = file.name.replace(/\.md$/i, "").replace(/^SKILL$/i, "skill").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const reader = new FileReader();
    reader.onload = async () => {
      await fetch(`/api/skills/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: reader.result as string }),
      });
      await loadSkills();
      selectSkill(name);
    };
    reader.readAsText(file);
  }
}

// ── Sub-agents ──
interface SubAgent { name: string; files: Record<string, string> }
const subAgents = ref<SubAgent[]>([]);
const selectedAgent = ref<string>("__main__");
const activeSubAgentFile = ref("META.md");
const subAgentFiles = ref<Record<string, string>>({});
const newAgentName = ref("");
const savingSubAgent = ref(false);

const OPTIONAL_FILES = ["IDENTITY.md", "SOUL.md", "USER.md", "MEMORY.md", "TOOLS.md", "HEARTBEAT.md"];

async function loadSubAgents() {
  subAgents.value = await fetchSubAgents();
}

function selectAgent(name: string) {
  selectedAgent.value = name;
  if (name !== "__main__") {
    const a = subAgents.value.find(x => x.name === name);
    subAgentFiles.value = a ? { ...a.files } : {};
    // Default to META.md tab, fallback to first available
    const files = Object.keys(subAgentFiles.value);
    activeSubAgentFile.value = files.includes("META.md") ? "META.md" : files[0] || "META.md";
  }
}

async function saveSubAgentCurrentFile() {
  if (selectedAgent.value === "__main__") return;
  savingSubAgent.value = true;
  try {
    await saveSubAgentFile(selectedAgent.value, activeSubAgentFile.value, subAgentFiles.value[activeSubAgentFile.value] || "");
    await loadSubAgents();
    msg.value = { type: "success", text: `Saved ${activeSubAgentFile.value}` };
  } finally {
    savingSubAgent.value = false;
  }
}

async function createSubAgent() {
  const name = newAgentName.value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
  if (!name) return;
  await saveSubAgentFile(name, "META.md", `name: ${name}\ndescription: \nschedule: \nmodel: claude-sonnet-4-6\n`);
  await saveSubAgentFile(name, "CLAUDE.md", `# ${name}\n\nAgent instructions here...\n`);
  newAgentName.value = "";
  await loadSubAgents();
  selectAgent(name);
}

async function removeSubAgent(name: string) {
  if (!confirm(`Delete agent "${name}"?`)) return;
  await deleteSubAgent(name);
  if (selectedAgent.value === name) selectedAgent.value = "__main__";
  await loadSubAgents();
}

async function addCompanionFile(file: string) {
  if (selectedAgent.value === "__main__") return;
  subAgentFiles.value[file] = `# ${file.replace(".md", "")}\n\n`;
  await saveSubAgentFile(selectedAgent.value, file, subAgentFiles.value[file]);
  await loadSubAgents();
  activeSubAgentFile.value = file;
}

async function removeCompanionFile(file: string) {
  if (!confirm(`Remove ${file} from this agent?`)) return;
  await deleteSubAgentFile(selectedAgent.value, file);
  delete subAgentFiles.value[file];
  await loadSubAgents();
  activeSubAgentFile.value = "META.md";
}

const mdFiles = ["CLAUDE.md", "IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"];

const mdDescriptions: Record<string, string> = {
  "CLAUDE.md": "Primary instructions for the Claude session. Use the Persona Wizard to generate from scratch.",
  "IDENTITY.md": "Agent identity — name, personality, how it presents itself.",
  "SOUL.md": "Core values and behavioral guidelines the agent follows.",
  "USER.md": "Information about the human this agent works with.",
  "AGENTS.md": "Workspace guidelines for agent behavior and boundaries.",
  "TOOLS.md": "Notes about available tools and how to use them.",
  "MEMORY.md": "Long-term curated memories and learned preferences.",
  "HEARTBEAT.md": "Proactive task checklist — things to check on periodically.",
};

const mdPlaceholders: Record<string, string> = {
  "CLAUDE.md": "# Agent Name\n\nPrimary instructions...",
  "IDENTITY.md": "# Identity\n\nName: \nPersonality: \nEmoji: ",
  "SOUL.md": "# Soul\n\nCore values and principles...",
  "USER.md": "# User\n\nName: \nPreferences: \nProjects: ",
  "AGENTS.md": "# Agents\n\nWorkspace guidelines and boundaries...",
  "TOOLS.md": "# Tools\n\nNotes about available tools...",
  "MEMORY.md": "# Memory\n\nDurable facts, user preferences, tool quirks, and conventions.\nThe background review loop auto-populates this file.\n",
  "HEARTBEAT.md": "# Heartbeat\n\nPeriodic tasks to check on...",
};

const jsonFiles = [".mcp.json", "settings.json", "settings.local.json", "config.json"];

const jsonDescriptions: Record<string, string> = {
  ".mcp.json": "Workspace MCP servers. Claude reads this natively. Servers from exoclaw config are merged here on startup.",
  "settings.json": "Claude Code user settings (persisted in ~/.claude/).",
  "settings.local.json": "Claude Code local settings override.",
  "config.json": "ExoClaw gateway configuration (the full config that drives everything).",
};
const msg = ref<{ type: string; text: string } | null>(null);
const loading = ref(true);

// Sync JSON text when config changes (non-JSON sections)
watch(config, (v) => {
  if (section.value !== "json") jsonText.value = JSON.stringify(v, null, 2);
}, { deep: true });

function applyJson() {
  try {
    config.value = JSON.parse(jsonText.value);
    msg.value = null;
  } catch (e) {
    msg.value = { type: "danger", text: `Invalid JSON: ${e}` };
  }
}

async function load() {
  loading.value = true;
  try {
    const [cfg, files] = await Promise.all([fetchConfig(), fetchClaudeFiles()]);
    // remoteControl defaults to true in the runtime (enabled unless explicitly false)
    if (cfg.claude && cfg.claude.remoteControl === undefined) cfg.claude.remoteControl = true;
    config.value = cfg;
    claudeFiles.value = files;
    jsonText.value = JSON.stringify(cfg, null, 2);
    await loadSkills();
    await loadSubAgents();
  } catch (e) {
    msg.value = { type: "danger", text: `Load failed: ${e}` };
  }
  loading.value = false;
}

async function handleSave() {
  saving.value = true;
  msg.value = null;
  try {
    if (section.value === "json") applyJson();
    if (msg.value) { saving.value = false; return; }

    await saveConfig(config.value);

    if (config.value.claude?.settingsJson) {
      await saveClaudeFile("settings.json", JSON.stringify(config.value.claude.settingsJson, null, 2));
    }
    if (config.value.claudeMd !== undefined) {
      await saveClaudeFile("CLAUDE.md", config.value.claudeMd);
    }

    for (const [name, content] of Object.entries(claudeFiles.value)) {
      if (name === "settings.json" || name === "CLAUDE.md") {
        await saveClaudeFile(name, content);
      }
    }

    msg.value = { type: "success", text: "Saved. Restart container to apply session changes." };
  } catch (e) {
    msg.value = { type: "danger", text: `Save failed: ${e}` };
  }
  saving.value = false;
}

const restarting = ref(false);

async function restartSession() {
  restarting.value = true;
  try { await fetch("/api/session/restart", { method: "POST" }); } catch {}
  await new Promise(r => setTimeout(r, 3000));
  restarting.value = false;
  msg.value = { type: "success", text: "Session restarted." };
}

function onClaudeFileEdit(name: string, content: string) {
  claudeFiles.value[name] = content;
  if (name === "settings.json") {
    try { config.value.claude.settingsJson = JSON.parse(content); } catch {}
  }
  if (name === "CLAUDE.md") {
    config.value.claudeMd = content;
  }
}

async function rerunSetup() {
  try {
    const cfg = await fetchConfig();
    cfg.setupComplete = false;
    await saveConfig(cfg);
    window.location.reload();
  } catch (e) {
    msg.value = { type: "danger", text: `Failed: ${e}` };
  }
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <!-- Save bar -->
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h6 class="mb-0">{{ section === 'overview' ? 'Configuration' : '' }}</h6>
      <div class="d-flex gap-2">
        <button class="btn btn-primary btn-sm" :disabled="saving" @click="handleSave">
          <i class="bi bi-save me-1"></i>{{ saving ? 'Saving...' : 'Save' }}
        </button>
        <button class="btn btn-outline-warning btn-sm" :disabled="restarting" @click="restartSession">
          <span v-if="restarting" class="spinner-border spinner-border-sm me-1"></span>
          <i v-else class="bi bi-arrow-clockwise me-1"></i>
          {{ restarting ? 'Restarting...' : 'Restart' }}
        </button>
      </div>
    </div>

    <div v-if="msg" class="alert py-2 px-3" :class="`alert-${msg.type}`">
      <i :class="msg.type === 'success' ? 'bi bi-check-circle' : 'bi bi-exclamation-triangle'" class="me-1"></i>
      {{ msg.text }}
    </div>

    <div v-if="loading" class="text-body-secondary">Loading...</div>
    <template v-else>

      <!-- Setup (landing page for /config) -->
      <div v-if="section === 'overview'">
        <Setup />
        <div class="mt-3">
          <button class="btn btn-sm btn-outline-secondary" @click="rerunSetup">
            <i class="bi bi-arrow-repeat me-1"></i>Re-run Setup Wizard
          </button>
        </div>
      </div>

      <!-- General -->
      <div v-if="section === 'general'" class="card">
        <div class="card-body">
          <div class="mb-3">
            <label class="form-label small text-body-secondary">Name</label>
            <input v-model="config.name" class="form-control form-control-sm font-monospace" />
          </div>
          <div class="mb-3">
            <label class="form-label small text-body-secondary">Model</label>
            <input v-model="config.claude.model" class="form-control form-control-sm font-monospace" />
          </div>
          <div class="mb-3">
            <label class="form-label small text-body-secondary">Permission Mode</label>
            <select v-model="config.claude.permissionMode" class="form-select form-select-sm">
              <option value="auto">auto</option>
              <option value="bypassPermissions">bypassPermissions</option>
              <option value="default">default</option>
              <option value="plan">plan</option>
              <option value="acceptEdits">acceptEdits</option>
            </select>
          </div>
          <div class="mb-3">
            <div class="form-check form-switch">
              <input v-model="config.claude.remoteControl" class="form-check-input" type="checkbox" id="rc">
              <label class="form-check-label small text-body-secondary" for="rc">Remote Control (claude.ai/code)</label>
            </div>
          </div>
          <hr>
          <div class="mb-3">
            <label class="form-label small text-body-secondary">Port</label>
            <input v-model.number="config.port" type="number" class="form-control form-control-sm font-monospace" />
          </div>
          <div class="mb-3">
            <label class="form-label small text-body-secondary">API Token (optional)</label>
            <input v-model="config.apiToken" type="password" class="form-control form-control-sm font-monospace" placeholder="Leave empty for no auth" />
          </div>
        </div>
      </div>


      <!-- Channels -->
      <div v-if="section === 'channels'">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <span class="text-body-secondary small">Configure messaging channels. Tokens are stored securely.</span>
          <div class="dropdown">
            <button class="btn btn-sm btn-outline-primary dropdown-toggle" data-bs-toggle="dropdown">
              <i class="bi bi-plus me-1"></i>Add
            </button>
            <ul class="dropdown-menu dropdown-menu-end">
              <li v-for="t in ['slack','discord','telegram','webhook'].filter(t => !(config.channels||{})[t])" :key="t">
                <button class="dropdown-item text-capitalize" @click="config.channels = {...(config.channels||{}), [t]: {enabled:true}}">{{ t }}</button>
              </li>
            </ul>
          </div>
        </div>

        <div v-if="!Object.keys(config.channels||{}).filter(n => n !== 'websocket').length" class="card">
          <div class="card-body text-center text-body-secondary py-4">No channels configured.</div>
        </div>

        <div v-for="(ch, name) in (config.channels || {})" v-show="name !== 'websocket'" :key="name" class="card mb-3">
          <div class="card-header d-flex align-items-center justify-content-between">
            <div class="d-flex align-items-center gap-2">
              <i :class="'bi ' + ({slack:'bi-slack',discord:'bi-discord',telegram:'bi-telegram',webhook:'bi-globe'}[name as string] || 'bi-plug')"></i>
              <span class="fw-semibold text-capitalize">{{ name }}</span>
              <span class="badge" :class="ch.enabled ? 'text-bg-success' : 'text-bg-secondary'" style="cursor:pointer"
                @click="ch.enabled = !ch.enabled">
                {{ ch.enabled ? 'Enabled' : 'Disabled' }}
              </span>
            </div>
            <button class="btn btn-sm btn-outline-danger" @click="delete config.channels[name]">
              <i class="bi bi-trash"></i>
            </button>
          </div>
          <div class="card-body">
            <!-- Slack -->
            <template v-if="name === 'slack'">
              <div class="mb-2">
                <label class="form-label small text-body-secondary mb-1">Bot Token</label>
                <input v-model="ch.botToken" type="password" placeholder="xoxb-..." class="form-control form-control-sm font-monospace" />
              </div>
              <div>
                <label class="form-label small text-body-secondary mb-1">Signing Secret</label>
                <input v-model="ch.signingSecret" type="password" placeholder="Slack signing secret" class="form-control form-control-sm font-monospace" />
              </div>
            </template>
            <!-- Discord -->
            <template v-else-if="name === 'discord'">
              <div>
                <label class="form-label small text-body-secondary mb-1">Bot Token</label>
                <input v-model="ch.botToken" type="password" placeholder="Discord bot token" class="form-control form-control-sm font-monospace" />
              </div>
            </template>
            <!-- Telegram -->
            <template v-else-if="name === 'telegram'">
              <div>
                <label class="form-label small text-body-secondary mb-1">Bot Token</label>
                <input v-model="ch.botToken" type="password" placeholder="Token from @BotFather" class="form-control form-control-sm font-monospace" />
              </div>
            </template>
            <!-- Webhook -->
            <template v-else-if="name === 'webhook'">
              <div>
                <label class="form-label small text-body-secondary mb-1">Shared Secret (optional)</label>
                <input v-model="ch.secret" type="password" placeholder="Webhook secret" class="form-control form-control-sm font-monospace" />
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- Skills -->
      <div v-if="section === 'skills'">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <span class="text-body-secondary small">SKILL.md files in <code>.claude/skills/</code> — Claude discovers them automatically.</span>
          <div class="d-flex gap-2">
            <form @submit.prevent="addSkill" class="input-group input-group-sm" style="width:220px">
              <input v-model="newSkillName" class="form-control" placeholder="New skill name..." />
              <button class="btn btn-primary" type="submit" :disabled="!newSkillName.trim()"><i class="bi bi-plus"></i></button>
            </form>
          </div>
        </div>

        <!-- Drop zone -->
        <div
          class="border border-dashed rounded p-4 text-center mb-3"
          :class="dragging ? 'border-primary bg-primary bg-opacity-10' : 'border-secondary'"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="handleDrop"
        >
          <i class="bi bi-cloud-arrow-up fs-4 d-block mb-1" :class="dragging ? 'text-primary' : 'text-body-secondary'"></i>
          <span class="small text-body-secondary">Drop .md files here to add skills</span>
        </div>

        <div class="row g-3">
          <!-- Skill list -->
          <div class="col-md-4">
            <div class="list-group">
              <button v-if="!skills.length" class="list-group-item text-body-secondary small text-center" disabled>No skills yet</button>
              <button
                v-for="s in skills" :key="s.name"
                class="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
                :class="{ active: activeSkill === s.name }"
                @click="selectSkill(s.name)"
              >
                <span><i class="bi bi-lightning me-2"></i>{{ s.name }}</span>
                <button class="btn btn-sm p-0 text-body-secondary" @click.stop="deleteSkill(s.name)" title="Delete">
                  <i class="bi bi-trash"></i>
                </button>
              </button>
            </div>
          </div>

          <!-- Skill editor -->
          <div class="col-md-8">
            <div v-if="activeSkill" class="card">
              <div class="card-header d-flex justify-content-between align-items-center">
                <span class="small fw-semibold"><i class="bi bi-lightning me-1"></i>{{ activeSkill }}/SKILL.md</span>
                <button class="btn btn-sm btn-primary" @click="saveSkill">
                  <i class="bi bi-save me-1"></i>Save
                </button>
              </div>
              <div class="card-body p-0">
                <textarea
                  v-model="skillContent"
                  rows="20" class="form-control font-monospace rounded-0 border-0" spellcheck="false" style="resize:vertical"
                ></textarea>
              </div>
            </div>
            <div v-else class="text-center text-body-secondary py-5">
              Select a skill to edit, or create a new one
            </div>
          </div>
        </div>
      </div>

      <!-- JSON Files -->
      <div v-if="section === 'json-files'">
        <ul class="nav nav-tabs border-0 gap-1 mb-3">
          <li v-for="f in jsonFiles" :key="f" class="nav-item">
            <button class="nav-link small py-1 px-2" :class="{ active: activeJsonFile === f }" @click="activeJsonFile = f">
              {{ f }}
            </button>
          </li>
        </ul>

        <div class="card">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span class="small fw-semibold"><i class="bi bi-braces me-1"></i>{{ activeJsonFile }}</span>
            <span v-if="activeJsonFile === 'config.json'" class="badge text-bg-primary">exoclaw config</span>
            <span v-else-if="!claudeFiles[activeJsonFile]" class="badge text-bg-secondary">not created</span>
          </div>
          <div class="card-body p-0">
            <!-- config.json uses the main config state -->
            <textarea v-if="activeJsonFile === 'config.json'"
              v-model="jsonText"
              rows="24" class="form-control font-monospace rounded-0 border-0" spellcheck="false" style="resize:vertical"
            ></textarea>
            <!-- Other JSON files use the claude files state -->
            <textarea v-else
              :value="claudeFiles[activeJsonFile] || '{}'"
              @input="(e: any) => onClaudeFileEdit(activeJsonFile, e.target.value)"
              rows="24" class="form-control font-monospace rounded-0 border-0" spellcheck="false" style="resize:vertical"
            ></textarea>
          </div>
        </div>
        <p class="text-body-secondary small mt-2">{{ jsonDescriptions[activeJsonFile] || '' }}</p>
      </div>

      <!-- Agents -->
      <div v-if="section === 'agents'">
        <div class="row g-3">
          <!-- Agent list -->
          <div class="col-md-3">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <span class="small text-body-secondary fw-semibold">Agents</span>
            </div>
            <div class="list-group mb-2">
              <!-- Main agent -->
              <button
                class="list-group-item list-group-item-action d-flex align-items-center gap-2"
                :class="{ active: selectedAgent === '__main__' }"
                @click="selectAgent('__main__')"
              >
                <i class="bi bi-cpu-fill" style="font-size:12px"></i>
                <span class="small">Main Agent</span>
                <span class="badge text-bg-primary ms-auto" style="font-size:10px">main</span>
              </button>
              <!-- Sub-agents -->
              <button
                v-for="a in subAgents" :key="a.name"
                class="list-group-item list-group-item-action d-flex align-items-center gap-2"
                :class="{ active: selectedAgent === a.name }"
                @click="selectAgent(a.name)"
              >
                <i class="bi bi-robot" style="font-size:12px"></i>
                <span class="small text-truncate flex-grow-1">{{ a.name }}</span>
                <button class="btn btn-sm p-0 text-body-secondary" style="line-height:1" @click.stop="removeSubAgent(a.name)" title="Delete">
                  <i class="bi bi-trash" style="font-size:11px"></i>
                </button>
              </button>
            </div>
            <!-- New sub-agent -->
            <form @submit.prevent="createSubAgent" class="input-group input-group-sm">
              <input v-model="newAgentName" class="form-control" placeholder="new-agent-name" />
              <button class="btn btn-outline-primary" type="submit" :disabled="!newAgentName.trim()" title="Create">
                <i class="bi bi-plus"></i>
              </button>
            </form>
          </div>

          <!-- Editor panel -->
          <div class="col-md-9">
            <!-- Main agent editor -->
            <div v-if="selectedAgent === '__main__'">
              <div v-if="showPersonaWizard">
                <Setup :force-persona="true" @complete="showPersonaWizard = false; load()" />
                <button class="btn btn-sm btn-outline-secondary mt-3" @click="showPersonaWizard = false; load()">
                  <i class="bi bi-arrow-left me-1"></i>Back to editor
                </button>
              </div>
              <div v-else>
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <ul class="nav nav-tabs border-0 gap-1 flex-wrap">
                    <li v-for="f in mdFiles" :key="f" class="nav-item">
                      <button class="nav-link small py-1 px-2" :class="{ active: activeMdFile === f }" @click="activeMdFile = f">
                        {{ f }}
                      </button>
                    </li>
                  </ul>
                  <button v-if="activeMdFile === 'CLAUDE.md'" class="btn btn-sm btn-outline-primary ms-2 flex-shrink-0" @click="showPersonaWizard = true">
                    <i class="bi bi-magic me-1"></i>Persona Wizard
                  </button>
                </div>
                <div class="card">
                  <div class="card-header d-flex justify-content-between align-items-center">
                    <span class="small fw-semibold"><i class="bi bi-file-earmark-text me-1"></i>workspace/{{ activeMdFile }}</span>
                    <span v-if="!claudeFiles[activeMdFile]" class="badge text-bg-secondary">not created</span>
                  </div>
                  <div class="card-body p-0">
                    <textarea
                      :value="claudeFiles[activeMdFile] || ''"
                      @input="(e: any) => onClaudeFileEdit(activeMdFile, e.target.value)"
                      rows="22" class="form-control font-monospace rounded-0 border-0" spellcheck="false" style="resize:vertical"
                      :placeholder="mdPlaceholders[activeMdFile] || `# ${activeMdFile}`"
                    ></textarea>
                  </div>
                </div>
                <p class="text-body-secondary small mt-2">{{ mdDescriptions[activeMdFile] || 'Workspace file read by Claude on startup.' }}</p>
              </div>
            </div>

            <!-- Sub-agent editor -->
            <div v-else>
              <div class="d-flex justify-content-between align-items-center mb-2">
                <ul class="nav nav-tabs border-0 gap-1 flex-wrap">
                  <li v-for="f in ['META.md', 'CLAUDE.md', ...OPTIONAL_FILES.filter(f => subAgentFiles[f] !== undefined)]" :key="f" class="nav-item">
                    <button
                      class="nav-link small py-1 px-2 d-flex align-items-center gap-1"
                      :class="{ active: activeSubAgentFile === f }"
                      @click="activeSubAgentFile = f"
                    >
                      {{ f }}
                      <span
                        v-if="f !== 'META.md' && f !== 'CLAUDE.md'"
                        class="ms-1 text-body-secondary"
                        style="font-size:10px;line-height:1;cursor:pointer"
                        @click.stop="removeCompanionFile(f)"
                        title="Remove file"
                      >&times;</span>
                    </button>
                  </li>
                </ul>
                <div class="d-flex gap-2 ms-2 flex-shrink-0">
                  <!-- Add companion file dropdown -->
                  <div class="dropdown" v-if="OPTIONAL_FILES.some(f => subAgentFiles[f] === undefined)">
                    <button class="btn btn-sm btn-outline-secondary dropdown-toggle" data-bs-toggle="dropdown">
                      <i class="bi bi-plus"></i>
                    </button>
                    <ul class="dropdown-menu dropdown-menu-end">
                      <li v-for="f in OPTIONAL_FILES.filter(f => subAgentFiles[f] === undefined)" :key="f">
                        <button class="dropdown-item small" @click="addCompanionFile(f)">{{ f }}</button>
                      </li>
                    </ul>
                  </div>
                  <button class="btn btn-sm btn-primary" :disabled="savingSubAgent" @click="saveSubAgentCurrentFile">
                    <i class="bi bi-save me-1"></i>{{ savingSubAgent ? 'Saving...' : 'Save' }}
                  </button>
                </div>
              </div>

              <div class="card">
                <div class="card-header small fw-semibold">
                  <i class="bi bi-robot me-1"></i>.claude/agents/{{ selectedAgent }}/{{ activeSubAgentFile }}
                  <span v-if="activeSubAgentFile === 'META.md'" class="text-body-secondary ms-2 fw-normal">-- frontmatter fields (name, description, schedule, model)</span>
                </div>
                <div class="card-body p-0">
                  <textarea
                    :value="subAgentFiles[activeSubAgentFile] || ''"
                    @input="(e: any) => subAgentFiles[activeSubAgentFile] = e.target.value"
                    rows="22" class="form-control font-monospace rounded-0 border-0" spellcheck="false" style="resize:vertical"
                  ></textarea>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>


    </template>
  </div>
</template>
