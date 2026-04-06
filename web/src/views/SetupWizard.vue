<script setup lang="ts">
import { ref } from "vue";
import { completeSetup } from "../composables/useApi";
import Setup from "./Setup.vue";

const emit = defineEmits<{ complete: [] }>();

type WizardStep = "welcome" | "login" | "browser" | "integrations" | "persona" | "complete";
const currentStep = ref<WizardStep>("welcome");
const stepIndex = { welcome: 0, login: 1, browser: 2, integrations: 3, persona: 4, complete: 5 };
const steps = ["Welcome", "Login", "Browser", "Integrations", "Persona", "Complete"];

// Browser tool selection
const browserTool = ref<"gologin" | "browser-use" | "agent-browser" | "none">("gologin");
const browserApiKey = ref("");

// Composio integration
const composioEnabled = ref(false);
const composioApiKey = ref("");

// Auth info (fetched after login)
const authInfo = ref<any>(null);
const personaName = ref("");
const saving = ref(false);
const error = ref("");

function onLoginComplete() {
  // Fetch auth status for the summary
  fetch("/api/auth/status").then(r => r.json()).then(data => { authInfo.value = data; }).catch(() => {});
  currentStep.value = "browser";
}

function onBrowserContinue() {
  currentStep.value = "integrations";
}

function onIntegrationsContinue() {
  currentStep.value = "persona";
}

function onPersonaComplete() {
  currentStep.value = "complete";
}

function skipPersona() {
  currentStep.value = "complete";
}

async function launch() {
  saving.value = true;
  error.value = "";
  try {
    const key = (browserTool.value === "gologin" || browserTool.value === "browser-use")
      ? browserApiKey.value.trim()
      : undefined;
    await completeSetup(
      browserTool.value,
      key,
      composioEnabled.value ? composioApiKey.value.trim() : undefined,
    );
    emit("complete");
  } catch (e) {
    error.value = String(e);
  }
  saving.value = false;
}

const browserOptions = [
  {
    id: "gologin" as const,
    name: "GoLogin",
    icon: "bi-globe2",
    desc: "Cloud browser profiles with anti-detection. Managed remotely — no local Chrome needed.",
    badge: "Recommended",
    needsKey: true,
    keyPlaceholder: "GoLogin API token",
    keyHint: "Get your token from app.gologin.com > API settings",
  },
  {
    id: "browser-use" as const,
    name: "Browser Use",
    icon: "bi-cloud",
    desc: "AI-powered cloud browser automation. Runs remotely via the Browser Use API.",
    badge: null,
    needsKey: true,
    keyPlaceholder: "Browser Use API key",
    keyHint: "Get your key from cloud.browser-use.com",
  },
  {
    id: "agent-browser" as const,
    name: "Local Chrome",
    icon: "bi-window",
    desc: "Headless Chrome running inside the container. Works out of the box, no API key needed.",
    badge: null,
    needsKey: false,
    keyPlaceholder: "",
    keyHint: "",
  },
  {
    id: "none" as const,
    name: "No Browser",
    icon: "bi-x-circle",
    desc: "Skip browser tools entirely. You can add one later from the config page.",
    badge: null,
    needsKey: false,
    keyPlaceholder: "",
    keyHint: "",
  },
];
</script>

