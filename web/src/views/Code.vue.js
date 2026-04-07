import { ref, nextTick, watch, onMounted, onUnmounted, computed } from "vue";
import { marked } from "marked";
import { useChatStore } from "../composables/useChatStore";
import { fetchConfig, saveConfig } from "../composables/useApi";
const { state, send } = useChatStore();
const input = ref("");
const scrollEl = ref(null);
const inputEl = ref(null);
const verbose = ref(false);
// ── Model selector ──
const showModes = ref(false);
const config = ref({});
const savingConfig = ref(false);
const models = [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
];
async function loadConfig() {
    try {
        config.value = await fetchConfig();
    }
    catch { }
}
async function updateModel(value) {
    if (!config.value.claude)
        config.value.claude = {};
    config.value.claude.model = value;
    savingConfig.value = true;
    try {
        await saveConfig(config.value);
    }
    catch { }
    savingConfig.value = false;
}
// ── Slash commands (native + skills) ──
const showSlash = ref(false);
const customSkills = ref([]);
const slashFilter = ref("");
// Native Claude Code commands
const nativeCommands = [
    { name: "clear", desc: "Clear conversation history", icon: "bi-x-circle" },
    { name: "compact", desc: "Compact conversation to save context", icon: "bi-arrows-collapse" },
    { name: "model", desc: "Change the AI model", icon: "bi-cpu" },
    { name: "cost", desc: "Show token usage statistics", icon: "bi-cash-coin" },
    { name: "help", desc: "Show help and available commands", icon: "bi-question-circle" },
    { name: "init", desc: "Initialize project with CLAUDE.md", icon: "bi-file-earmark-plus" },
    { name: "memory", desc: "Edit CLAUDE.md memory files", icon: "bi-brain" },
    { name: "config", desc: "Open settings", icon: "bi-gear" },
    { name: "permissions", desc: "Manage tool permissions", icon: "bi-shield-lock" },
    { name: "status", desc: "Show version, model, account info", icon: "bi-info-circle" },
    { name: "doctor", desc: "Diagnose installation issues", icon: "bi-heart-pulse" },
    { name: "diff", desc: "View uncommitted changes", icon: "bi-file-diff" },
    { name: "review", desc: "Review code changes", icon: "bi-search" },
    { name: "security-review", desc: "Security analysis of pending changes", icon: "bi-shield-check" },
    { name: "plan", desc: "Enter plan mode", icon: "bi-map" },
    { name: "resume", desc: "Resume a previous session", icon: "bi-arrow-clockwise" },
    { name: "export", desc: "Export conversation as text", icon: "bi-download" },
    { name: "copy", desc: "Copy last response to clipboard", icon: "bi-clipboard" },
    { name: "effort", desc: "Set model effort level", icon: "bi-speedometer" },
    { name: "context", desc: "Visualize context usage", icon: "bi-pie-chart" },
    { name: "add-dir", desc: "Add a working directory", icon: "bi-folder-plus" },
    { name: "login", desc: "Sign in to Anthropic", icon: "bi-box-arrow-in-right" },
    { name: "logout", desc: "Sign out from Anthropic", icon: "bi-box-arrow-right" },
    { name: "hooks", desc: "View hook configurations", icon: "bi-link-45deg" },
    { name: "mcp", desc: "Manage MCP server connections", icon: "bi-plug" },
    { name: "agents", desc: "Manage agent configurations", icon: "bi-people" },
    { name: "skills", desc: "List available skills", icon: "bi-lightning" },
    { name: "fast", desc: "Toggle fast mode", icon: "bi-lightning-charge" },
    { name: "rewind", desc: "Rewind conversation to checkpoint", icon: "bi-skip-backward" },
    { name: "rename", desc: "Rename the current session", icon: "bi-pencil" },
    { name: "usage", desc: "Show plan usage and rate limits", icon: "bi-bar-chart" },
    { name: "feedback", desc: "Submit feedback about Claude Code", icon: "bi-chat-square-text" },
    { name: "theme", desc: "Change the color theme", icon: "bi-palette" },
];
const allCommands = computed(() => {
    const cmds = [
        ...nativeCommands.map(c => ({ ...c, type: "native" })),
        ...customSkills.value.map(s => ({ name: s.name, desc: "Custom skill", icon: "bi-lightning", type: "skill" })),
    ];
    const q = slashFilter.value.toLowerCase();
    return q ? cmds.filter(c => c.name.includes(q) || c.desc.toLowerCase().includes(q)) : cmds;
});
async function loadSkills() {
    try {
        customSkills.value = ((await (await fetch("/api/skills")).json()).skills || []);
    }
    catch { }
}
function selectCommand(name) {
    input.value = `/${name} ${input.value}`;
    closeAllPopups();
    nextTick(() => inputEl.value?.focus());
}
// ── File upload (+) ──
const fileInputEl = ref(null);
const uploadedFiles = ref([]);
function triggerFileUpload() {
    closeAllPopups();
    fileInputEl.value?.click();
}
function handleFileUpload(e) {
    const files = e.target.files;
    if (!files)
        return;
    for (const file of Array.from(files)) {
        // Max 1MB text files
        if (file.size > 1024 * 1024)
            continue;
        const reader = new FileReader();
        reader.onload = () => {
            const content = reader.result;
            uploadedFiles.value.push({ name: file.name, content });
            // Append file content as context in the message
            const tag = `[File: ${file.name}]\n\`\`\`\n${content.slice(0, 10000)}\n\`\`\``;
            input.value = input.value ? `${input.value}\n\n${tag}` : tag;
            nextTick(() => { autoResize(); inputEl.value?.focus(); });
        };
        reader.readAsText(file);
    }
    // Reset so same file can be re-selected
    if (fileInputEl.value)
        fileInputEl.value.value = "";
}
// ── Tool classification ──
function isEditTool(name) {
    if (!name)
        return false;
    const n = name.toLowerCase();
    return n.includes("edit") || n.includes("write") || n.includes("notebook");
}
// Try to parse diff-like content from edit tool args
function parseDiff(content) {
    try {
        const parsed = JSON.parse(content);
        if (parsed.file_path && (parsed.old_string !== undefined || parsed.new_string !== undefined)) {
            return {
                file: parsed.file_path,
                oldStr: parsed.old_string || "",
                newStr: parsed.new_string || "",
            };
        }
        // Write tool: just show content as "added"
        if (parsed.file_path && parsed.content) {
            return { file: parsed.file_path, oldStr: "", newStr: parsed.content.slice(0, 500) };
        }
    }
    catch {
        // Content is the "toolName: {json}" format from the server
        const match = content.match(/^[\w]+:\s*(\{.*\})$/s);
        if (match) {
            try {
                const parsed = JSON.parse(match[1]);
                if (parsed.file_path && (parsed.old_string !== undefined || parsed.new_string !== undefined)) {
                    return { file: parsed.file_path, oldStr: parsed.old_string || "", newStr: parsed.new_string || "" };
                }
            }
            catch { }
        }
    }
    return null;
}
const expandedDiffs = ref(new Set());
function toggleDiff(idx) {
    if (expandedDiffs.value.has(idx))
        expandedDiffs.value.delete(idx);
    else
        expandedDiffs.value.add(idx);
}
// ── Chat helpers ──
function scrollBottom() {
    nextTick(() => { if (scrollEl.value)
        scrollEl.value.scrollTop = scrollEl.value.scrollHeight; });
}
function renderMd(text) {
    return marked.parse(text, { async: false });
}
function autoResize() {
    const el = inputEl.value;
    if (!el)
        return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
}
function handleSend() {
    const text = input.value.trim();
    if (!text)
        return;
    input.value = "";
    nextTick(autoResize);
    send(text);
    scrollBottom();
    nextTick(() => inputEl.value?.focus());
}
function handleKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
    }
    if (e.key === "/" && !input.value) {
        e.preventDefault();
        showSlash.value = true;
        showModes.value = false;
    }
}
function copyText(text) { navigator.clipboard.writeText(text); }
function closeAllPopups() {
    showSlash.value = false;
    showModes.value = false;
    slashFilter.value = "";
}
function onDocClick(e) {
    if (!e.target.closest(".popup-anchor"))
        closeAllPopups();
}
function onWindowKeydown(e) {
    if (e.key === "Escape") {
        closeAllPopups();
        return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey)
        return;
    if (document.activeElement === inputEl.value)
        return;
    if (showSlash.value || showModes.value)
        return;
    inputEl.value?.focus();
}
onMounted(() => {
    scrollBottom();
    loadConfig();
    loadSkills();
    window.addEventListener("keydown", onWindowKeydown);
    document.addEventListener("click", onDocClick);
});
onUnmounted(() => {
    window.removeEventListener("keydown", onWindowKeydown);
    document.removeEventListener("click", onDocClick);
});
watch(() => state.messages.length, scrollBottom);
watch(() => state.messages[state.messages.length - 1]?.content, scrollBottom);
watch(() => state.busy, (busy) => { if (!busy)
    nextTick(() => inputEl.value?.focus()); });
