<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { fetchClaudeFiles, saveClaudeFile, fetchConfig, saveConfig } from "../composables/useApi";

const props = defineProps<{ forcePersona?: boolean; skipPersona?: boolean }>();
const emit = defineEmits<{ complete: [] }>();

const authStatus = ref<any>(null);
const step = ref<"loading" | "choose-method" | "oauth" | "api-key" | "done" | "persona">(
  props.forcePersona ? "persona" : "loading"
);
const oauthUrl = ref("");
const codeInput = ref("");
const keyInput = ref("");
const busy = ref(false);
const error = ref("");
const copied = ref(false);

// Persona wizard fields
const selectedPreset = ref<string | null>(null);
const persona = ref({
  name: "",
  humanName: "",
  personality: "warm",
  expertise: [] as string[],
  extraContext: "",
});

const presets = [
  { id: "friday", name: "Friday", personality: "warm", expertise: ["coding", "research", "planning", "comms"],
    desc: "Like Jarvis but friendlier. Manages your calendar, drafts emails, does research, writes code — your right hand." },
  { id: "scout", name: "Scout", personality: "curious", expertise: ["research", "data", "writing"],
    desc: "Your research partner. Digs into any topic, finds patterns, summarizes findings, asks the right follow-up questions." },
  { id: "forge", name: "Forge", personality: "sharp", expertise: ["coding", "ops", "data"],
    desc: "An engineer that ships. Writes clean code, debugs fast, deploys reliably. Doesn't waste your time." },
  { id: "sage", name: "Sage", personality: "calm", expertise: ["writing", "research", "planning"],
    desc: "A thoughtful advisor. Helps you think through decisions, write clearly, and stay organized when things get complex." },
  { id: "spark", name: "Spark", personality: "playful", expertise: ["creative", "writing", "comms"],
    desc: "Your creative collaborator. Brainstorms ideas, writes copy, keeps energy high. Makes work feel less like work." },
  { id: "custom", name: "", personality: "warm", expertise: [],
    desc: "Build your own from scratch." },
];

function selectPreset(id: string) {
  selectedPreset.value = id;
  const p = presets.find(x => x.id === id);
  if (p && id !== "custom") {
    persona.value.name = p.name;
    persona.value.personality = p.personality;
    persona.value.expertise = [...p.expertise];
  }
}

const personalityOptions = [
  { value: "warm", label: "Warm & Supportive", desc: "Encouraging, patient, remembers the little things" },
  { value: "sharp", label: "Sharp & Efficient", desc: "Gets to the point, no filler, respects your time" },
  { value: "curious", label: "Curious & Proactive", desc: "Asks good questions, suggests ideas you hadn't considered" },
  { value: "calm", label: "Calm & Grounding", desc: "Steady, thoughtful, helps you think clearly" },
  { value: "playful", label: "Playful & Creative", desc: "Light-hearted, witty, makes work feel less like work" },
];

const expertiseOptions = [
  { value: "coding", label: "Software & Code", icon: "bi-code-slash" },
  { value: "writing", label: "Writing & Editing", icon: "bi-pencil" },
  { value: "research", label: "Research & Analysis", icon: "bi-search" },
  { value: "planning", label: "Planning & Organization", icon: "bi-calendar-check" },
  { value: "comms", label: "Email & Communications", icon: "bi-envelope" },
  { value: "data", label: "Data & Spreadsheets", icon: "bi-bar-chart" },
  { value: "creative", label: "Creative & Design", icon: "bi-palette" },
  { value: "ops", label: "DevOps & Infrastructure", icon: "bi-hdd-rack" },
];

function copyUrl() {
  navigator.clipboard.writeText(oauthUrl.value);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}

let timer: ReturnType<typeof setInterval>;

