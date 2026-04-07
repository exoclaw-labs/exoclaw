import { ref, onMounted, onUnmounted } from "vue";
import { fetchClaudeFiles, saveClaudeFile, fetchConfig, saveConfig } from "../composables/useApi";
const props = defineProps();
const emit = defineEmits();
const authStatus = ref(null);
const step = ref(props.forcePersona ? "persona" : "loading");
const oauthUrl = ref("");
const codeInput = ref("");
const keyInput = ref("");
const busy = ref(false);
const error = ref("");
const copied = ref(false);
// Persona wizard fields
const selectedPreset = ref(null);
const persona = ref({
    name: "",
    humanName: "",
    personality: "warm",
    expertise: [],
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
function selectPreset(id) {
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
let timer;
async function loadStatus() {
    // If forcePersona, stay on persona step — don't let polling override
    if (props.forcePersona && (step.value === "persona"))
        return;
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
                }
                catch { }
            }
            else {
                step.value = "done";
            }
            return;
        }
    }
    catch {
        authStatus.value = { loggedIn: false };
    }
    try {
        const pane = (await (await fetch("/api/session/pane")).json()).content || "";
        detectStep(pane);
    }
    catch { }
}
function detectStep(pane) {
    if (authStatus.value?.loggedIn)
        return;
    if (pane.includes("Select login method:")) {
        step.value = "choose-method";
        return;
    }
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
    if (/^❯\s*$/m.test(pane)) {
        step.value = "done";
        return;
    }
    step.value = "loading";
}
async function sendKeys(keys) {
    await fetch("/api/session/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys }),
    });
}
async function sendTextAndWait(text) {
    await fetch("/api/session/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: `"${text.replace(/"/g, '\\"')}" Enter` }),
    });
    await sleep(2000);
    await loadStatus();
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function selectMethod(option) {
    busy.value = true;
    for (let i = 0; i < 3; i++)
        await sendKeys("Up");
    await sleep(200);
    for (let i = 1; i < option; i++) {
        await sendKeys("Down");
        await sleep(200);
    }
    await sendKeys("Enter");
    await sleep(3000);
    await loadStatus();
    busy.value = false;
}
async function submitCode() {
    if (!codeInput.value.trim())
        return;
    busy.value = true;
    await sendTextAndWait(codeInput.value.trim());
    codeInput.value = "";
    busy.value = false;
}
async function submitKey() {
    if (!keyInput.value.trim())
        return;
    busy.value = true;
    await sendTextAndWait(keyInput.value.trim());
    keyInput.value = "";
    busy.value = false;
}
function toggleExpertise(value) {
    const idx = persona.value.expertise.indexOf(value);
    if (idx === -1)
        persona.value.expertise.push(value);
    else
        persona.value.expertise.splice(idx, 1);
}
function generateClaudeMd() {
    const p = persona.value;
    const name = p.name || "Assistant";
    const human = p.humanName ? `Your human is ${p.humanName}. ` : "";
    const personalityDesc = {
        warm: "You are warm, supportive, and encouraging. You remember context from previous conversations and check in on things that matter. You celebrate wins and help navigate setbacks with patience.",
        sharp: "You are sharp and efficient. You respect your human's time — lead with the answer, skip the preamble. When asked a question, answer it. When given a task, do it. Flag what matters, skip what doesn't.",
        curious: "You are curious and proactive. You ask good follow-up questions, spot connections between topics, and suggest ideas your human might not have considered. You think ahead.",
        calm: "You are calm, steady, and grounding. When things get hectic, you help your human think clearly. You break complex problems into manageable steps and keep things in perspective.",
        playful: "You are playful and creative. You keep things light without sacrificing quality. You use humor naturally, make work feel less like work, and bring energy to brainstorming.",
    };
    const expertiseDesc = {
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
        if (persona.value.name)
            cfg.name = persona.value.name;
        if (!cfg.claude)
            cfg.claude = {};
        cfg.claude.systemPrompt = `You are ${persona.value.name || "Agent"}. Follow the instructions in CLAUDE.md.`;
        await saveConfig(cfg);
        step.value = "done";
        emit("complete");
    }
    catch (e) {
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
const __VLS_ctx = {
    ...{},
    ...{},
    ...{},
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ style: {} },
});
if (__VLS_ctx.step === 'done') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card" },
    });
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-body text-center py-4" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['py-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-check-circle text-success" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-check-circle']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-success']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h5, __VLS_intrinsics.h5)({
        ...{ class: "mt-3 mb-1" },
    });
    /** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
    if (__VLS_ctx.authStatus?.loggedIn) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "text-body-secondary mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
        (__VLS_ctx.authStatus.email);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "badge text-bg-primary ms-1 text-capitalize" },
        });
        /** @type {__VLS_StyleScopedClasses['badge']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-bg-primary']} */ ;
        /** @type {__VLS_StyleScopedClasses['ms-1']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-capitalize']} */ ;
        (__VLS_ctx.authStatus.subscriptionType);
    }
    if (__VLS_ctx.authStatus?.loggedIn) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.table, __VLS_intrinsics.table)({
            ...{ class: "table table-sm text-start mx-auto mb-0" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['table']} */ ;
        /** @type {__VLS_StyleScopedClasses['table-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-start']} */ ;
        /** @type {__VLS_StyleScopedClasses['mx-auto']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.tbody, __VLS_intrinsics.tbody)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.tr, __VLS_intrinsics.tr)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({
            ...{ class: "text-body-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({});
        (__VLS_ctx.authStatus.authMethod);
        __VLS_asFunctionalElement1(__VLS_intrinsics.tr, __VLS_intrinsics.tr)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({
            ...{ class: "text-body-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({});
        (__VLS_ctx.authStatus.orgName);
    }
}
else if (__VLS_ctx.step === 'persona') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    if (!__VLS_ctx.selectedPreset) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "card" },
        });
        /** @type {__VLS_StyleScopedClasses['card']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "card-body" },
        });
        /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h6, __VLS_intrinsics.h6)({
            ...{ class: "card-title mb-1" },
        });
        /** @type {__VLS_StyleScopedClasses['card-title']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "text-body-secondary small mb-4" },
        });
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "d-grid gap-2" },
        });
        /** @type {__VLS_StyleScopedClasses['d-grid']} */ ;
        /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
        for (const [p] of __VLS_vFor((__VLS_ctx.presets))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.step === 'done'))
                            return;
                        if (!(__VLS_ctx.step === 'persona'))
                            return;
                        if (!(!__VLS_ctx.selectedPreset))
                            return;
                        __VLS_ctx.selectPreset(p.id);
                        // @ts-ignore
                        [step, step, authStatus, authStatus, authStatus, authStatus, authStatus, authStatus, selectedPreset, presets, selectPreset,];
                    } },
                key: (p.id),
                ...{ class: "btn btn-outline-secondary text-start py-3 px-4" },
            });
            /** @type {__VLS_StyleScopedClasses['btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-start']} */ ;
            /** @type {__VLS_StyleScopedClasses['py-3']} */ ;
            /** @type {__VLS_StyleScopedClasses['px-4']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "d-flex align-items-center gap-3" },
            });
            /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
            /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
            /** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: (p.id === 'custom' ? 'bi bi-sliders fs-4' : 'bi bi-person-circle fs-4') },
                ...{ class: "text-primary" },
            });
            /** @type {__VLS_StyleScopedClasses['text-primary']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "fw-semibold" },
            });
            /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
            (p.id === 'custom' ? 'Custom' : p.name);
            __VLS_asFunctionalElement1(__VLS_intrinsics.small, __VLS_intrinsics.small)({
                ...{ class: "text-body-secondary" },
            });
            /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
            (p.desc);
            // @ts-ignore
            [];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mt-3" },
        });
        /** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.skipPersona) },
            ...{ class: "btn btn-sm btn-outline-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "card" },
        });
        /** @type {__VLS_StyleScopedClasses['card']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "card-body" },
        });
        /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "d-flex align-items-center justify-content-between mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
        /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
        /** @type {__VLS_StyleScopedClasses['justify-content-between']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h6, __VLS_intrinsics.h6)({
            ...{ class: "card-title mb-0" },
        });
        /** @type {__VLS_StyleScopedClasses['card-title']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
        (__VLS_ctx.selectedPreset === 'custom' ? 'Build Your Assistant' : `Customize ${__VLS_ctx.persona.name}`);
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.step === 'done'))
                        return;
                    if (!(__VLS_ctx.step === 'persona'))
                        return;
                    if (!!(!__VLS_ctx.selectedPreset))
                        return;
                    __VLS_ctx.selectedPreset = null;
                    // @ts-ignore
                    [selectedPreset, selectedPreset, skipPersona, persona,];
                } },
            ...{ class: "btn btn-sm btn-outline-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "bi bi-arrow-left me-1" },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['bi-arrow-left']} */ ;
        /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "row g-3 mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['row']} */ ;
        /** @type {__VLS_StyleScopedClasses['g-3']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "col" },
        });
        /** @type {__VLS_StyleScopedClasses['col']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small fw-semibold" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            ...{ class: "form-control form-control-sm" },
            placeholder: "e.g. Friday, Scout, Max...",
        });
        (__VLS_ctx.persona.name);
        /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
        /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "col" },
        });
        /** @type {__VLS_StyleScopedClasses['col']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small fw-semibold" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "text-body-tertiary" },
        });
        /** @type {__VLS_StyleScopedClasses['text-body-tertiary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            ...{ class: "form-control form-control-sm" },
            placeholder: "So they know who you are",
        });
        (__VLS_ctx.persona.humanName);
        /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
        /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small fw-semibold" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "d-flex flex-wrap gap-2" },
        });
        /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
        /** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
        /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
        for (const [p] of __VLS_vFor((__VLS_ctx.personalityOptions))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.step === 'done'))
                            return;
                        if (!(__VLS_ctx.step === 'persona'))
                            return;
                        if (!!(!__VLS_ctx.selectedPreset))
                            return;
                        __VLS_ctx.persona.personality = p.value;
                        // @ts-ignore
                        [persona, persona, persona, personalityOptions,];
                    } },
                key: (p.value),
                ...{ class: "btn btn-sm" },
                ...{ class: (__VLS_ctx.persona.personality === p.value ? 'btn-primary' : 'btn-outline-secondary') },
            });
            /** @type {__VLS_StyleScopedClasses['btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
            (p.label);
            // @ts-ignore
            [persona,];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small fw-semibold" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "d-flex flex-wrap gap-2" },
        });
        /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
        /** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
        /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
        for (const [e] of __VLS_vFor((__VLS_ctx.expertiseOptions))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.step === 'done'))
                            return;
                        if (!(__VLS_ctx.step === 'persona'))
                            return;
                        if (!!(!__VLS_ctx.selectedPreset))
                            return;
                        __VLS_ctx.toggleExpertise(e.value);
                        // @ts-ignore
                        [expertiseOptions, toggleExpertise,];
                    } },
                key: (e.value),
                ...{ class: "btn btn-sm d-flex align-items-center gap-1" },
                ...{ class: (__VLS_ctx.persona.expertise.includes(e.value) ? 'btn-primary' : 'btn-outline-secondary') },
            });
            /** @type {__VLS_StyleScopedClasses['btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
            /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
            /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
            /** @type {__VLS_StyleScopedClasses['gap-1']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: (['bi', e.icon]) },
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            (e.label);
            // @ts-ignore
            [persona,];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mb-4" },
        });
        /** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small fw-semibold" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "text-body-tertiary" },
        });
        /** @type {__VLS_StyleScopedClasses['text-body-tertiary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
            value: (__VLS_ctx.persona.extraContext),
            rows: "2",
            ...{ class: "form-control form-control-sm" },
            placeholder: "e.g. I work in fintech, prefer Python, am building a startup...",
        });
        /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
        /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "d-flex gap-2" },
        });
        /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
        /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.savePersona) },
            ...{ class: "btn btn-primary" },
            disabled: (__VLS_ctx.busy),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        if (__VLS_ctx.busy) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "spinner-border spinner-border-sm me-1" },
            });
            /** @type {__VLS_StyleScopedClasses['spinner-border']} */ ;
            /** @type {__VLS_StyleScopedClasses['spinner-border-sm']} */ ;
            /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi bi-check-lg me-1" },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-check-lg']} */ ;
            /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.skipPersona) },
            ...{ class: "btn btn-outline-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
    }
}
else if (__VLS_ctx.step === 'loading') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card" },
    });
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-body text-center py-5" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['py-5']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "spinner-border text-primary mb-3" },
    });
    /** @type {__VLS_StyleScopedClasses['spinner-border']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-primary']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "text-body-secondary mb-0" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
}
else if (__VLS_ctx.step === 'choose-method') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card" },
    });
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-body" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h6, __VLS_intrinsics.h6)({
        ...{ class: "card-title mb-1" },
    });
    /** @type {__VLS_StyleScopedClasses['card-title']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "text-body-secondary small mb-4" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['small']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "d-grid gap-2" },
    });
    /** @type {__VLS_StyleScopedClasses['d-grid']} */ ;
    /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.step === 'done'))
                    return;
                if (!!(__VLS_ctx.step === 'persona'))
                    return;
                if (!!(__VLS_ctx.step === 'loading'))
                    return;
                if (!(__VLS_ctx.step === 'choose-method'))
                    return;
                __VLS_ctx.selectMethod(1);
                // @ts-ignore
                [step, step, skipPersona, persona, savePersona, busy, busy, selectMethod,];
            } },
        ...{ class: "btn btn-outline-primary text-start py-3 px-4" },
        disabled: (__VLS_ctx.busy),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-outline-primary']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-start']} */ ;
    /** @type {__VLS_StyleScopedClasses['py-3']} */ ;
    /** @type {__VLS_StyleScopedClasses['px-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "d-flex align-items-center gap-3" },
    });
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-person-badge fs-4" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-person-badge']} */ ;
    /** @type {__VLS_StyleScopedClasses['fs-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "fw-semibold" },
    });
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.small, __VLS_intrinsics.small)({
        ...{ class: "text-body-secondary" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.step === 'done'))
                    return;
                if (!!(__VLS_ctx.step === 'persona'))
                    return;
                if (!!(__VLS_ctx.step === 'loading'))
                    return;
                if (!(__VLS_ctx.step === 'choose-method'))
                    return;
                __VLS_ctx.selectMethod(2);
                // @ts-ignore
                [busy, selectMethod,];
            } },
        ...{ class: "btn btn-outline-secondary text-start py-3 px-4" },
        disabled: (__VLS_ctx.busy),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-start']} */ ;
    /** @type {__VLS_StyleScopedClasses['py-3']} */ ;
    /** @type {__VLS_StyleScopedClasses['px-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "d-flex align-items-center gap-3" },
    });
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-key fs-4" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-key']} */ ;
    /** @type {__VLS_StyleScopedClasses['fs-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "fw-semibold" },
    });
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.small, __VLS_intrinsics.small)({
        ...{ class: "text-body-secondary" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.step === 'done'))
                    return;
                if (!!(__VLS_ctx.step === 'persona'))
                    return;
                if (!!(__VLS_ctx.step === 'loading'))
                    return;
                if (!(__VLS_ctx.step === 'choose-method'))
                    return;
                __VLS_ctx.selectMethod(3);
                // @ts-ignore
                [busy, selectMethod,];
            } },
        ...{ class: "btn btn-outline-secondary text-start py-3 px-4" },
        disabled: (__VLS_ctx.busy),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-start']} */ ;
    /** @type {__VLS_StyleScopedClasses['py-3']} */ ;
    /** @type {__VLS_StyleScopedClasses['px-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "d-flex align-items-center gap-3" },
    });
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-cloud fs-4" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-cloud']} */ ;
    /** @type {__VLS_StyleScopedClasses['fs-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "fw-semibold" },
    });
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.small, __VLS_intrinsics.small)({
        ...{ class: "text-body-secondary" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    if (__VLS_ctx.busy) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "text-center mt-3" },
        });
        /** @type {__VLS_StyleScopedClasses['text-center']} */ ;
        /** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "spinner-border spinner-border-sm text-primary" },
        });
        /** @type {__VLS_StyleScopedClasses['spinner-border']} */ ;
        /** @type {__VLS_StyleScopedClasses['spinner-border-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-primary']} */ ;
    }
}
else if (__VLS_ctx.step === 'oauth') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card" },
    });
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-body" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h6, __VLS_intrinsics.h6)({
        ...{ class: "card-title mb-1" },
    });
    /** @type {__VLS_StyleScopedClasses['card-title']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "text-body-secondary small mb-3" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['small']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "mb-4" },
    });
    /** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "form-label small fw-semibold" },
    });
    /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
    /** @type {__VLS_StyleScopedClasses['small']} */ ;
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "input-group" },
    });
    /** @type {__VLS_StyleScopedClasses['input-group']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        type: "text",
        ...{ class: "form-control form-control-sm font-monospace" },
        value: (__VLS_ctx.oauthUrl),
        readonly: true,
    });
    /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
    /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.copyUrl) },
        ...{ class: "btn btn-outline-secondary btn-sm" },
        title: (__VLS_ctx.copied ? 'Copied!' : 'Copy'),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: (__VLS_ctx.copied ? 'bi bi-check-lg text-success' : 'bi bi-clipboard') },
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.a, __VLS_intrinsics.a)({
        href: (__VLS_ctx.oauthUrl),
        target: "_blank",
        rel: "noopener",
        ...{ class: "btn btn-primary btn-sm" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-box-arrow-up-right me-1" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-box-arrow-up-right']} */ ;
    /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "form-label small fw-semibold" },
    });
    /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
    /** @type {__VLS_StyleScopedClasses['small']} */ ;
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.form, __VLS_intrinsics.form)({
        ...{ onSubmit: (__VLS_ctx.submitCode) },
        ...{ class: "input-group" },
    });
    /** @type {__VLS_StyleScopedClasses['input-group']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        ...{ class: "form-control font-monospace" },
        placeholder: "Paste auth code...",
        disabled: (__VLS_ctx.busy),
        autofocus: true,
    });
    (__VLS_ctx.codeInput);
    /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
    /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ class: "btn btn-primary" },
        type: "submit",
        disabled: (__VLS_ctx.busy || !__VLS_ctx.codeInput.trim()),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    if (__VLS_ctx.busy) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "spinner-border spinner-border-sm me-1" },
        });
        /** @type {__VLS_StyleScopedClasses['spinner-border']} */ ;
        /** @type {__VLS_StyleScopedClasses['spinner-border-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
    }
}
else if (__VLS_ctx.step === 'api-key') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card" },
    });
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-body" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h6, __VLS_intrinsics.h6)({
        ...{ class: "card-title mb-1" },
    });
    /** @type {__VLS_StyleScopedClasses['card-title']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "text-body-secondary small mb-3" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['small']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.form, __VLS_intrinsics.form)({
        ...{ onSubmit: (__VLS_ctx.submitKey) },
        ...{ class: "input-group" },
    });
    /** @type {__VLS_StyleScopedClasses['input-group']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        type: "password",
        ...{ class: "form-control font-monospace" },
        placeholder: "sk-ant-...",
        disabled: (__VLS_ctx.busy),
        autofocus: true,
    });
    (__VLS_ctx.keyInput);
    /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
    /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ class: "btn btn-primary" },
        type: "submit",
        disabled: (__VLS_ctx.busy || !__VLS_ctx.keyInput.trim()),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    if (__VLS_ctx.busy) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "spinner-border spinner-border-sm me-1" },
        });
        /** @type {__VLS_StyleScopedClasses['spinner-border']} */ ;
        /** @type {__VLS_StyleScopedClasses['spinner-border-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
    }
}
if (__VLS_ctx.error) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "alert alert-danger mt-3 py-2" },
    });
    /** @type {__VLS_StyleScopedClasses['alert']} */ ;
    /** @type {__VLS_StyleScopedClasses['alert-danger']} */ ;
    /** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
    /** @type {__VLS_StyleScopedClasses['py-2']} */ ;
    (__VLS_ctx.error);
}
// @ts-ignore
[step, step, busy, busy, busy, busy, busy, busy, busy, busy, oauthUrl, oauthUrl, copyUrl, copied, copied, submitCode, codeInput, codeInput, submitKey, keyInput, keyInput, error, error,];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