const currentModel = computed(() => {
    const m = config.value?.claude?.model || "";
    return m.replace("claude-", "").replace(/-\d+$/, "") || "—";
});
const statusText = computed(() => {
    if (!state.connected)
        return "Disconnected";
    if (state.busy)
        return "Responding...";
    if (state.agentBusy)
        return "Agent working...";
    if (!state.agentAlive)
        return "Agent offline";
    return "Ready";
});
const isWorking = computed(() => state.busy || state.agentBusy);
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['header-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['header-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['msg']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-label']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-label']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-md']} */ ;
/** @type {__VLS_StyleScopedClasses['copy-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['copy-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-header']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-expand']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-removed']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-gutter']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-added']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-gutter']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-verbose-header']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-line']} */ ;
/** @type {__VLS_StyleScopedClasses['bi']} */ ;
/** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['code-input-form']} */ ;
/** @type {__VLS_StyleScopedClasses['code-input']} */ ;
/** @type {__VLS_StyleScopedClasses['code-send-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['code-send-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['mode-bar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['popup-search']} */ ;
/** @type {__VLS_StyleScopedClasses['popup-item']} */ ;
/** @type {__VLS_StyleScopedClasses['popup-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['popup-item']} */ ;
/** @type {__VLS_StyleScopedClasses['bi']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "code-panel d-flex flex-column h-100" },
});
/** @type {__VLS_StyleScopedClasses['code-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-column']} */ ;
/** @type {__VLS_StyleScopedClasses['h-100']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "code-header" },
});
/** @type {__VLS_StyleScopedClasses['code-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "d-flex align-items-center gap-2" },
});
/** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
/** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
    ...{ class: "bi bi-braces text-primary" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['bi']} */ ;