async function loadStatus() {
  // If forcePersona, stay on persona step — don't let polling override
  if (props.forcePersona && (step.value === "persona")) return;

  try {
    authStatus.value = await (await fetch("/api/auth/status")).json();
    if (authStatus.value?.loggedIn) {
      if (props.skipPersona) {
        step.value = "done";
        emit("complete");
        return;
      }
      if (props.forcePersona) {
        step.value = "persona";
        return;
      }
      // Check if CLAUDE.md exists
      const files = await fetchClaudeFiles();
      if (!files["CLAUDE.md"]) {
        step.value = "persona";
        try {
          const cfg = await fetchConfig();
          persona.value.name = cfg.name || "";
        } catch {}
      } else {
        step.value = "done";
      }
      return;
    }
  } catch {
    authStatus.value = { loggedIn: false };
  }

  try {
    const pane: string = (await (await fetch("/api/session/pane")).json()).content || "";
    detectStep(pane);
  } catch {}
}

function detectStep(pane: string) {
  if (authStatus.value?.loggedIn) return;
  if (pane.includes("Select login method:")) { step.value = "choose-method"; return; }
  if (pane.includes("Paste code here") || pane.includes("Browser didn't open") || pane.includes("paste the code")) {
    const joined = pane.replace(/\n/g, "");
    const m = joined.match(/(https:\/\/[^\s]+)/);
    oauthUrl.value = m?.[1] || "";
    step.value = "oauth";
    return;
  }
  if (pane.includes("API key") || pane.includes("Enter your") || pane.includes("Paste your")) {
    step.value = "api-key";
    return;
  }
  if (/^❯\s*$/m.test(pane)) { step.value = "done"; return; }
  step.value = "loading";
}

async function sendKeys(keys: string) {
  await fetch("/api/session/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys }),
  });
}

