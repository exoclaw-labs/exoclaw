import { ref, onMounted, onUnmounted, nextTick } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
const containerEl = ref(null);
const connected = ref(false);
let term = null;
let fitAddon = null;
let ws = null;
let resizeObserver = null;
function getThemeColors() {
    const style = getComputedStyle(document.documentElement);
    const bg = style.getPropertyValue("--bs-body-bg").trim() || "#0b0b14";
    const fg = style.getPropertyValue("--bs-body-color").trim() || "#d4d4dc";
    const cursor = style.getPropertyValue("--bs-primary").trim() || "#7c3aed";
    return { bg, fg, cursor };
}
function termWsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws/terminal`;
}
function connect() {
    if (!containerEl.value)
        return;
    const colors = getThemeColors();
    term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace",
        theme: { background: colors.bg, foreground: colors.fg, cursor: colors.cursor, selectionBackground: colors.cursor + "44" },
        allowTransparency: true,
        scrollback: 5000,
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerEl.value);
    nextTick(() => { fitAddon?.fit(); });
    ws = new WebSocket(termWsUrl());
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
        connected.value = true;
        term?.focus();
        if (term)
            ws?.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    ws.onclose = () => { connected.value = false; term?.write("\r\n\x1b[31m[Disconnected]\x1b[0m\r\n"); };
    ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer)
            term?.write(new Uint8Array(ev.data));
        else
            term?.write(ev.data);
    };
    term.onData((data) => { if (ws?.readyState === WebSocket.OPEN)
        ws.send(data); });
    term.onResize(({ cols, rows }) => { if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "resize", cols, rows })); });
    resizeObserver = new ResizeObserver(() => { fitAddon?.fit(); });
    resizeObserver.observe(containerEl.value);
}
function reconnect() {
    ws?.close();
    term?.dispose();
    if (resizeObserver && containerEl.value)
        resizeObserver.unobserve(containerEl.value);
    connect();
}
onMounted(() => { nextTick(connect); });
onUnmounted(() => { ws?.close(); term?.dispose(); resizeObserver?.disconnect(); });
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['header-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['terminal-container']} */ ;
/** @type {__VLS_StyleScopedClasses['terminal-container']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "terminal-page d-flex flex-column h-100" },
});
/** @type {__VLS_StyleScopedClasses['terminal-page']} */ ;
/** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-column']} */ ;
/** @type {__VLS_StyleScopedClasses['h-100']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "terminal-header" },
});
/** @type {__VLS_StyleScopedClasses['terminal-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "d-flex align-items-center gap-2" },
});
/** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
/** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
    ...{ class: "bi bi-terminal" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['bi']} */ ;
/** @type {__VLS_StyleScopedClasses['bi-terminal']} */ ;
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
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "status-dot" },
    ...{ class: (__VLS_ctx.connected ? 'connected' : 'disconnected') },
});
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.reconnect) },
    ...{ class: "header-btn" },
    title: "Reconnect",
});
/** @type {__VLS_StyleScopedClasses['header-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
    ...{ class: "bi bi-arrow-clockwise" },
});
/** @type {__VLS_StyleScopedClasses['bi']} */ ;
/** @type {__VLS_StyleScopedClasses['bi-arrow-clockwise']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ref: "containerEl",
    ...{ class: "terminal-container" },
});
/** @type {__VLS_StyleScopedClasses['terminal-container']} */ ;
// @ts-ignore
[connected, reconnect,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