/** @type {__VLS_StyleScopedClasses['bi-braces']} */ ;
/** @type {__VLS_StyleScopedClasses['text-primary']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "fw-semibold" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "d-flex align-items-center gap-2" },
});
/** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
/** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.verbose = !__VLS_ctx.verbose;
            // @ts-ignore
            [verbose, verbose,];
        } },
    ...{ class: "header-btn" },
    ...{ class: ({ active: __VLS_ctx.verbose }) },
    title: (__VLS_ctx.verbose ? 'Hide tool details' : 'Show tool details'),
});
/** @type {__VLS_StyleScopedClasses['header-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
    ...{ class: "bi" },
    ...{ class: (__VLS_ctx.verbose ? 'bi-eye-fill' : 'bi-eye') },
});
/** @type {__VLS_StyleScopedClasses['bi']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "status-text" },
});
/** @type {__VLS_StyleScopedClasses['status-text']} */ ;
(__VLS_ctx.statusText);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "status-dot" },
    ...{ class: ({
            connected: __VLS_ctx.state.connected && !__VLS_ctx.isWorking,
            busy: __VLS_ctx.isWorking,
            disconnected: !__VLS_ctx.state.connected || !__VLS_ctx.state.agentAlive,
        }) },
});
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['connected']} */ ;
/** @type {__VLS_StyleScopedClasses['busy']} */ ;
/** @type {__VLS_StyleScopedClasses['disconnected']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ref: "scrollEl",
    ...{ class: "flex-grow-1 overflow-auto code-messages" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['flex-grow-1']} */ ;