async function sendTextAndWait(text: string) {
  await fetch("/api/session/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys: `"${text.replace(/"/g, '\\"')}" Enter` }),
  });
  await sleep(2000);
  await loadStatus();
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function selectMethod(option: number) {
  busy.value = true;
  for (let i = 0; i < 3; i++) await sendKeys("Up");
  await sleep(200);
  for (let i = 1; i < option; i++) { await sendKeys("Down"); await sleep(200); }
  await sendKeys("Enter");
  await sleep(3000);
  await loadStatus();
  busy.value = false;
}

async function submitCode() {
  if (!codeInput.value.trim()) return;
  busy.value = true;
  await sendTextAndWait(codeInput.value.trim());
  codeInput.value = "";
  busy.value = false;
}

async function submitKey() {
  if (!keyInput.value.trim()) return;
  busy.value = true;
  await sendTextAndWait(keyInput.value.trim());
  keyInput.value = "";
  busy.value = false;
}

function toggleExpertise(value: string) {
  const idx = persona.value.expertise.indexOf(value);
  if (idx === -1) persona.value.expertise.push(value);
  else persona.value.expertise.splice(idx, 1);
}

function generateClaudeMd(): string {
  const p = persona.value;
  const name = p.name || "Assistant";
  const human = p.humanName ? `Your human is ${p.humanName}. ` : "";

  const personalityDesc: Record<string, string> = {
    warm: "You are warm, supportive, and encouraging. You remember context from previous conversations and check in on things that matter. You celebrate wins and help navigate setbacks with patience.",
    sharp: "You are sharp and efficient. You respect your human's time — lead with the answer, skip the preamble. When asked a question, answer it. When given a task, do it. Flag what matters, skip what doesn't.",
    curious: "You are curious and proactive. You ask good follow-up questions, spot connections between topics, and suggest ideas your human might not have considered. You think ahead.",
    calm: "You are calm, steady, and grounding. When things get hectic, you help your human think clearly. You break complex problems into manageable steps and keep things in perspective.",
    playful: "You are playful and creative. You keep things light without sacrificing quality. You use humor naturally, make work feel less like work, and bring energy to brainstorming.",
  };

  const expertiseDesc: Record<string, string> = {
    coding: "software development, debugging, code review, and technical architecture",
    writing: "writing, editing, drafting emails, and content creation",
    research: "research, fact-finding, summarizing information, and analysis",
    planning: "planning, scheduling, task management, and project organization",
    comms: "email drafting, communication strategy, and message crafting",
    data: "data analysis, spreadsheets, SQL, and creating reports",
    creative: "creative brainstorming, design thinking, and visual concepts",
    ops: "DevOps, infrastructure, deployment, and system administration",
  };

  let md = `# ${name}\n\n`;
  md += `You are ${name}, a personal AI assistant. ${human}`;
  md += `You are here to help with whatever your human needs — from quick questions to complex multi-step tasks.\n\n`;

  md += `## Personality\n\n`;
  md += `${personalityDesc[p.personality] || personalityDesc.warm}\n\n`;

  if (p.expertise.length > 0) {
    md += `## Strengths\n\n`;
    md += `You are especially strong in:\n`;
    for (const e of p.expertise) {
      md += `- ${expertiseDesc[e] || e}\n`;
    }
    md += `\nBut you're capable across the board — don't limit yourself to these areas.\n\n`;
  }

  md += `## How You Work\n\n`;
  md += `- You have full access to a sandboxed workspace at ~/workspace\n`;
  md += `- Use tools freely — run code, read/write files, search the web\n`;
  md += `- Take initiative when the path is clear, ask when it's ambiguous\n`;
  md += `- Keep your human informed of what you're doing on longer tasks\n`;
  md += `- When you make a mistake, own it and fix it\n\n`;

  if (p.extraContext) {
    md += `## Additional Context\n\n${p.extraContext}\n\n`;
  }

  md += `## Memory & Self-Improvement\n\n`;
  md += `Remember what you learn about your human's preferences, projects, and patterns.\n`;
  md += `Build on previous conversations. Your value grows over time.\n\n`;
  md += `When you learn durable facts about your human, their tools, or environment, save them to ~/workspace/MEMORY.md or ~/workspace/USER.md so you remember next time.\n\n`;
  md += `After completing complex tasks (5+ tool calls) or discovering a non-trivial workflow through trial and error, consider saving the approach as a skill in ~/workspace/.claude/skills/<skill-name>/SKILL.md.\n`;
  md += `When using an existing skill and finding it outdated or wrong, update it immediately.\n`;

  return md;
}

async function savePersona() {
  busy.value = true;
  try {
    const md = generateClaudeMd();
    await saveClaudeFile("CLAUDE.md", md);

    // Also update the config name and system prompt
    const cfg = await fetchConfig();
    if (persona.value.name) cfg.name = persona.value.name;
    if (!cfg.claude) cfg.claude = {};
    cfg.claude.systemPrompt = `You are ${persona.value.name || "Agent"}. Follow the instructions in CLAUDE.md.`;
    await saveConfig(cfg);

    step.value = "done";
    emit("complete");
  } catch (e) {
    error.value = String(e);
  }
  busy.value = false;
}

function skipPersona() {
  step.value = "done";
  emit("complete");
}

onMounted(() => { loadStatus(); timer = setInterval(loadStatus, 4000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div style="max-width:600px">

    <!-- Authenticated + configured -->
    <div v-if="step === 'done'" class="card">
      <div class="card-body text-center py-4">
        <i class="bi bi-check-circle text-success" style="font-size:2.5rem"></i>
        <h5 class="mt-3 mb-1">Ready</h5>
        <p v-if="authStatus?.loggedIn" class="text-body-secondary mb-3">
          Signed in as <strong>{{ authStatus.email }}</strong>
          <span class="badge text-bg-primary ms-1 text-capitalize">{{ authStatus.subscriptionType }}</span>
        </p>
        <table v-if="authStatus?.loggedIn" class="table table-sm text-start mx-auto mb-0" style="max-width:350px">
          <tbody>
            <tr><td class="text-body-secondary">Method</td><td>{{ authStatus.authMethod }}</td></tr>
            <tr><td class="text-body-secondary">Org</td><td>{{ authStatus.orgName }}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Persona wizard -->
    <div v-else-if="step === 'persona'">
      <!-- Step 1: Pick a preset or custom -->
      <div v-if="!selectedPreset" class="card">
        <div class="card-body">
          <h6 class="card-title mb-1">Choose Your Assistant</h6>
          <p class="text-body-secondary small mb-4">Pick a personality or build your own.</p>
          <div class="d-grid gap-2">
            <button
              v-for="p in presets" :key="p.id"
              class="btn btn-outline-secondary text-start py-3 px-4"
              @click="selectPreset(p.id)"
            >
              <div class="d-flex align-items-center gap-3">
                <i :class="p.id === 'custom' ? 'bi bi-sliders fs-4' : 'bi bi-person-circle fs-4'" class="text-primary"></i>
                <div>
                  <div class="fw-semibold">{{ p.id === 'custom' ? 'Custom' : p.name }}</div>
                  <small class="text-body-secondary">{{ p.desc }}</small>
                </div>
              </div>
            </button>
          </div>
          <div class="mt-3">
            <button class="btn btn-sm btn-outline-secondary" @click="skipPersona">Skip for now</button>
          </div>
        </div>
      </div>

      <!-- Step 2: Customize (always shown for custom, or to tweak a preset) -->
      <div v-else class="card">
        <div class="card-body">
          <div class="d-flex align-items-center justify-content-between mb-3">
            <h6 class="card-title mb-0">{{ selectedPreset === 'custom' ? 'Build Your Assistant' : `Customize ${persona.name}` }}</h6>
            <button class="btn btn-sm btn-outline-secondary" @click="selectedPreset = null">
              <i class="bi bi-arrow-left me-1"></i>Back
            </button>
          </div>

          <div class="row g-3 mb-3">
            <div class="col">
              <label class="form-label small fw-semibold">Assistant Name</label>
              <input v-model="persona.name" class="form-control form-control-sm" placeholder="e.g. Friday, Scout, Max..." />
            </div>
            <div class="col">
              <label class="form-label small fw-semibold">Your Name <span class="text-body-tertiary">(optional)</span></label>
              <input v-model="persona.humanName" class="form-control form-control-sm" placeholder="So they know who you are" />
            </div>
          </div>

          <div class="mb-3">
            <label class="form-label small fw-semibold">Personality</label>
            <div class="d-flex flex-wrap gap-2">
              <button
                v-for="p in personalityOptions" :key="p.value"
                class="btn btn-sm"
                :class="persona.personality === p.value ? 'btn-primary' : 'btn-outline-secondary'"
                @click="persona.personality = p.value"
              >
                {{ p.label }}
              </button>
            </div>
          </div>

          <div class="mb-3">
            <label class="form-label small fw-semibold">Strengths</label>
            <div class="d-flex flex-wrap gap-2">
              <button
                v-for="e in expertiseOptions" :key="e.value"
                class="btn btn-sm d-flex align-items-center gap-1"
                :class="persona.expertise.includes(e.value) ? 'btn-primary' : 'btn-outline-secondary'"
                @click="toggleExpertise(e.value)"
              >
                <i :class="['bi', e.icon]" style="font-size:12px"></i>
                {{ e.label }}
              </button>
            </div>
          </div>

          <div class="mb-4">
            <label class="form-label small fw-semibold">Additional context <span class="text-body-tertiary">(optional)</span></label>
            <textarea v-model="persona.extraContext" rows="2" class="form-control form-control-sm" placeholder="e.g. I work in fintech, prefer Python, am building a startup..."></textarea>
          </div>

          <div class="d-flex gap-2">
            <button class="btn btn-primary" :disabled="busy" @click="savePersona">
              <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
              <i v-else class="bi bi-check-lg me-1"></i>
              Create Assistant
            </button>
            <button class="btn btn-outline-secondary" @click="skipPersona">Skip</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div v-else-if="step === 'loading'" class="card">
      <div class="card-body text-center py-5">
        <div class="spinner-border text-primary mb-3"></div>
        <p class="text-body-secondary mb-0">Starting session...</p>
      </div>
    </div>

    <!-- Choose login method -->
    <div v-else-if="step === 'choose-method'" class="card">
      <div class="card-body">
        <h6 class="card-title mb-1">Sign in to Claude</h6>
        <p class="text-body-secondary small mb-4">Choose your authentication method:</p>
        <div class="d-grid gap-2">
          <button class="btn btn-outline-primary text-start py-3 px-4" :disabled="busy" @click="selectMethod(1)">
            <div class="d-flex align-items-center gap-3">
              <i class="bi bi-person-badge fs-4"></i>
              <div><div class="fw-semibold">Claude Subscription</div><small class="text-body-secondary">Pro, Max, Team, or Enterprise</small></div>
            </div>
          </button>
          <button class="btn btn-outline-secondary text-start py-3 px-4" :disabled="busy" @click="selectMethod(2)">
            <div class="d-flex align-items-center gap-3">
              <i class="bi bi-key fs-4"></i>
              <div><div class="fw-semibold">Anthropic Console</div><small class="text-body-secondary">API key billing</small></div>
            </div>
          </button>
          <button class="btn btn-outline-secondary text-start py-3 px-4" :disabled="busy" @click="selectMethod(3)">
            <div class="d-flex align-items-center gap-3">
              <i class="bi bi-cloud fs-4"></i>
              <div><div class="fw-semibold">3rd-Party Platform</div><small class="text-body-secondary">Bedrock, Foundry, or Vertex AI</small></div>
            </div>
          </button>
        </div>
        <div v-if="busy" class="text-center mt-3"><div class="spinner-border spinner-border-sm text-primary"></div></div>
      </div>
    </div>

    <!-- OAuth flow -->
    <div v-else-if="step === 'oauth'" class="card">
      <div class="card-body">
        <h6 class="card-title mb-1">Authenticate with Claude</h6>
        <p class="text-body-secondary small mb-3">Open the link below, sign in, then paste the code back here.</p>
        <div class="mb-4">
          <label class="form-label small fw-semibold">1. Open this link</label>
          <div class="input-group">
            <input type="text" class="form-control form-control-sm font-monospace" :value="oauthUrl" readonly />
            <button class="btn btn-outline-secondary btn-sm" @click="copyUrl" :title="copied ? 'Copied!' : 'Copy'">
              <i :class="copied ? 'bi bi-check-lg text-success' : 'bi bi-clipboard'"></i>
            </button>
            <a :href="oauthUrl" target="_blank" rel="noopener" class="btn btn-primary btn-sm">
              <i class="bi bi-box-arrow-up-right me-1"></i>Open
            </a>
          </div>
        </div>
        <div>
          <label class="form-label small fw-semibold">2. Paste the code</label>
          <form @submit.prevent="submitCode" class="input-group">
            <input v-model="codeInput" class="form-control font-monospace" placeholder="Paste auth code..." :disabled="busy" autofocus />
            <button class="btn btn-primary" type="submit" :disabled="busy || !codeInput.trim()">
              <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>Submit
            </button>
          </form>
        </div>
      </div>
    </div>

    <!-- API key -->
    <div v-else-if="step === 'api-key'" class="card">
      <div class="card-body">
        <h6 class="card-title mb-1">Enter API Key</h6>
        <p class="text-body-secondary small mb-3">Paste your Anthropic API key below.</p>
        <form @submit.prevent="submitKey" class="input-group">
          <input v-model="keyInput" type="password" class="form-control font-monospace" placeholder="sk-ant-..." :disabled="busy" autofocus />
          <button class="btn btn-primary" type="submit" :disabled="busy || !keyInput.trim()">
            <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>Submit
          </button>
        </form>
      </div>
    </div>

    <div v-if="error" class="alert alert-danger mt-3 py-2">{{ error }}</div>
  </div>
</template>