<template>
  <div class="d-flex flex-column align-items-center justify-content-center min-vh-100 p-4">
    <!-- Progress dots -->
    <div class="d-flex gap-2 mb-4">
      <div
        v-for="(s, i) in steps" :key="s"
        class="rounded-pill d-flex align-items-center gap-1 px-2 py-1"
        :class="i === stepIndex[currentStep]
          ? 'bg-primary text-white'
          : i < stepIndex[currentStep]
            ? 'bg-primary bg-opacity-25 text-primary'
            : 'bg-body-secondary text-body-tertiary'"
        style="font-size: 0.7rem"
      >
        <i v-if="i < stepIndex[currentStep]" class="bi bi-check-lg"></i>
        {{ s }}
      </div>
    </div>

    <div style="max-width: 600px; width: 100%">

      <!-- ═══ Welcome ═══ -->
      <div v-if="currentStep === 'welcome'" class="text-center">
        <div class="mb-4">
          <i class="bi bi-cpu text-primary" style="font-size: 3rem"></i>
        </div>
        <h3 class="fw-semibold mb-2">Welcome to ExoClaw</h3>
        <p class="text-body-secondary mb-4">
          Your personal Claude Code gateway. Let's get you set up — it only takes a minute.
        </p>
        <button class="btn btn-primary btn-lg px-5" @click="currentStep = 'login'">
          Get Started <i class="bi bi-arrow-right ms-1"></i>
        </button>
      </div>

      <!-- ═══ Login ═══ -->
      <div v-else-if="currentStep === 'login'">
        <h5 class="fw-semibold mb-1">Sign in to Claude</h5>
        <p class="text-body-secondary small mb-3">Authenticate with your Claude subscription or API key.</p>
        <Setup :skip-persona="true" @complete="onLoginComplete" />
      </div>

      <!-- ═══ Browser Tools ═══ -->
      <div v-else-if="currentStep === 'browser'">
        <h5 class="fw-semibold mb-1">Browser Tools</h5>
        <p class="text-body-secondary small mb-3">Choose how your agent browses the web. Cloud browsers are preferred — no local dependencies.</p>

        <div class="d-grid gap-2 mb-3">
          <button
            v-for="opt in browserOptions" :key="opt.id"
            class="btn text-start py-3 px-4"
            :class="browserTool === opt.id ? 'btn-outline-primary border-primary' : 'btn-outline-secondary'"
            @click="browserTool = opt.id; browserApiKey = ''"
          >
            <div class="d-flex align-items-center gap-3">
              <i :class="['bi', opt.icon, 'fs-4']" :style="browserTool === opt.id ? 'color: var(--bs-primary)' : ''"></i>
              <div class="flex-grow-1">
                <div class="fw-semibold">
                  {{ opt.name }}
                  <span v-if="opt.badge" class="badge text-bg-primary ms-1" style="font-size:0.65rem">{{ opt.badge }}</span>
                </div>
                <small class="text-body-secondary">{{ opt.desc }}</small>
              </div>
              <i v-if="browserTool === opt.id" class="bi bi-check-circle-fill text-primary"></i>
            </div>
          </button>
        </div>

        <!-- API key input for cloud options -->
        <div v-if="browserOptions.find(o => o.id === browserTool)?.needsKey" class="card mb-3">
          <div class="card-body py-3">
            <label class="form-label small fw-semibold mb-1">API Key</label>
            <input
              v-model="browserApiKey"
              type="password"
              class="form-control form-control-sm font-monospace"
              :placeholder="browserOptions.find(o => o.id === browserTool)?.keyPlaceholder"
            />
            <div class="form-text small">{{ browserOptions.find(o => o.id === browserTool)?.keyHint }}</div>
          </div>
        </div>

        <button class="btn btn-primary" @click="onBrowserContinue">
          Continue <i class="bi bi-arrow-right ms-1"></i>
        </button>
      </div>

      <!-- ═══ Integrations (Composio) ═══ -->
      <div v-else-if="currentStep === 'integrations'">
        <h5 class="fw-semibold mb-1">Integrations</h5>
        <p class="text-body-secondary small mb-3">Connect your agent to external services. These are optional — you can configure them later.</p>

        <div class="card mb-3">
          <div class="card-body">
            <div class="d-flex align-items-start gap-3">
              <div class="form-check form-switch mt-1">
                <input v-model="composioEnabled" class="form-check-input" type="checkbox" id="composio-toggle" />
              </div>
              <label for="composio-toggle" class="flex-grow-1" style="cursor: pointer">
                <div class="fw-semibold">
                  Composio
                  <span class="badge text-bg-info ms-1" style="font-size:0.6rem">500+ tools</span>
                </div>
                <small class="text-body-secondary d-block mt-1">
                  Connect Gmail, Google Sheets, Slack, GitHub, Notion, Salesforce, and hundreds more.
                  Composio handles all the OAuth plumbing — one API key unlocks everything.
                </small>
              </label>
            </div>

            <div v-if="composioEnabled" class="mt-3 ps-5">
              <label class="form-label small fw-semibold mb-1">Composio API Key</label>
              <input
                v-model="composioApiKey"
                type="password"
                class="form-control form-control-sm font-monospace"
                placeholder="ck_..."
              />
              <div class="form-text small">Get your key from <a href="https://composio.dev" target="_blank" rel="noopener">composio.dev</a> — then connect apps from their dashboard.</div>
            </div>
          </div>
        </div>

        <button class="btn btn-primary" @click="onIntegrationsContinue">
          Continue <i class="bi bi-arrow-right ms-1"></i>
        </button>
      </div>

      <!-- ═══ Persona ═══ -->
      <div v-else-if="currentStep === 'persona'">
        <h5 class="fw-semibold mb-1">Create Your Agent</h5>
        <p class="text-body-secondary small mb-3">Give your agent a personality and focus areas, or skip to use defaults.</p>
        <Setup :force-persona="true" @complete="onPersonaComplete" />
      </div>

      <!-- ═══ Complete ═══ -->
      <div v-else-if="currentStep === 'complete'">
        <div class="card">
          <div class="card-body text-center py-4">
            <i class="bi bi-check-circle text-success" style="font-size: 2.5rem"></i>
            <h5 class="mt-3 mb-3">You're all set</h5>

            <table class="table table-sm text-start mx-auto mb-4" style="max-width: 350px">
              <tbody>
                <tr v-if="authInfo?.email">
                  <td class="text-body-secondary">Account</td>
                  <td>{{ authInfo.email }}</td>
                </tr>
                <tr>
                  <td class="text-body-secondary">Browser</td>
                  <td class="text-capitalize">
                    {{ browserTool === "agent-browser" ? "Local Chrome" : browserTool === "none" ? "None" : browserOptions.find(o => o.id === browserTool)?.name }}
                  </td>
                </tr>
                <tr>
                  <td class="text-body-secondary">Composio</td>
                  <td>{{ composioEnabled ? 'Enabled' : 'Skipped' }}</td>
                </tr>
              </tbody>
            </table>

            <div v-if="error" class="alert alert-danger py-2 mb-3">{{ error }}</div>

            <button class="btn btn-primary btn-lg px-5" :disabled="saving" @click="launch">
              <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>
              Launch Dashboard <i class="bi bi-arrow-right ms-1"></i>
            </button>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>
