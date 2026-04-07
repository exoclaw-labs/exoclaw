import { ref, computed, watchEffect, onMounted } from "vue";
import { useRoute } from "vue-router";
import { fetchSetupStatus } from "./composables/useApi";
import SetupWizard from "./views/SetupWizard.vue";
const route = useRoute();
// Tri-state: null = loading, false = needs setup, true = ready
const setupComplete = ref(null);
onMounted(async () => {
    try {
        const { setupComplete: done } = await fetchSetupStatus();
        setupComplete.value = done;
    }
    catch {
        // If endpoint fails, assume setup is complete (backwards compat)
        setupComplete.value = true;
    }
});
const sidebarOpen = ref(false);
const showThemePicker = ref(false);
const themes = [
    { id: "midnight", label: "Midnight", mode: "dark" },
    { id: "github-dark", label: "GitHub Dark", mode: "dark" },
    { id: "one-dark", label: "One Dark", mode: "dark" },
    { id: "tokyo-night", label: "Tokyo Night", mode: "dark" },
    { id: "catppuccin", label: "Catppuccin Mocha", mode: "dark" },
    { id: "dracula", label: "Dracula", mode: "dark" },
    { id: "nord", label: "Nord", mode: "dark" },
    { id: "rose-pine", label: "Rosé Pine", mode: "dark" },
    { id: "ayu-dark", label: "Ayu Dark", mode: "dark" },
    { id: "dark", label: "Bootstrap Dark", mode: "dark" },
    { id: "light", label: "Bootstrap Light", mode: "light" },
    { id: "github-light", label: "GitHub Light", mode: "light" },
];
const currentTheme = ref(localStorage.getItem("exoclaw-theme") || "midnight");
watchEffect(() => {
    const t = themes.find(x => x.id === currentTheme.value) || themes[0];
    document.documentElement.setAttribute("data-bs-theme", t.mode);
    document.documentElement.setAttribute("data-exoclaw-theme", t.id);
});
function setTheme(id) {
    currentTheme.value = id;
    localStorage.setItem("exoclaw-theme", id);
    showThemePicker.value = false;
}
const nav = [
    { to: "/dashboard", label: "Dashboard", icon: "bi-speedometer2" },
    { to: "/code", label: "Code", icon: "bi-braces" },
    { to: "/console", label: "Terminal", icon: "bi-terminal" },
];
const configSections = [
    { to: "/config", label: "Setup", icon: "bi-key" },
    { to: "/config/agents", label: "Agents", icon: "bi-robot" },
    { to: "/config/channels", label: "Channels", icon: "bi-broadcast" },
    { to: "/config/skills", label: "Skills", icon: "bi-lightning" },
    { to: "/config/json-files", label: "JSON Files", icon: "bi-braces" },
];
const isConfigPage = computed(() => route.path.startsWith("/config"));
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
if (__VLS_ctx.setupComplete === null) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "d-flex align-items-center justify-content-center vh-100" },
    });
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['justify-content-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['vh-100']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "text-center" },
    });
    /** @type {__VLS_StyleScopedClasses['text-center']} */ ;
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
else if (!__VLS_ctx.setupComplete) {
    const __VLS_0 = SetupWizard;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
        ...{ 'onComplete': {} },
    }));
    const __VLS_2 = __VLS_1({
        ...{ 'onComplete': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    let __VLS_5;
    const __VLS_6 = ({ complete: {} },
        { onComplete: (...[$event]) => {
                if (!!(__VLS_ctx.setupComplete === null))
                    return;
                if (!(!__VLS_ctx.setupComplete))
                    return;
                __VLS_ctx.setupComplete = true;
                // @ts-ignore
                [setupComplete, setupComplete, setupComplete,];
            } });
    var __VLS_7 = {};
    var __VLS_3;
    var __VLS_4;
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "d-flex vh-100" },
    });
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['vh-100']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "offcanvas-md offcanvas-start d-md-flex flex-column flex-shrink-0 border-end sidebar-bg" },
        ...{ class: ({ show: __VLS_ctx.sidebarOpen }) },
        ...{ style: {} },
        tabindex: "-1",
    });
    /** @type {__VLS_StyleScopedClasses['offcanvas-md']} */ ;
    /** @type {__VLS_StyleScopedClasses['offcanvas-start']} */ ;
    /** @type {__VLS_StyleScopedClasses['d-md-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['flex-column']} */ ;
    /** @type {__VLS_StyleScopedClasses['flex-shrink-0']} */ ;
    /** @type {__VLS_StyleScopedClasses['border-end']} */ ;
    /** @type {__VLS_StyleScopedClasses['sidebar-bg']} */ ;
    /** @type {__VLS_StyleScopedClasses['show']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "offcanvas-header d-md-none" },
    });
    /** @type {__VLS_StyleScopedClasses['offcanvas-header']} */ ;
    /** @type {__VLS_StyleScopedClasses['d-md-none']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h6, __VLS_intrinsics.h6)({
        ...{ class: "offcanvas-title" },
    });
    /** @type {__VLS_StyleScopedClasses['offcanvas-title']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.setupComplete === null))
                    return;
                if (!!(!__VLS_ctx.setupComplete))
                    return;
                __VLS_ctx.sidebarOpen = false;
                // @ts-ignore
                [sidebarOpen, sidebarOpen,];
            } },
        type: "button",
        ...{ class: "btn-close" },
    });
    /** @type {__VLS_StyleScopedClasses['btn-close']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "p-3 border-bottom" },
    });
    /** @type {__VLS_StyleScopedClasses['p-3']} */ ;
    /** @type {__VLS_StyleScopedClasses['border-bottom']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "d-flex align-items-center gap-2" },
    });
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-cpu fs-5 text-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-cpu']} */ ;
    /** @type {__VLS_StyleScopedClasses['fs-5']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-primary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "fw-semibold" },
    });
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
        ...{ class: "nav nav-pills flex-column p-2 gap-1 flex-grow-1 overflow-auto" },
    });
    /** @type {__VLS_StyleScopedClasses['nav']} */ ;
    /** @type {__VLS_StyleScopedClasses['nav-pills']} */ ;
    /** @type {__VLS_StyleScopedClasses['flex-column']} */ ;
    /** @type {__VLS_StyleScopedClasses['p-2']} */ ;
    /** @type {__VLS_StyleScopedClasses['gap-1']} */ ;
    /** @type {__VLS_StyleScopedClasses['flex-grow-1']} */ ;
    /** @type {__VLS_StyleScopedClasses['overflow-auto']} */ ;
    for (const [n] of __VLS_vFor((__VLS_ctx.nav))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
            key: (n.to),
            ...{ class: "nav-item" },
        });
        /** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
        let __VLS_8;
        /** @ts-ignore @type {typeof __VLS_components.routerLink | typeof __VLS_components.RouterLink | typeof __VLS_components.routerLink | typeof __VLS_components.RouterLink} */
        routerLink;
        // @ts-ignore
        const __VLS_9 = __VLS_asFunctionalComponent1(__VLS_8, new __VLS_8({
            ...{ 'onClick': {} },
            to: (n.to),
            ...{ class: "nav-link d-flex align-items-center gap-2" },
            ...{ class: ({ active: __VLS_ctx.route.path === n.to }) },
        }));
        const __VLS_10 = __VLS_9({
            ...{ 'onClick': {} },
            to: (n.to),
            ...{ class: "nav-link d-flex align-items-center gap-2" },
            ...{ class: ({ active: __VLS_ctx.route.path === n.to }) },
        }, ...__VLS_functionalComponentArgsRest(__VLS_9));
        let __VLS_13;
        const __VLS_14 = ({ click: {} },
            { onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.setupComplete === null))
                        return;
                    if (!!(!__VLS_ctx.setupComplete))
                        return;
                    __VLS_ctx.sidebarOpen = false;
                    // @ts-ignore
                    [sidebarOpen, nav, route,];
                } });
        /** @type {__VLS_StyleScopedClasses['nav-link']} */ ;
        /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
        /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
        /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
        /** @type {__VLS_StyleScopedClasses['active']} */ ;
        const { default: __VLS_15 } = __VLS_11.slots;
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: (['bi', n.icon]) },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        (n.label);
        // @ts-ignore
        [];
        var __VLS_11;
        var __VLS_12;
        // @ts-ignore
        [];
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
        ...{ class: "nav-item" },
    });
    /** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
    let __VLS_16;
    /** @ts-ignore @type {typeof __VLS_components.routerLink | typeof __VLS_components.RouterLink | typeof __VLS_components.routerLink | typeof __VLS_components.RouterLink} */
    routerLink;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent1(__VLS_16, new __VLS_16({
        ...{ 'onClick': {} },
        to: "/config",
        ...{ class: "nav-link d-flex align-items-center gap-2" },
        ...{ class: ({ active: __VLS_ctx.isConfigPage }) },
    }));
    const __VLS_18 = __VLS_17({
        ...{ 'onClick': {} },
        to: "/config",
        ...{ class: "nav-link d-flex align-items-center gap-2" },
        ...{ class: ({ active: __VLS_ctx.isConfigPage }) },
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    let __VLS_21;
    const __VLS_22 = ({ click: {} },
        { onClick: (...[$event]) => {
                if (!!(__VLS_ctx.setupComplete === null))
                    return;
                if (!!(!__VLS_ctx.setupComplete))
                    return;
                __VLS_ctx.sidebarOpen = false;
                // @ts-ignore
                [sidebarOpen, isConfigPage,];
            } });
    /** @type {__VLS_StyleScopedClasses['nav-link']} */ ;
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
    /** @type {__VLS_StyleScopedClasses['active']} */ ;
    const { default: __VLS_23 } = __VLS_19.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-gear" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-gear']} */ ;
    // @ts-ignore
    [];
    var __VLS_19;
    var __VLS_20;
    if (__VLS_ctx.isConfigPage) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
            ...{ class: "nav flex-column ms-3 mt-1 gap-1" },
        });
        /** @type {__VLS_StyleScopedClasses['nav']} */ ;
        /** @type {__VLS_StyleScopedClasses['flex-column']} */ ;
        /** @type {__VLS_StyleScopedClasses['ms-3']} */ ;
        /** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
        /** @type {__VLS_StyleScopedClasses['gap-1']} */ ;
        for (const [s] of __VLS_vFor((__VLS_ctx.configSections))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
                key: (s.to),
                ...{ class: "nav-item" },
            });
            /** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
            let __VLS_24;
            /** @ts-ignore @type {typeof __VLS_components.routerLink | typeof __VLS_components.RouterLink | typeof __VLS_components.routerLink | typeof __VLS_components.RouterLink} */
            routerLink;
            // @ts-ignore
            const __VLS_25 = __VLS_asFunctionalComponent1(__VLS_24, new __VLS_24({
                ...{ 'onClick': {} },
                to: (s.to),
                ...{ class: "nav-link py-1 px-2 d-flex align-items-center gap-2 small" },
                ...{ class: ({ active: __VLS_ctx.route.path === s.to }) },
            }));
            const __VLS_26 = __VLS_25({
                ...{ 'onClick': {} },
                to: (s.to),
                ...{ class: "nav-link py-1 px-2 d-flex align-items-center gap-2 small" },
                ...{ class: ({ active: __VLS_ctx.route.path === s.to }) },
            }, ...__VLS_functionalComponentArgsRest(__VLS_25));
            let __VLS_29;
            const __VLS_30 = ({ click: {} },
                { onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.setupComplete === null))
                            return;
                        if (!!(!__VLS_ctx.setupComplete))
                            return;
                        if (!(__VLS_ctx.isConfigPage))
                            return;
                        __VLS_ctx.sidebarOpen = false;
                        // @ts-ignore
                        [sidebarOpen, route, isConfigPage, configSections,];
                    } });
            /** @type {__VLS_StyleScopedClasses['nav-link']} */ ;
            /** @type {__VLS_StyleScopedClasses['py-1']} */ ;
            /** @type {__VLS_StyleScopedClasses['px-2']} */ ;
            /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
            /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
            /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
            /** @type {__VLS_StyleScopedClasses['small']} */ ;
            /** @type {__VLS_StyleScopedClasses['active']} */ ;
            const { default: __VLS_31 } = __VLS_27.slots;
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: (['bi', s.icon]) },
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            (s.label);
            // @ts-ignore
            [];
            var __VLS_27;
            var __VLS_28;
            // @ts-ignore
            [];
        }
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "p-3 border-top text-center small text-body-tertiary" },
    });
    /** @type {__VLS_StyleScopedClasses['p-3']} */ ;
    /** @type {__VLS_StyleScopedClasses['border-top']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['small']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-body-tertiary']} */ ;
    if (__VLS_ctx.sidebarOpen) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.setupComplete === null))
                        return;
                    if (!!(!__VLS_ctx.setupComplete))
                        return;
                    if (!(__VLS_ctx.sidebarOpen))
                        return;
                    __VLS_ctx.sidebarOpen = false;
                    // @ts-ignore
                    [sidebarOpen, sidebarOpen,];
                } },
            ...{ class: "offcanvas-backdrop fade show d-md-none" },
        });
        /** @type {__VLS_StyleScopedClasses['offcanvas-backdrop']} */ ;
        /** @type {__VLS_StyleScopedClasses['fade']} */ ;
        /** @type {__VLS_StyleScopedClasses['show']} */ ;
        /** @type {__VLS_StyleScopedClasses['d-md-none']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "flex-grow-1 d-flex flex-column overflow-hidden" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['flex-grow-1']} */ ;
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['flex-column']} */ ;
    /** @type {__VLS_StyleScopedClasses['overflow-hidden']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.nav, __VLS_intrinsics.nav)({
        ...{ class: "navbar border-bottom px-3 py-2" },
    });
    /** @type {__VLS_StyleScopedClasses['navbar']} */ ;
    /** @type {__VLS_StyleScopedClasses['border-bottom']} */ ;
    /** @type {__VLS_StyleScopedClasses['px-3']} */ ;
    /** @type {__VLS_StyleScopedClasses['py-2']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "d-flex align-items-center" },
    });
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.setupComplete === null))
                    return;
                if (!!(!__VLS_ctx.setupComplete))
                    return;
                __VLS_ctx.sidebarOpen = !__VLS_ctx.sidebarOpen;
                // @ts-ignore
                [sidebarOpen, sidebarOpen,];
            } },
        ...{ class: "btn btn-sm btn-outline-secondary d-md-none me-2" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['d-md-none']} */ ;
    /** @type {__VLS_StyleScopedClasses['me-2']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-list" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-list']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "navbar-text fw-semibold" },
    });
    /** @type {__VLS_StyleScopedClasses['navbar-text']} */ ;
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    (__VLS_ctx.route.meta?.title || 'exoclaw');
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "position-relative" },
    });
    /** @type {__VLS_StyleScopedClasses['position-relative']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.setupComplete === null))
                    return;
                if (!!(!__VLS_ctx.setupComplete))
                    return;
                __VLS_ctx.showThemePicker = !__VLS_ctx.showThemePicker;
                // @ts-ignore
                [route, showThemePicker, showThemePicker,];
            } },
        ...{ class: "btn btn-sm btn-outline-secondary" },
        title: "Theme",
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-outline-secondary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-palette" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-palette']} */ ;
    if (__VLS_ctx.showThemePicker) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "dropdown-menu show end-0 mt-1 p-1" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['dropdown-menu']} */ ;
        /** @type {__VLS_StyleScopedClasses['show']} */ ;
        /** @type {__VLS_StyleScopedClasses['end-0']} */ ;
        /** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
        /** @type {__VLS_StyleScopedClasses['p-1']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "px-2 py-1 text-body-secondary small fw-semibold" },
        });
        /** @type {__VLS_StyleScopedClasses['px-2']} */ ;
        /** @type {__VLS_StyleScopedClasses['py-1']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
        for (const [t] of __VLS_vFor((__VLS_ctx.themes.filter(x => x.mode === 'dark')))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.setupComplete === null))
                            return;
                        if (!!(!__VLS_ctx.setupComplete))
                            return;
                        if (!(__VLS_ctx.showThemePicker))
                            return;
                        __VLS_ctx.setTheme(t.id);
                        // @ts-ignore
                        [showThemePicker, themes, setTheme,];
                    } },
                key: (t.id),
                ...{ class: "dropdown-item rounded small py-1" },
                ...{ class: ({ active: __VLS_ctx.currentTheme === t.id }) },
            });
            /** @type {__VLS_StyleScopedClasses['dropdown-item']} */ ;
            /** @type {__VLS_StyleScopedClasses['rounded']} */ ;
            /** @type {__VLS_StyleScopedClasses['small']} */ ;
            /** @type {__VLS_StyleScopedClasses['py-1']} */ ;
            /** @type {__VLS_StyleScopedClasses['active']} */ ;
            (t.label);
            // @ts-ignore
            [currentTheme,];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.hr)({
            ...{ class: "my-1" },
        });
        /** @type {__VLS_StyleScopedClasses['my-1']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "px-2 py-1 text-body-secondary small fw-semibold" },
        });
        /** @type {__VLS_StyleScopedClasses['px-2']} */ ;
        /** @type {__VLS_StyleScopedClasses['py-1']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
        for (const [t] of __VLS_vFor((__VLS_ctx.themes.filter(x => x.mode === 'light')))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.setupComplete === null))
                            return;
                        if (!!(!__VLS_ctx.setupComplete))
                            return;
                        if (!(__VLS_ctx.showThemePicker))
                            return;
                        __VLS_ctx.setTheme(t.id);
                        // @ts-ignore
                        [themes, setTheme,];
                    } },
                key: (t.id),
                ...{ class: "dropdown-item rounded small py-1" },
                ...{ class: ({ active: __VLS_ctx.currentTheme === t.id }) },
            });
            /** @type {__VLS_StyleScopedClasses['dropdown-item']} */ ;
            /** @type {__VLS_StyleScopedClasses['rounded']} */ ;
            /** @type {__VLS_StyleScopedClasses['small']} */ ;
            /** @type {__VLS_StyleScopedClasses['py-1']} */ ;
            /** @type {__VLS_StyleScopedClasses['active']} */ ;
            (t.label);
            // @ts-ignore
            [currentTheme,];
        }
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.main, __VLS_intrinsics.main)({
        ...{ class: "flex-grow-1 overflow-auto" },
    });
    /** @type {__VLS_StyleScopedClasses['flex-grow-1']} */ ;
    /** @type {__VLS_StyleScopedClasses['overflow-auto']} */ ;
    let __VLS_32;
    /** @ts-ignore @type {typeof __VLS_components.routerView | typeof __VLS_components.RouterView} */
    routerView;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent1(__VLS_32, new __VLS_32({}));
    const __VLS_34 = __VLS_33({}, ...__VLS_functionalComponentArgsRest(__VLS_33));
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