/** @type {__VLS_StyleScopedClasses['overflow-auto']} */ ;
/** @type {__VLS_StyleScopedClasses['code-messages']} */ ;
if (!__VLS_ctx.state.messages.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "h-100 d-flex flex-column align-items-center justify-content-center text-body-secondary px-4" },
    });
    /** @type {__VLS_StyleScopedClasses['h-100']} */ ;
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['flex-column']} */ ;
    /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['justify-content-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['px-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-braces" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-braces']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "mt-2 mb-0 small text-center" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['mt-2']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-0']} */ ;
    /** @type {__VLS_StyleScopedClasses['small']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-center']} */ ;
}
for (const [m, i] of __VLS_vFor((__VLS_ctx.state.messages))) {
    (i);
    if (m.role === 'user') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "msg msg-user" },
        });
        /** @type {__VLS_StyleScopedClasses['msg']} */ ;
        /** @type {__VLS_StyleScopedClasses['msg-user']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "msg-label" },
        });
        /** @type {__VLS_StyleScopedClasses['msg-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "msg-body" },
        });
        /** @type {__VLS_StyleScopedClasses['msg-body']} */ ;
        (m.content);
    }
    else if (m.role === 'assistant') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "msg msg-assistant" },
        });
        /** @type {__VLS_StyleScopedClasses['msg']} */ ;
        /** @type {__VLS_StyleScopedClasses['msg-assistant']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "msg-label" },
        });
        /** @type {__VLS_StyleScopedClasses['msg-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "msg-body msg-md" },
        });
        /** @type {__VLS_StyleScopedClasses['msg-body']} */ ;
        /** @type {__VLS_StyleScopedClasses['msg-md']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "chat-md" },
        });
        __VLS_asFunctionalDirective(__VLS_directives.vHtml, {})(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderMd(m.content)) }, null, null);
        /** @type {__VLS_StyleScopedClasses['chat-md']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(m.role === 'user'))
                        return;
                    if (!(m.role === 'assistant'))
                        return;
                    __VLS_ctx.copyText(m.content);
                    // @ts-ignore
                    [verbose, verbose, verbose, statusText, state, state, state, state, state, isWorking, isWorking, renderMd, copyText,];
                } },
            ...{ class: "copy-btn" },
            title: "Copy",
        });
        /** @type {__VLS_StyleScopedClasses['copy-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "bi bi-clipboard" },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['bi-clipboard']} */ ;
    }
    else if (m.role === 'thinking') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "tool-line thinking-line" },
        });
        /** @type {__VLS_StyleScopedClasses['tool-line']} */ ;
        /** @type {__VLS_StyleScopedClasses['thinking-line']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "bi bi-lightbulb" },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['bi-lightbulb']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tool-line-label" },
        });
        /** @type {__VLS_StyleScopedClasses['tool-line-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tool-line-detail" },
        });
        /** @type {__VLS_StyleScopedClasses['tool-line-detail']} */ ;
        (m.content.slice(0, 80));
        (m.content.length > 80 ? '...' : '');
    }
    else if (m.role === 'tool') {
        if (__VLS_ctx.isEditTool(m.toolName) && __VLS_ctx.parseDiff(m.content)) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "diff-box" },
            });
            /** @type {__VLS_StyleScopedClasses['diff-box']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "diff-header" },
            });
            /** @type {__VLS_StyleScopedClasses['diff-header']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi bi-pencil-square diff-icon" },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-pencil-square']} */ ;
            /** @type {__VLS_StyleScopedClasses['diff-icon']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "diff-file" },
            });
            /** @type {__VLS_StyleScopedClasses['diff-file']} */ ;
            (__VLS_ctx.parseDiff(m.content).file.split('/').pop());
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "diff-path" },
            });
            /** @type {__VLS_StyleScopedClasses['diff-path']} */ ;
            (__VLS_ctx.parseDiff(m.content).file);
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "diff-body" },
                ...{ class: ({ 'diff-collapsed': !__VLS_ctx.expandedDiffs.has(i) }) },
            });
            /** @type {__VLS_StyleScopedClasses['diff-body']} */ ;
            /** @type {__VLS_StyleScopedClasses['diff-collapsed']} */ ;
            if (__VLS_ctx.parseDiff(m.content).oldStr) {
                for (const [line, li] of __VLS_vFor((__VLS_ctx.parseDiff(m.content).oldStr.split('\n')))) {
                    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                        key: ('r' + li),
                        ...{ class: "diff-line diff-removed" },
                    });
                    /** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
                    /** @type {__VLS_StyleScopedClasses['diff-removed']} */ ;
                    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                        ...{ class: "diff-gutter" },
                    });
                    /** @type {__VLS_StyleScopedClasses['diff-gutter']} */ ;
                    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
                    (line);
                    // @ts-ignore
                    [isEditTool, parseDiff, parseDiff, parseDiff, parseDiff, parseDiff, expandedDiffs,];
                }
            }
            if (__VLS_ctx.parseDiff(m.content).newStr) {
                for (const [line, li] of __VLS_vFor((__VLS_ctx.parseDiff(m.content).newStr.split('\n')))) {
                    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                        key: ('a' + li),
                        ...{ class: "diff-line diff-added" },
                    });
                    /** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
                    /** @type {__VLS_StyleScopedClasses['diff-added']} */ ;
                    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                        ...{ class: "diff-gutter" },
                    });
                    /** @type {__VLS_StyleScopedClasses['diff-gutter']} */ ;
                    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
                    (line);
                    // @ts-ignore
                    [parseDiff, parseDiff,];
                }
            }
            if (__VLS_ctx.parseDiff(m.content).oldStr.split('\n').length + __VLS_ctx.parseDiff(m.content).newStr.split('\n').length > 8) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!!(m.role === 'user'))
                                return;
                            if (!!(m.role === 'assistant'))
                                return;
                            if (!!(m.role === 'thinking'))
                                return;
                            if (!(m.role === 'tool'))
                                return;
                            if (!(__VLS_ctx.isEditTool(m.toolName) && __VLS_ctx.parseDiff(m.content)))
                                return;
                            if (!(__VLS_ctx.parseDiff(m.content).oldStr.split('\n').length + __VLS_ctx.parseDiff(m.content).newStr.split('\n').length > 8))
                                return;
                            __VLS_ctx.toggleDiff(i);
                            // @ts-ignore
                            [parseDiff, parseDiff, toggleDiff,];
                        } },
                    ...{ class: "diff-expand" },
                });
                /** @type {__VLS_StyleScopedClasses['diff-expand']} */ ;
                (__VLS_ctx.expandedDiffs.has(i) ? 'Show less' : 'Show more');
            }
        }
        else if (__VLS_ctx.verbose) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "tool-verbose" },
            });
            /** @type {__VLS_StyleScopedClasses['tool-verbose']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "tool-verbose-header" },
            });
            /** @type {__VLS_StyleScopedClasses['tool-verbose-header']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi" },
                ...{ class: ({
                        'bi-terminal': m.toolName?.toLowerCase().includes('bash'),
                        'bi-file-earmark-text': m.toolName?.toLowerCase().includes('read'),
                        'bi-search': m.toolName?.toLowerCase().includes('glob') || m.toolName?.toLowerCase().includes('grep'),
                        'bi-wrench': !m.toolName,
                    }) },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-terminal']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-file-earmark-text']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-search']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-wrench']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
            (m.toolName || 'Tool');
            __VLS_asFunctionalElement1(__VLS_intrinsics.pre, __VLS_intrinsics.pre)({
                ...{ class: "tool-verbose-body" },
            });
            /** @type {__VLS_StyleScopedClasses['tool-verbose-body']} */ ;
            (m.content.slice(0, 600));
            (m.content.length > 600 ? '\n...' : '');
        }
    }
    else if (m.role === 'error') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "msg-error" },
        });
        /** @type {__VLS_StyleScopedClasses['msg-error']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "bi bi-exclamation-triangle" },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['bi-exclamation-triangle']} */ ;
        (m.content);
    }
    // @ts-ignore
    [verbose, expandedDiffs,];
}
if (__VLS_ctx.isWorking) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "busy-bar" },
    });
    /** @type {__VLS_StyleScopedClasses['busy-bar']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "busy-spinner" },
    });
    /** @type {__VLS_StyleScopedClasses['busy-spinner']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    (__VLS_ctx.statusText);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "code-input-area" },
});
/** @type {__VLS_StyleScopedClasses['code-input-area']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    ...{ onChange: (__VLS_ctx.handleFileUpload) },
    ref: "fileInputEl",
    type: "file",
    multiple: true,
    accept: ".txt,.md,.ts,.js,.tsx,.jsx,.json,.yml,.yaml,.py,.sh,.css,.html,.xml,.csv,.sql,.rs,.go,.java,.c,.cpp,.h,.rb,.php,.swift,.kt,.toml,.ini,.cfg,.env,.log",
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.form, __VLS_intrinsics.form)({
    ...{ onSubmit: (__VLS_ctx.handleSend) },
    ...{ class: "code-input-form" },
});
/** @type {__VLS_StyleScopedClasses['code-input-form']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
    ...{ onKeydown: (__VLS_ctx.handleKeydown) },
    ...{ onInput: (__VLS_ctx.autoResize) },
    ref: "inputEl",
    value: (__VLS_ctx.input),
    disabled: (!__VLS_ctx.state.connected),
    placeholder: "Ask Claude...",
    autofocus: true,
    rows: "1",
    ...{ class: "code-input" },
});
/** @type {__VLS_StyleScopedClasses['code-input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    type: "submit",
    ...{ class: "code-send-btn" },
    disabled: (!__VLS_ctx.state.connected || !__VLS_ctx.input.trim()),
});
/** @type {__VLS_StyleScopedClasses['code-send-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
    ...{ class: "bi bi-arrow-up" },
});
/** @type {__VLS_StyleScopedClasses['bi']} */ ;
/** @type {__VLS_StyleScopedClasses['bi-arrow-up']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "input-bottom-bar" },
});
/** @type {__VLS_StyleScopedClasses['input-bottom-bar']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.triggerFileUpload) },
    ...{ class: "action-btn" },
    title: "Upload file",
});
/** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
    ...{ class: "bi bi-plus-lg" },
});
/** @type {__VLS_StyleScopedClasses['bi']} */ ;
/** @type {__VLS_StyleScopedClasses['bi-plus-lg']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "popup-anchor" },
});
/** @type {__VLS_StyleScopedClasses['popup-anchor']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.showSlash = !__VLS_ctx.showSlash;
            __VLS_ctx.showModes = false;
            // @ts-ignore
            [statusText, state, state, isWorking, handleFileUpload, handleSend, handleKeydown, autoResize, input, input, triggerFileUpload, showSlash, showSlash, showModes,];
        } },
    ...{ class: "action-btn" },
    title: "Commands",
});
/** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
    ...{ class: "bi bi-slash" },
});
/** @type {__VLS_StyleScopedClasses['bi']} */ ;
/** @type {__VLS_StyleScopedClasses['bi-slash']} */ ;
if (__VLS_ctx.showSlash) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "popup slash-popup" },
    });
    /** @type {__VLS_StyleScopedClasses['popup']} */ ;
    /** @type {__VLS_StyleScopedClasses['slash-popup']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "popup-header" },
    });
    /** @type {__VLS_StyleScopedClasses['popup-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        ...{ onKeydown: () => { } },
        ...{ class: "popup-search" },
        placeholder: "Search commands...",
        autofocus: true,
    });
    (__VLS_ctx.slashFilter);
    /** @type {__VLS_StyleScopedClasses['popup-search']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "popup-scroll" },
    });
    /** @type {__VLS_StyleScopedClasses['popup-scroll']} */ ;
    if (!__VLS_ctx.allCommands.length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "popup-empty" },
        });
        /** @type {__VLS_StyleScopedClasses['popup-empty']} */ ;
    }
    for (const [c] of __VLS_vFor((__VLS_ctx.allCommands))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.showSlash))
                        return;
                    __VLS_ctx.selectCommand(c.name);
                    // @ts-ignore
                    [showSlash, slashFilter, allCommands, allCommands, selectCommand,];
                } },
            key: (c.name),
            ...{ class: "popup-item" },
        });
        /** @type {__VLS_StyleScopedClasses['popup-item']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: (['bi', c.icon]) },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "slash-name" },
        });
        /** @type {__VLS_StyleScopedClasses['slash-name']} */ ;
        (c.name);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "popup-item-desc" },
        });
        /** @type {__VLS_StyleScopedClasses['popup-item-desc']} */ ;
        (c.desc);
        // @ts-ignore
        [];
    }
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "popup-anchor" },
});
/** @type {__VLS_StyleScopedClasses['popup-anchor']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.showModes = !__VLS_ctx.showModes;
            __VLS_ctx.showSlash = false;
            // @ts-ignore
            [showSlash, showModes, showModes,];
        } },
    ...{ class: "mode-bar-btn" },
});
/** @type {__VLS_StyleScopedClasses['mode-bar-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "mode-bar-model" },
});
/** @type {__VLS_StyleScopedClasses['mode-bar-model']} */ ;
(__VLS_ctx.currentModel);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "mode-bar-sep" },
});
/** @type {__VLS_StyleScopedClasses['mode-bar-sep']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "mode-bar-mode" },
});
/** @type {__VLS_StyleScopedClasses['mode-bar-mode']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
    ...{ class: "bi bi-chevron-up" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['bi']} */ ;
