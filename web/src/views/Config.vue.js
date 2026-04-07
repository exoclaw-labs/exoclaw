import { ref, computed, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import { fetchConfig, saveConfig, fetchClaudeFiles, saveClaudeFile, fetchSubAgents, saveSubAgentFile, deleteSubAgent, deleteSubAgentFile } from "../composables/useApi";
import Setup from "./Setup.vue";
const route = useRoute();
const section = computed(() => route.params.section || "overview");
const config = ref({});
const claudeFiles = ref({});
const jsonText = ref("");
const saving = ref(false);
const showPersonaWizard = ref(false);
const activeJsonFile = ref(".mcp.json");
const skills = ref([]);
const activeSkill = ref(null);
const skillContent = ref("");
const newSkillName = ref("");
const dragging = ref(false);
async function loadSkills() {
    try {
        const res = await fetch("/api/skills");
        skills.value = (await res.json()).skills || [];
    }
    catch { }
}
function selectSkill(name) {
    activeSkill.value = name;
    const s = skills.value.find(x => x.name === name);
    skillContent.value = s?.content || "";
}
async function saveSkill() {
    if (!activeSkill.value)
        return;
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
    if (!name)
        return;
    await fetch(`/api/skills/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `# ${name}\n\nDescribe this skill...\n` }),
    });
    newSkillName.value = "";
    await loadSkills();
    selectSkill(name);
}
async function deleteSkill(name) {
    if (!confirm(`Delete skill "${name}"?`))
        return;
    await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (activeSkill.value === name) {
        activeSkill.value = null;
        skillContent.value = "";
    }
    await loadSkills();
}
function handleDrop(e) {
    dragging.value = false;
    const files = e.dataTransfer?.files;
    if (!files)
        return;
    for (const file of Array.from(files)) {
        if (!file.name.endsWith(".md"))
            continue;
        const name = file.name.replace(/\.md$/i, "").replace(/^SKILL$/i, "skill").toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const reader = new FileReader();
        reader.onload = async () => {
            await fetch(`/api/skills/${encodeURIComponent(name)}`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ content: reader.result }),
            });
            await loadSkills();
            selectSkill(name);
        };
        reader.readAsText(file);
    }
}
const subAgents = ref([]);
const selectedAgent = ref("__main__");
const subAgentFiles = ref({});
const newAgentName = ref("");
const currentFile = ref("CLAUDE.md");
const MAIN_FILES = ["CLAUDE.md", "IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"];
const SUB_FILES = ["META.md", "CLAUDE.md", "IDENTITY.md", "SOUL.md", "USER.md", "MEMORY.md", "TOOLS.md", "HEARTBEAT.md"];
const MAIN_REQUIRED = ["CLAUDE.md"];
const SUB_REQUIRED = ["META.md", "CLAUDE.md"];
async function loadSubAgents() {
    subAgents.value = await fetchSubAgents();
}
const visibleTabs = computed(() => {
    if (selectedAgent.value === "__main__") {
        return MAIN_FILES.filter(f => claudeFiles.value[f] !== undefined);
    }
    return SUB_FILES.filter(f => subAgentFiles.value[f] !== undefined);
});
const addableFiles = computed(() => {
    if (selectedAgent.value === "__main__") {
        return MAIN_FILES.filter(f => claudeFiles.value[f] === undefined);
    }
    return SUB_FILES.filter(f => subAgentFiles.value[f] === undefined && !SUB_REQUIRED.includes(f));
});
function selectAgent(name) {
    selectedAgent.value = name;
    if (name === "__main__") {
        currentFile.value = "CLAUDE.md";
    }
    else {
        const a = subAgents.value.find(x => x.name === name);
        subAgentFiles.value = a ? { ...a.files } : {};
        currentFile.value = "META.md";
    }
}
function onSelectAgentChange(e) {
    selectAgent(e.target.value);
}
async function createSubAgent() {
    const name = newAgentName.value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    if (!name)
        return;
    await saveSubAgentFile(name, "META.md", `name: ${name}\ndescription: \nschedule: \nmodel: claude-sonnet-4-6\n`);
    await saveSubAgentFile(name, "CLAUDE.md", `# ${name}\n\nAgent instructions here...\n`);
    newAgentName.value = "";
    await loadSubAgents();
    selectAgent(name);
}
async function removeSubAgent(name) {
    if (!confirm(`Delete agent "${name}"?`))
        return;
    await deleteSubAgent(name);
    if (selectedAgent.value === name)
        selectAgent("__main__");
    await loadSubAgents();
}
async function addFile(file) {
    if (selectedAgent.value === "__main__") {
        claudeFiles.value[file] = "";
    }
    else {
        subAgentFiles.value[file] = `# ${file.replace(".md", "")}\n\n`;
        await saveSubAgentFile(selectedAgent.value, file, subAgentFiles.value[file]);
        await loadSubAgents();
    }
    currentFile.value = file;
}
async function removeFile(file) {
    if (!confirm(`Remove ${file}?`))
        return;
    if (selectedAgent.value === "__main__") {
        delete claudeFiles.value[file];
        await saveClaudeFile(file, "");
    }
    else {
        await deleteSubAgentFile(selectedAgent.value, file);
        delete subAgentFiles.value[file];
        await loadSubAgents();
    }
    currentFile.value = selectedAgent.value === "__main__" ? "CLAUDE.md" : "META.md";
}
function canRemoveFile(f) {
    if (selectedAgent.value === "__main__")
        return !MAIN_REQUIRED.includes(f);
    return !SUB_REQUIRED.includes(f);
}
function getFileContent() {
    if (selectedAgent.value === "__main__")
        return claudeFiles.value[currentFile.value] || "";
    return subAgentFiles.value[currentFile.value] || "";
}
function setFileContent(val) {
    if (selectedAgent.value === "__main__") {
        onClaudeFileEdit(currentFile.value, val);
    }
    else {
        subAgentFiles.value[currentFile.value] = val;
    }
}
const mdFiles = ["CLAUDE.md", "IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"];
const mdDescriptions = {
    "CLAUDE.md": "Primary instructions for the Claude session. Use the Persona Wizard to generate from scratch.",
    "IDENTITY.md": "Agent identity — name, personality, how it presents itself.",
    "SOUL.md": "Core values and behavioral guidelines the agent follows.",
    "USER.md": "Information about the human this agent works with.",
    "AGENTS.md": "Workspace guidelines for agent behavior and boundaries.",
    "TOOLS.md": "Notes about available tools and how to use them.",
    "MEMORY.md": "Long-term curated memories and learned preferences.",
    "HEARTBEAT.md": "Proactive task checklist — things to check on periodically.",
};
const mdPlaceholders = {
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
const jsonDescriptions = {
    ".mcp.json": "Workspace MCP servers. Claude reads this natively. Servers from exoclaw config are merged here on startup.",
    "settings.json": "Claude Code user settings (persisted in ~/.claude/).",
    "settings.local.json": "Claude Code local settings override.",
    "config.json": "ExoClaw gateway configuration (the full config that drives everything).",
};
const msg = ref(null);
const loading = ref(true);
// Sync JSON text when config changes (non-JSON sections)
watch(config, (v) => {
    if (section.value !== "json")
        jsonText.value = JSON.stringify(v, null, 2);
}, { deep: true });
function applyJson() {
    try {
        config.value = JSON.parse(jsonText.value);
        msg.value = null;
    }
    catch (e) {
        msg.value = { type: "danger", text: `Invalid JSON: ${e}` };
    }
}
async function load() {
    loading.value = true;
    try {
        const [cfg, files] = await Promise.all([fetchConfig(), fetchClaudeFiles()]);
        // remoteControl defaults to true in the runtime (enabled unless explicitly false)
        if (cfg.claude && cfg.claude.remoteControl === undefined)
            cfg.claude.remoteControl = true;
        config.value = cfg;
        claudeFiles.value = files;
        jsonText.value = JSON.stringify(cfg, null, 2);
        await loadSkills();
        await loadSubAgents();
    }
    catch (e) {
        msg.value = { type: "danger", text: `Load failed: ${e}` };
    }
    loading.value = false;
}
async function handleSave() {
    saving.value = true;
    msg.value = null;
    try {
        if (section.value === "json")
            applyJson();
        if (msg.value) {
            saving.value = false;
            return;
        }
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
        // Save sub-agent files when on the agents page
        if (section.value === "agents" && selectedAgent.value !== "__main__") {
            for (const [file, content] of Object.entries(subAgentFiles.value)) {
                await saveSubAgentFile(selectedAgent.value, file, content);
            }
            await loadSubAgents();
        }
        msg.value = { type: "success", text: "Saved. Restart container to apply session changes." };
    }
    catch (e) {
        msg.value = { type: "danger", text: `Save failed: ${e}` };
    }
    saving.value = false;
}
const restarting = ref(false);
async function restartSession() {
    restarting.value = true;
    try {
        await fetch("/api/session/restart", { method: "POST" });
    }
    catch { }
    await new Promise(r => setTimeout(r, 3000));
    restarting.value = false;
    msg.value = { type: "success", text: "Session restarted." };
}
function onClaudeFileEdit(name, content) {
    claudeFiles.value[name] = content;
    if (name === "settings.json") {
        try {
            config.value.claude.settingsJson = JSON.parse(content);
        }
        catch { }
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
    }
    catch (e) {
        msg.value = { type: "danger", text: `Failed: ${e}` };
    }
}
onMounted(load);
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "p-4" },
});
/** @type {__VLS_StyleScopedClasses['p-4']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "d-flex justify-content-between align-items-center mb-3" },
});
/** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-content-between']} */ ;
/** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h6, __VLS_intrinsics.h6)({
    ...{ class: "mb-0" },
});
/** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
(__VLS_ctx.section === 'overview' ? 'Configuration' : '');
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "d-flex gap-2" },
});
/** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.handleSave) },
    ...{ class: "btn btn-primary btn-sm" },
    disabled: (__VLS_ctx.saving),
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
    ...{ class: "bi bi-save me-1" },
});
/** @type {__VLS_StyleScopedClasses['bi']} */ ;
/** @type {__VLS_StyleScopedClasses['bi-save']} */ ;
/** @type {__VLS_StyleScopedClasses['me-1']} */ ;
(__VLS_ctx.saving ? 'Saving...' : 'Save');
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.restartSession) },
    ...{ class: "btn btn-outline-warning btn-sm" },
    disabled: (__VLS_ctx.restarting),
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-outline-warning']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
if (__VLS_ctx.restarting) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "spinner-border spinner-border-sm me-1" },
    });
    /** @type {__VLS_StyleScopedClasses['spinner-border']} */ ;
    /** @type {__VLS_StyleScopedClasses['spinner-border-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-arrow-clockwise me-1" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-arrow-clockwise']} */ ;
    /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
}
(__VLS_ctx.restarting ? 'Restarting...' : 'Restart');
if (__VLS_ctx.msg) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "alert py-2 px-3" },
        ...{ class: (`alert-${__VLS_ctx.msg.type}`) },
    });
    /** @type {__VLS_StyleScopedClasses['alert']} */ ;
    /** @type {__VLS_StyleScopedClasses['py-2']} */ ;
    /** @type {__VLS_StyleScopedClasses['px-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: (__VLS_ctx.msg.type === 'success' ? 'bi bi-check-circle' : 'bi bi-exclamation-triangle') },
        ...{ class: "me-1" },
    });
    /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
    (__VLS_ctx.msg.text);
}
if (__VLS_ctx.loading) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "text-body-secondary" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
}
else {
    if (__VLS_ctx.section === 'overview') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
        const __VLS_0 = Setup;
        // @ts-ignore
        const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({}));
        const __VLS_2 = __VLS_1({}, ...__VLS_functionalComponentArgsRest(__VLS_1));
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mt-3" },
        });
        /** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.rerunSetup) },
            ...{ class: "btn btn-sm btn-outline-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "bi bi-arrow-repeat me-1" },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['bi-arrow-repeat']} */ ;
        /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
    }
    if (__VLS_ctx.section === 'general') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "card" },
        });
        /** @type {__VLS_StyleScopedClasses['card']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "card-body" },
        });
        /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small text-body-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            ...{ class: "form-control form-control-sm font-monospace" },
        });
        (__VLS_ctx.config.name);
        /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
        /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small text-body-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            ...{ class: "form-control form-control-sm font-monospace" },
        });
        (__VLS_ctx.config.claude.model);
        /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
        /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small text-body-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
            value: (__VLS_ctx.config.claude.permissionMode),
            ...{ class: "form-select form-select-sm" },
        });
        /** @type {__VLS_StyleScopedClasses['form-select']} */ ;
        /** @type {__VLS_StyleScopedClasses['form-select-sm']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "auto",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "bypassPermissions",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "default",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "plan",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "acceptEdits",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-check form-switch" },
        });
        /** @type {__VLS_StyleScopedClasses['form-check']} */ ;
        /** @type {__VLS_StyleScopedClasses['form-switch']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            ...{ class: "form-check-input" },
            type: "checkbox",
            id: "rc",
        });
        (__VLS_ctx.config.claude.remoteControl);
        /** @type {__VLS_StyleScopedClasses['form-check-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-check-label small text-body-secondary" },
            for: "rc",
        });
        /** @type {__VLS_StyleScopedClasses['form-check-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.hr)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small text-body-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "number",
            ...{ class: "form-control form-control-sm font-monospace" },
        });
        (__VLS_ctx.config.port);
        /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
        /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small text-body-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "password",
            ...{ class: "form-control form-control-sm font-monospace" },
            placeholder: "Leave empty for no auth",
        });
        (__VLS_ctx.config.apiToken);
        /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
        /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
    }
    if (__VLS_ctx.section === 'channels') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "d-flex justify-content-between align-items-center mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
        /** @type {__VLS_StyleScopedClasses['justify-content-between']} */ ;
        /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "text-body-secondary small" },
        });
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "dropdown" },
        });
        /** @type {__VLS_StyleScopedClasses['dropdown']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ class: "btn btn-sm btn-outline-primary dropdown-toggle" },
            'data-bs-toggle': "dropdown",
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-outline-primary']} */ ;
        /** @type {__VLS_StyleScopedClasses['dropdown-toggle']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "bi bi-plus me-1" },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['bi-plus']} */ ;
        /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
            ...{ class: "dropdown-menu dropdown-menu-end" },
        });
        /** @type {__VLS_StyleScopedClasses['dropdown-menu']} */ ;
        /** @type {__VLS_StyleScopedClasses['dropdown-menu-end']} */ ;
        for (const [t] of __VLS_vFor((['slack', 'discord', 'telegram', 'webhook'].filter(t => !(__VLS_ctx.config.channels || {})[t])))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
                key: (t),
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!(__VLS_ctx.section === 'channels'))
                            return;
                        __VLS_ctx.config.channels = { ...(__VLS_ctx.config.channels || {}), [t]: { enabled: true } };
                        // @ts-ignore
                        [section, section, section, section, handleSave, saving, saving, restartSession, restarting, restarting, restarting, msg, msg, msg, msg, loading, rerunSetup, config, config, config, config, config, config, config, config, config,];
                    } },
                ...{ class: "dropdown-item text-capitalize" },
            });
            /** @type {__VLS_StyleScopedClasses['dropdown-item']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-capitalize']} */ ;
            (t);
            // @ts-ignore
            [];
        }
        if (!Object.keys(__VLS_ctx.config.channels || {}).filter(n => n !== 'websocket').length) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "card" },
            });
            /** @type {__VLS_StyleScopedClasses['card']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "card-body text-center text-body-secondary py-4" },
            });
            /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-center']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
            /** @type {__VLS_StyleScopedClasses['py-4']} */ ;
        }
        for (const [ch, name] of __VLS_vFor(((__VLS_ctx.config.channels || {})))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                key: (name),
                ...{ class: "card mb-3" },
            });
            __VLS_asFunctionalDirective(__VLS_directives.vShow, {})(null, { ...__VLS_directiveBindingRestFields, value: (name !== 'websocket') }, null, null);
            /** @type {__VLS_StyleScopedClasses['card']} */ ;
            /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "card-header d-flex align-items-center justify-content-between" },
            });
            /** @type {__VLS_StyleScopedClasses['card-header']} */ ;
            /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
            /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
            /** @type {__VLS_StyleScopedClasses['justify-content-between']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "d-flex align-items-center gap-2" },
            });
            /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
            /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
            /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: ('bi ' + ({ slack: 'bi-slack', discord: 'bi-discord', telegram: 'bi-telegram', webhook: 'bi-globe' }[name] || 'bi-plug')) },
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "fw-semibold text-capitalize" },
            });
            /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-capitalize']} */ ;
            (name);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!(__VLS_ctx.section === 'channels'))
                            return;
                        ch.enabled = !ch.enabled;
                        // @ts-ignore
                        [config, config,];
                    } },
                ...{ class: "badge" },
                ...{ class: (ch.enabled ? 'text-bg-success' : 'text-bg-secondary') },
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['badge']} */ ;
            (ch.enabled ? 'Enabled' : 'Disabled');
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!(__VLS_ctx.section === 'channels'))
                            return;
                        delete __VLS_ctx.config.channels[name];
                        // @ts-ignore
                        [config,];
                    } },
                ...{ class: "btn btn-sm btn-outline-danger" },
            });
            /** @type {__VLS_StyleScopedClasses['btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-outline-danger']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi bi-trash" },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-trash']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "card-body" },
            });
            /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
            if (name === 'slack') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "mb-2" },
                });
                /** @type {__VLS_StyleScopedClasses['mb-2']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
                    ...{ class: "form-label small text-body-secondary mb-1" },
                });
                /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
                /** @type {__VLS_StyleScopedClasses['small']} */ ;
                /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
                /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "password",
                    placeholder: "xoxb-...",
                    ...{ class: "form-control form-control-sm font-monospace" },
                });
                (ch.botToken);
                /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
                /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
                /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
                    ...{ class: "form-label small text-body-secondary mb-1" },
                });
                /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
                /** @type {__VLS_StyleScopedClasses['small']} */ ;
                /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
                /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "password",
                    placeholder: "Slack signing secret",
                    ...{ class: "form-control form-control-sm font-monospace" },
                });
                (ch.signingSecret);
                /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
                /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
                /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
            }
            else if (name === 'discord') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
                    ...{ class: "form-label small text-body-secondary mb-1" },
                });
                /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
                /** @type {__VLS_StyleScopedClasses['small']} */ ;
                /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
                /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "password",
                    placeholder: "Discord bot token",
                    ...{ class: "form-control form-control-sm font-monospace" },
                });
                (ch.botToken);
                /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
                /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
                /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
            }
            else if (name === 'telegram') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
                    ...{ class: "form-label small text-body-secondary mb-1" },
                });
                /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
                /** @type {__VLS_StyleScopedClasses['small']} */ ;
                /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
                /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "password",
                    placeholder: "Token from @BotFather",
                    ...{ class: "form-control form-control-sm font-monospace" },
                });
                (ch.botToken);
                /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
                /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
                /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
            }
            else if (name === 'webhook') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
                    ...{ class: "form-label small text-body-secondary mb-1" },
                });
                /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
                /** @type {__VLS_StyleScopedClasses['small']} */ ;
                /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
                /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "password",
                    placeholder: "Webhook secret",
                    ...{ class: "form-control form-control-sm font-monospace" },
                });
                (ch.secret);
                /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
                /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
                /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
            }
            // @ts-ignore
            [];
        }
    }
    if (__VLS_ctx.section === 'skills') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "d-flex justify-content-between align-items-center mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
        /** @type {__VLS_StyleScopedClasses['justify-content-between']} */ ;
        /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "text-body-secondary small" },
        });
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.code, __VLS_intrinsics.code)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "d-flex gap-2" },
        });
        /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
        /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.form, __VLS_intrinsics.form)({
            ...{ onSubmit: (__VLS_ctx.addSkill) },
            ...{ class: "input-group input-group-sm" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['input-group']} */ ;
        /** @type {__VLS_StyleScopedClasses['input-group-sm']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            ...{ class: "form-control" },
            placeholder: "New skill name...",
        });
        (__VLS_ctx.newSkillName);
        /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ class: "btn btn-primary" },
            type: "submit",
            disabled: (!__VLS_ctx.newSkillName.trim()),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "bi bi-plus" },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['bi-plus']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onDragover: (...[$event]) => {
                    if (!!(__VLS_ctx.loading))
                        return;
                    if (!(__VLS_ctx.section === 'skills'))
                        return;
                    __VLS_ctx.dragging = true;
                    // @ts-ignore
                    [section, addSkill, newSkillName, newSkillName, dragging,];
                } },
            ...{ onDragleave: (...[$event]) => {
                    if (!!(__VLS_ctx.loading))
                        return;
                    if (!(__VLS_ctx.section === 'skills'))
                        return;
                    __VLS_ctx.dragging = false;
                    // @ts-ignore
                    [dragging,];
                } },
            ...{ onDrop: (__VLS_ctx.handleDrop) },
            ...{ class: "border border-dashed rounded p-4 text-center mb-3" },
            ...{ class: (__VLS_ctx.dragging ? 'border-primary bg-primary bg-opacity-10' : 'border-secondary') },
        });
        /** @type {__VLS_StyleScopedClasses['border']} */ ;
        /** @type {__VLS_StyleScopedClasses['border-dashed']} */ ;
        /** @type {__VLS_StyleScopedClasses['rounded']} */ ;
        /** @type {__VLS_StyleScopedClasses['p-4']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-center']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "bi bi-cloud-arrow-up fs-4 d-block mb-1" },
            ...{ class: (__VLS_ctx.dragging ? 'text-primary' : 'text-body-secondary') },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['bi-cloud-arrow-up']} */ ;
        /** @type {__VLS_StyleScopedClasses['fs-4']} */ ;
        /** @type {__VLS_StyleScopedClasses['d-block']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "small text-body-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "row g-3" },
        });
        /** @type {__VLS_StyleScopedClasses['row']} */ ;
        /** @type {__VLS_StyleScopedClasses['g-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "col-md-4" },
        });
        /** @type {__VLS_StyleScopedClasses['col-md-4']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "list-group" },
        });
        /** @type {__VLS_StyleScopedClasses['list-group']} */ ;
        if (!__VLS_ctx.skills.length) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ class: "list-group-item text-body-secondary small text-center" },
                disabled: true,
            });
            /** @type {__VLS_StyleScopedClasses['list-group-item']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
            /** @type {__VLS_StyleScopedClasses['small']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-center']} */ ;
        }
        for (const [s] of __VLS_vFor((__VLS_ctx.skills))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!(__VLS_ctx.section === 'skills'))
                            return;
                        __VLS_ctx.selectSkill(s.name);
                        // @ts-ignore
                        [dragging, dragging, handleDrop, skills, skills, selectSkill,];
                    } },
                key: (s.name),
                ...{ class: "list-group-item list-group-item-action d-flex justify-content-between align-items-center" },
                ...{ class: ({ active: __VLS_ctx.activeSkill === s.name }) },
            });
            /** @type {__VLS_StyleScopedClasses['list-group-item']} */ ;
            /** @type {__VLS_StyleScopedClasses['list-group-item-action']} */ ;
            /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
            /** @type {__VLS_StyleScopedClasses['justify-content-between']} */ ;
            /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
            /** @type {__VLS_StyleScopedClasses['active']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi bi-lightning me-2" },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-lightning']} */ ;
            /** @type {__VLS_StyleScopedClasses['me-2']} */ ;
            (s.name);
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!(__VLS_ctx.section === 'skills'))
                            return;
                        __VLS_ctx.deleteSkill(s.name);
                        // @ts-ignore
                        [activeSkill, deleteSkill,];
                    } },
                ...{ class: "btn btn-sm p-0 text-body-secondary" },
                title: "Delete",
            });
            /** @type {__VLS_StyleScopedClasses['btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
            /** @type {__VLS_StyleScopedClasses['p-0']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi bi-trash" },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-trash']} */ ;
            // @ts-ignore
            [];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "col-md-8" },
        });
        /** @type {__VLS_StyleScopedClasses['col-md-8']} */ ;
        if (__VLS_ctx.activeSkill) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "card" },
            });
            /** @type {__VLS_StyleScopedClasses['card']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "card-header d-flex justify-content-between align-items-center" },
            });
            /** @type {__VLS_StyleScopedClasses['card-header']} */ ;
            /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
            /** @type {__VLS_StyleScopedClasses['justify-content-between']} */ ;
            /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "small fw-semibold" },
            });
            /** @type {__VLS_StyleScopedClasses['small']} */ ;
            /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi bi-lightning me-1" },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-lightning']} */ ;
            /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
            (__VLS_ctx.activeSkill);
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (__VLS_ctx.saveSkill) },
                ...{ class: "btn btn-sm btn-primary" },
            });
            /** @type {__VLS_StyleScopedClasses['btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi bi-save me-1" },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-save']} */ ;
            /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "card-body p-0" },
            });
            /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
            /** @type {__VLS_StyleScopedClasses['p-0']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
                value: (__VLS_ctx.skillContent),
                rows: "20",
                ...{ class: "form-control font-monospace rounded-0 border-0" },
                spellcheck: "false",
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
            /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
            /** @type {__VLS_StyleScopedClasses['rounded-0']} */ ;
            /** @type {__VLS_StyleScopedClasses['border-0']} */ ;
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "text-center text-body-secondary py-5" },
            });
            /** @type {__VLS_StyleScopedClasses['text-center']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
            /** @type {__VLS_StyleScopedClasses['py-5']} */ ;
        }
    }
    if (__VLS_ctx.section === 'json-files') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
            ...{ class: "nav nav-tabs border-0 gap-1 mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['nav']} */ ;
        /** @type {__VLS_StyleScopedClasses['nav-tabs']} */ ;
        /** @type {__VLS_StyleScopedClasses['border-0']} */ ;
        /** @type {__VLS_StyleScopedClasses['gap-1']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        for (const [f] of __VLS_vFor((__VLS_ctx.jsonFiles))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
                key: (f),
                ...{ class: "nav-item" },
            });
            /** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!(__VLS_ctx.section === 'json-files'))
                            return;
                        __VLS_ctx.activeJsonFile = f;
                        // @ts-ignore
                        [section, activeSkill, activeSkill, saveSkill, skillContent, jsonFiles, activeJsonFile,];
                    } },
                ...{ class: "nav-link small py-1 px-2" },
                ...{ class: ({ active: __VLS_ctx.activeJsonFile === f }) },
            });
            /** @type {__VLS_StyleScopedClasses['nav-link']} */ ;
            /** @type {__VLS_StyleScopedClasses['small']} */ ;
            /** @type {__VLS_StyleScopedClasses['py-1']} */ ;
            /** @type {__VLS_StyleScopedClasses['px-2']} */ ;
            /** @type {__VLS_StyleScopedClasses['active']} */ ;
            (f);
            // @ts-ignore
            [activeJsonFile,];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "card" },
        });
        /** @type {__VLS_StyleScopedClasses['card']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "card-header d-flex justify-content-between align-items-center" },
        });
        /** @type {__VLS_StyleScopedClasses['card-header']} */ ;
        /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
        /** @type {__VLS_StyleScopedClasses['justify-content-between']} */ ;
        /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "small fw-semibold" },
        });
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "bi bi-braces me-1" },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['bi-braces']} */ ;
        /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
        (__VLS_ctx.activeJsonFile);
        if (__VLS_ctx.activeJsonFile === 'config.json') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "badge text-bg-primary" },
            });
            /** @type {__VLS_StyleScopedClasses['badge']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-bg-primary']} */ ;
        }
        else if (!__VLS_ctx.claudeFiles[__VLS_ctx.activeJsonFile]) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "badge text-bg-secondary" },
            });
            /** @type {__VLS_StyleScopedClasses['badge']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-bg-secondary']} */ ;
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "card-body p-0" },
        });
        /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
        /** @type {__VLS_StyleScopedClasses['p-0']} */ ;
        if (__VLS_ctx.activeJsonFile === 'config.json') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
                value: (__VLS_ctx.jsonText),
                rows: "24",
                ...{ class: "form-control font-monospace rounded-0 border-0" },
                spellcheck: "false",
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
            /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
            /** @type {__VLS_StyleScopedClasses['rounded-0']} */ ;
            /** @type {__VLS_StyleScopedClasses['border-0']} */ ;
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
                ...{ onInput: ((e) => __VLS_ctx.onClaudeFileEdit(__VLS_ctx.activeJsonFile, e.target.value)) },
                value: (__VLS_ctx.claudeFiles[__VLS_ctx.activeJsonFile] || '{}'),
                rows: "24",
                ...{ class: "form-control font-monospace rounded-0 border-0" },
                spellcheck: "false",
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
            /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
            /** @type {__VLS_StyleScopedClasses['rounded-0']} */ ;
            /** @type {__VLS_StyleScopedClasses['border-0']} */ ;
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "text-body-secondary small mt-2" },
        });
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
        (__VLS_ctx.jsonDescriptions[__VLS_ctx.activeJsonFile] || '');
    }
    if (__VLS_ctx.section === 'agents') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
        if (__VLS_ctx.showPersonaWizard) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
            const __VLS_5 = Setup;
            // @ts-ignore
            const __VLS_6 = __VLS_asFunctionalComponent1(__VLS_5, new __VLS_5({
                ...{ 'onComplete': {} },
                forcePersona: (true),
            }));
            const __VLS_7 = __VLS_6({
                ...{ 'onComplete': {} },
                forcePersona: (true),
            }, ...__VLS_functionalComponentArgsRest(__VLS_6));
            let __VLS_10;
            const __VLS_11 = ({ complete: {} },
                { onComplete: (...[$event]) => {
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!(__VLS_ctx.section === 'agents'))
                            return;
                        if (!(__VLS_ctx.showPersonaWizard))
                            return;
                        __VLS_ctx.showPersonaWizard = false;
                        __VLS_ctx.load();
                        // @ts-ignore
                        [section, activeJsonFile, activeJsonFile, activeJsonFile, activeJsonFile, activeJsonFile, activeJsonFile, activeJsonFile, claudeFiles, claudeFiles, jsonText, onClaudeFileEdit, jsonDescriptions, showPersonaWizard, showPersonaWizard, load,];
                    } });
            var __VLS_8;
            var __VLS_9;
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!(__VLS_ctx.section === 'agents'))
                            return;
                        if (!(__VLS_ctx.showPersonaWizard))
                            return;
                        __VLS_ctx.showPersonaWizard = false;
                        __VLS_ctx.load();
                        // @ts-ignore
                        [showPersonaWizard, load,];
                    } },
                ...{ class: "btn btn-sm btn-outline-secondary mt-3" },
            });
            /** @type {__VLS_StyleScopedClasses['btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
            /** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi bi-arrow-left me-1" },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-arrow-left']} */ ;
            /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "d-flex justify-content-center align-items-center gap-2 mb-3" },
            });
            /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
            /** @type {__VLS_StyleScopedClasses['justify-content-center']} */ ;
            /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
            /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
            /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
                ...{ onChange: (__VLS_ctx.onSelectAgentChange) },
                value: (__VLS_ctx.selectedAgent),
                ...{ class: "form-select form-select-sm" },
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['form-select']} */ ;
            /** @type {__VLS_StyleScopedClasses['form-select-sm']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                value: "__main__",
            });
            for (const [a] of __VLS_vFor((__VLS_ctx.subAgents))) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    key: (a.name),
                    value: (a.name),
                });
                (a.name);
                // @ts-ignore
                [onSelectAgentChange, selectedAgent, subAgents,];
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.form, __VLS_intrinsics.form)({
                ...{ onSubmit: (__VLS_ctx.createSubAgent) },
                ...{ class: "input-group input-group-sm" },
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['input-group']} */ ;
            /** @type {__VLS_StyleScopedClasses['input-group-sm']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                ...{ class: "form-control" },
                placeholder: "new-agent",
            });
            (__VLS_ctx.newAgentName);
            /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ class: "btn btn-outline-primary" },
                type: "submit",
                disabled: (!__VLS_ctx.newAgentName.trim()),
                title: "Create agent",
            });
            /** @type {__VLS_StyleScopedClasses['btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-outline-primary']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi bi-plus" },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-plus']} */ ;
            if (__VLS_ctx.selectedAgent !== '__main__') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!!(__VLS_ctx.loading))
                                return;
                            if (!(__VLS_ctx.section === 'agents'))
                                return;
                            if (!!(__VLS_ctx.showPersonaWizard))
                                return;
                            if (!(__VLS_ctx.selectedAgent !== '__main__'))
                                return;
                            __VLS_ctx.removeSubAgent(__VLS_ctx.selectedAgent);
                            // @ts-ignore
                            [selectedAgent, selectedAgent, createSubAgent, newAgentName, newAgentName, removeSubAgent,];
                        } },
                    ...{ class: "btn btn-sm btn-outline-danger" },
                    title: "Delete agent",
                });
                /** @type {__VLS_StyleScopedClasses['btn']} */ ;
                /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
                /** @type {__VLS_StyleScopedClasses['btn-outline-danger']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                    ...{ class: "bi bi-trash" },
                });
                /** @type {__VLS_StyleScopedClasses['bi']} */ ;
                /** @type {__VLS_StyleScopedClasses['bi-trash']} */ ;
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "d-flex justify-content-between align-items-center mb-2" },
            });
            /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
            /** @type {__VLS_StyleScopedClasses['justify-content-between']} */ ;
            /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
            /** @type {__VLS_StyleScopedClasses['mb-2']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
                ...{ class: "nav nav-tabs border-0 gap-1 flex-wrap" },
            });
            /** @type {__VLS_StyleScopedClasses['nav']} */ ;
            /** @type {__VLS_StyleScopedClasses['nav-tabs']} */ ;
            /** @type {__VLS_StyleScopedClasses['border-0']} */ ;
            /** @type {__VLS_StyleScopedClasses['gap-1']} */ ;
            /** @type {__VLS_StyleScopedClasses['flex-wrap']} */ ;
            for (const [f] of __VLS_vFor((__VLS_ctx.visibleTabs))) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
                    key: (f),
                    ...{ class: "nav-item" },
                });
                /** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!!(__VLS_ctx.loading))
                                return;
                            if (!(__VLS_ctx.section === 'agents'))
                                return;
                            if (!!(__VLS_ctx.showPersonaWizard))
                                return;
                            __VLS_ctx.currentFile = f;
                            // @ts-ignore
                            [visibleTabs, currentFile,];
                        } },
                    ...{ class: "nav-link small py-1 px-2 d-flex align-items-center gap-1" },
                    ...{ class: ({ active: __VLS_ctx.currentFile === f }) },
                });
                /** @type {__VLS_StyleScopedClasses['nav-link']} */ ;
                /** @type {__VLS_StyleScopedClasses['small']} */ ;
                /** @type {__VLS_StyleScopedClasses['py-1']} */ ;
                /** @type {__VLS_StyleScopedClasses['px-2']} */ ;
                /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
                /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
                /** @type {__VLS_StyleScopedClasses['gap-1']} */ ;
                /** @type {__VLS_StyleScopedClasses['active']} */ ;
                (f);
                if (__VLS_ctx.canRemoveFile(f)) {
                    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                        ...{ onClick: (...[$event]) => {
                                if (!!(__VLS_ctx.loading))
                                    return;
                                if (!(__VLS_ctx.section === 'agents'))
                                    return;
                                if (!!(__VLS_ctx.showPersonaWizard))
                                    return;
                                if (!(__VLS_ctx.canRemoveFile(f)))
                                    return;
                                __VLS_ctx.removeFile(f);
                                // @ts-ignore
                                [currentFile, canRemoveFile, removeFile,];
                            } },
                        ...{ class: "ms-1 text-body-secondary" },
                        ...{ style: {} },
                        title: "Remove file",
                    });
                    /** @type {__VLS_StyleScopedClasses['ms-1']} */ ;
                    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
                }
                // @ts-ignore
                [];
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "d-flex gap-2 ms-2 flex-shrink-0" },
            });
            /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
            /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
            /** @type {__VLS_StyleScopedClasses['ms-2']} */ ;
            /** @type {__VLS_StyleScopedClasses['flex-shrink-0']} */ ;
            if (__VLS_ctx.addableFiles.length) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "dropdown" },
                });
                /** @type {__VLS_StyleScopedClasses['dropdown']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ class: "btn btn-sm btn-outline-secondary dropdown-toggle" },
                    'data-bs-toggle': "dropdown",
                });
                /** @type {__VLS_StyleScopedClasses['btn']} */ ;
                /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
                /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
                /** @type {__VLS_StyleScopedClasses['dropdown-toggle']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                    ...{ class: "bi bi-plus" },
                });
                /** @type {__VLS_StyleScopedClasses['bi']} */ ;
                /** @type {__VLS_StyleScopedClasses['bi-plus']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
                    ...{ class: "dropdown-menu dropdown-menu-end" },
                });
                /** @type {__VLS_StyleScopedClasses['dropdown-menu']} */ ;
                /** @type {__VLS_StyleScopedClasses['dropdown-menu-end']} */ ;
                for (const [f] of __VLS_vFor((__VLS_ctx.addableFiles))) {
                    __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
                        key: (f),
                    });
                    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                        ...{ onClick: (...[$event]) => {
                                if (!!(__VLS_ctx.loading))
                                    return;
                                if (!(__VLS_ctx.section === 'agents'))
                                    return;
                                if (!!(__VLS_ctx.showPersonaWizard))
                                    return;
                                if (!(__VLS_ctx.addableFiles.length))
                                    return;
                                __VLS_ctx.addFile(f);
                                // @ts-ignore
                                [addableFiles, addableFiles, addFile,];
                            } },
                        ...{ class: "dropdown-item small" },
                    });
                    /** @type {__VLS_StyleScopedClasses['dropdown-item']} */ ;
                    /** @type {__VLS_StyleScopedClasses['small']} */ ;
                    (f);
                    // @ts-ignore
                    [];
                }
            }
            if (__VLS_ctx.selectedAgent === '__main__' && __VLS_ctx.currentFile === 'CLAUDE.md') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!!(__VLS_ctx.loading))
                                return;
                            if (!(__VLS_ctx.section === 'agents'))
                                return;
                            if (!!(__VLS_ctx.showPersonaWizard))
                                return;
                            if (!(__VLS_ctx.selectedAgent === '__main__' && __VLS_ctx.currentFile === 'CLAUDE.md'))
                                return;
                            __VLS_ctx.showPersonaWizard = true;
                            // @ts-ignore
                            [showPersonaWizard, selectedAgent, currentFile,];
                        } },
                    ...{ class: "btn btn-sm btn-outline-primary" },
                });
                /** @type {__VLS_StyleScopedClasses['btn']} */ ;
                /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
                /** @type {__VLS_StyleScopedClasses['btn-outline-primary']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                    ...{ class: "bi bi-magic me-1" },
                });
                /** @type {__VLS_StyleScopedClasses['bi']} */ ;
                /** @type {__VLS_StyleScopedClasses['bi-magic']} */ ;
                /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "card" },
            });
            /** @type {__VLS_StyleScopedClasses['card']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "card-header d-flex justify-content-between align-items-center" },
            });
            /** @type {__VLS_StyleScopedClasses['card-header']} */ ;
            /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
            /** @type {__VLS_StyleScopedClasses['justify-content-between']} */ ;
            /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "small fw-semibold" },
            });
            /** @type {__VLS_StyleScopedClasses['small']} */ ;
            /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: (__VLS_ctx.selectedAgent === '__main__' ? 'bi bi-file-earmark-text' : 'bi bi-robot') },
                ...{ class: "me-1" },
            });
            /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
            (__VLS_ctx.selectedAgent === '__main__' ? `workspace/${__VLS_ctx.currentFile}` : `.claude/agents/${__VLS_ctx.selectedAgent}/${__VLS_ctx.currentFile}`);
            if (__VLS_ctx.currentFile === 'META.md') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "text-body-secondary small" },
                });
                /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
                /** @type {__VLS_StyleScopedClasses['small']} */ ;
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "card-body p-0" },
            });
            /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
            /** @type {__VLS_StyleScopedClasses['p-0']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
                ...{ onInput: ((e) => __VLS_ctx.setFileContent(e.target.value)) },
                value: (__VLS_ctx.getFileContent()),
                rows: "22",
                ...{ class: "form-control font-monospace rounded-0 border-0" },
                spellcheck: "false",
                ...{ style: {} },
                placeholder: (__VLS_ctx.mdPlaceholders[__VLS_ctx.currentFile] || `# ${__VLS_ctx.currentFile}`),
            });
            /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
            /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
            /** @type {__VLS_StyleScopedClasses['rounded-0']} */ ;
            /** @type {__VLS_StyleScopedClasses['border-0']} */ ;
            if (__VLS_ctx.selectedAgent === '__main__') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
                    ...{ class: "text-body-secondary small mt-2" },
                });
                /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
                /** @type {__VLS_StyleScopedClasses['small']} */ ;
                /** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
                (__VLS_ctx.mdDescriptions[__VLS_ctx.currentFile] || 'Workspace file read by Claude on startup.');
            }
        }
    }
}
// @ts-ignore
[selectedAgent, selectedAgent, selectedAgent, selectedAgent, currentFile, currentFile, currentFile, currentFile, currentFile, currentFile, setFileContent, getFileContent, mdPlaceholders, mdDescriptions,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