/** @type {__VLS_StyleScopedClasses['bi-chevron-up']} */ ;
if (__VLS_ctx.showModes) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "popup modes-popup" },
    });
    /** @type {__VLS_StyleScopedClasses['popup']} */ ;
    /** @type {__VLS_StyleScopedClasses['modes-popup']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "popup-section-label" },
    });
    /** @type {__VLS_StyleScopedClasses['popup-section-label']} */ ;
    for (const [m] of __VLS_vFor((__VLS_ctx.models))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.showModes))
                        return;
                    __VLS_ctx.updateModel(m);
                    // @ts-ignore
                    [showModes, currentModel, models, updateModel,];
                } },
            key: (m),
            ...{ class: "popup-item" },
            ...{ class: ({ active: __VLS_ctx.config.claude?.model === m }) },
        });
        /** @type {__VLS_StyleScopedClasses['popup-item']} */ ;
        /** @type {__VLS_StyleScopedClasses['active']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "bi bi-cpu" },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['bi-cpu']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        (m.replace('claude-', '').replace(/-\d+$/, ''));
        if (__VLS_ctx.config.claude?.model === m) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi bi-check2 ms-auto" },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-check2']} */ ;
            /** @type {__VLS_StyleScopedClasses['ms-auto']} */ ;
        }
        // @ts-ignore
        [config, config,];
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "popup-divider" },
    });
    /** @type {__VLS_StyleScopedClasses['popup-divider']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "popup-item active" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['popup-item']} */ ;
    /** @type {__VLS_StyleScopedClasses['active']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-lock" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-lock']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "popup-item-desc" },
    });
    /** @type {__VLS_StyleScopedClasses['popup-item-desc']} */ ;
    if (__VLS_ctx.savingConfig) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "popup-footer" },
        });
        /** @type {__VLS_StyleScopedClasses['popup-footer']} */ ;
    }
}
// @ts-ignore
[savingConfig,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
