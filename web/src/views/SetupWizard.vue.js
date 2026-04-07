import { ref } from "vue";
import { completeSetup } from "../composables/useApi";
import Setup from "./Setup.vue";
const emit = defineEmits();
const currentStep = ref("welcome");
const stepIndex = { welcome: 0, login: 1, browser: 2, integrations: 3, persona: 4, complete: 5 };
const steps = ["Welcome", "Login", "Browser", "Integrations", "Persona", "Complete"];
// Browser tool selection
const browserTool = ref("gologin");
const browserApiKey = ref("");
// Composio integration
const composioEnabled = ref(false);
const composioApiKey = ref("");
// Auth info (fetched after login)
const authInfo = ref(null);
const personaName = ref("");
const saving = ref(false);
const error = ref("");
function onLoginComplete() {
    // Fetch auth status for the summary
    fetch("/api/auth/status").then(r => r.json()).then(data => { authInfo.value = data; }).catch(() => { });
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
        await completeSetup(browserTool.value, key, composioEnabled.value ? composioApiKey.value.trim() : undefined);
        emit("complete");
    }
    catch (e) {
        error.value = String(e);
    }
    saving.value = false;
}
const browserOptions = [
    {
        id: "gologin",
        name: "GoLogin",
        icon: "bi-globe2",
        desc: "Cloud browser profiles with anti-detection. Managed remotely — no local Chrome needed.",
        badge: "Recommended",
        needsKey: true,
        keyPlaceholder: "GoLogin API token",
        keyHint: "Get your token from app.gologin.com > API settings",
    },
    {
        id: "browser-use",
        name: "Browser Use",
        icon: "bi-cloud",
        desc: "AI-powered cloud browser automation. Runs remotely via the Browser Use API.",
        badge: null,
        needsKey: true,
        keyPlaceholder: "Browser Use API key",
        keyHint: "Get your key from cloud.browser-use.com",
    },
    {
        id: "agent-browser",
        name: "Local Chrome",
        icon: "bi-window",
        desc: "Headless Chrome running inside the container. Works out of the box, no API key needed.",
        badge: null,
        needsKey: false,
        keyPlaceholder: "",
        keyHint: "",
    },
    {
        id: "none",
        name: "No Browser",
        icon: "bi-x-circle",
        desc: "Skip browser tools entirely. You can add one later from the config page.",
        badge: null,
        needsKey: false,
        keyPlaceholder: "",
        keyHint: "",
    },
];
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
    ...{ class: "d-flex flex-column align-items-center justify-content-center min-vh-100 p-4" },
});
/** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
/** @type {__VLS_StyleScopedClasses['flex-column']} */ ;
/** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
/** @type {__VLS_StyleScopedClasses['justify-content-center']} */ ;
/** @type {__VLS_StyleScopedClasses['min-vh-100']} */ ;
/** @type {__VLS_StyleScopedClasses['p-4']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "d-flex gap-2 mb-4" },
});
/** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
/** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
for (const [s, i] of __VLS_vFor((__VLS_ctx.steps))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        key: (s),
        ...{ class: "rounded-pill d-flex align-items-center gap-1 px-2 py-1" },
        ...{ class: (i === __VLS_ctx.stepIndex[__VLS_ctx.currentStep]
                ? 'bg-primary text-white'
                : i < __VLS_ctx.stepIndex[__VLS_ctx.currentStep]
                    ? 'bg-primary bg-opacity-25 text-primary'
                    : 'bg-body-secondary text-body-tertiary') },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['rounded-pill']} */ ;
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['align-items-center']} */ ;
    /** @type {__VLS_StyleScopedClasses['gap-1']} */ ;
    /** @type {__VLS_StyleScopedClasses['px-2']} */ ;
    /** @type {__VLS_StyleScopedClasses['py-1']} */ ;
    if (i < __VLS_ctx.stepIndex[__VLS_ctx.currentStep]) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "bi bi-check-lg" },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['bi-check-lg']} */ ;
    }
    (s);
    // @ts-ignore
    [steps, stepIndex, stepIndex, stepIndex, currentStep, currentStep, currentStep,];
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ style: {} },
});
if (__VLS_ctx.currentStep === 'welcome') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "text-center" },
    });
    /** @type {__VLS_StyleScopedClasses['text-center']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "mb-4" },
    });
    /** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-cpu text-primary" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-cpu']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-primary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
        ...{ class: "fw-semibold mb-2" },
    });
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-2']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "text-body-secondary mb-4" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.currentStep === 'welcome'))
                    return;
                __VLS_ctx.currentStep = 'login';
                // @ts-ignore
                [currentStep, currentStep,];
            } },
        ...{ class: "btn btn-primary btn-lg px-5" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-lg']} */ ;
    /** @type {__VLS_StyleScopedClasses['px-5']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-arrow-right ms-1" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-arrow-right']} */ ;
    /** @type {__VLS_StyleScopedClasses['ms-1']} */ ;
}
else if (__VLS_ctx.currentStep === 'login') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.h5, __VLS_intrinsics.h5)({
        ...{ class: "fw-semibold mb-1" },
    });
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "text-body-secondary small mb-3" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['small']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
    const __VLS_0 = Setup;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
        ...{ 'onComplete': {} },
        skipPersona: (true),
    }));
    const __VLS_2 = __VLS_1({
        ...{ 'onComplete': {} },
        skipPersona: (true),
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    let __VLS_5;
    const __VLS_6 = ({ complete: {} },
        { onComplete: (__VLS_ctx.onLoginComplete) });
    var __VLS_3;
    var __VLS_4;
}
else if (__VLS_ctx.currentStep === 'browser') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.h5, __VLS_intrinsics.h5)({
        ...{ class: "fw-semibold mb-1" },
    });
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "text-body-secondary small mb-3" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['small']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "d-grid gap-2 mb-3" },
    });
    /** @type {__VLS_StyleScopedClasses['d-grid']} */ ;
    /** @type {__VLS_StyleScopedClasses['gap-2']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
    for (const [opt] of __VLS_vFor((__VLS_ctx.browserOptions))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.currentStep === 'welcome'))
                        return;
                    if (!!(__VLS_ctx.currentStep === 'login'))
                        return;
                    if (!(__VLS_ctx.currentStep === 'browser'))
                        return;
                    __VLS_ctx.browserTool = opt.id;
                    __VLS_ctx.browserApiKey = '';
                    // @ts-ignore
                    [currentStep, currentStep, onLoginComplete, browserOptions, browserTool, browserApiKey,];
                } },
            key: (opt.id),
            ...{ class: "btn text-start py-3 px-4" },
            ...{ class: (__VLS_ctx.browserTool === opt.id ? 'btn-outline-primary border-primary' : 'btn-outline-secondary') },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
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
            ...{ class: (['bi', opt.icon, 'fs-4']) },
            ...{ style: (__VLS_ctx.browserTool === opt.id ? 'color: var(--bs-primary)' : '') },
        });
        /** @type {__VLS_StyleScopedClasses['bi']} */ ;
        /** @type {__VLS_StyleScopedClasses['fs-4']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "flex-grow-1" },
        });
        /** @type {__VLS_StyleScopedClasses['flex-grow-1']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "fw-semibold" },
        });
        /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
        (opt.name);
        if (opt.badge) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "badge text-bg-primary ms-1" },
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['badge']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-bg-primary']} */ ;
            /** @type {__VLS_StyleScopedClasses['ms-1']} */ ;
            (opt.badge);
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.small, __VLS_intrinsics.small)({
            ...{ class: "text-body-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        (opt.desc);
        if (__VLS_ctx.browserTool === opt.id) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
                ...{ class: "bi bi-check-circle-fill text-primary" },
            });
            /** @type {__VLS_StyleScopedClasses['bi']} */ ;
            /** @type {__VLS_StyleScopedClasses['bi-check-circle-fill']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-primary']} */ ;
        }
        // @ts-ignore
        [browserTool, browserTool, browserTool,];
    }
    if (__VLS_ctx.browserOptions.find(o => o.id === __VLS_ctx.browserTool)?.needsKey) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "card mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['card']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "card-body py-3" },
        });
        /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
        /** @type {__VLS_StyleScopedClasses['py-3']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small fw-semibold mb-1" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "password",
            ...{ class: "form-control form-control-sm font-monospace" },
            placeholder: (__VLS_ctx.browserOptions.find(o => o.id === __VLS_ctx.browserTool)?.keyPlaceholder),
        });
        (__VLS_ctx.browserApiKey);
        /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
        /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-text small" },
        });
        /** @type {__VLS_StyleScopedClasses['form-text']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        (__VLS_ctx.browserOptions.find(o => o.id === __VLS_ctx.browserTool)?.keyHint);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.onBrowserContinue) },
        ...{ class: "btn btn-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-arrow-right ms-1" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-arrow-right']} */ ;
    /** @type {__VLS_StyleScopedClasses['ms-1']} */ ;
}
else if (__VLS_ctx.currentStep === 'integrations') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.h5, __VLS_intrinsics.h5)({
        ...{ class: "fw-semibold mb-1" },
    });
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "text-body-secondary small mb-3" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['small']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card mb-3" },
    });
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-body" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "d-flex align-items-start gap-3" },
    });
    /** @type {__VLS_StyleScopedClasses['d-flex']} */ ;
    /** @type {__VLS_StyleScopedClasses['align-items-start']} */ ;
    /** @type {__VLS_StyleScopedClasses['gap-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "form-check form-switch mt-1" },
    });
    /** @type {__VLS_StyleScopedClasses['form-check']} */ ;
    /** @type {__VLS_StyleScopedClasses['form-switch']} */ ;
    /** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        ...{ class: "form-check-input" },
        type: "checkbox",
        id: "composio-toggle",
    });
    (__VLS_ctx.composioEnabled);
    /** @type {__VLS_StyleScopedClasses['form-check-input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        for: "composio-toggle",
        ...{ class: "flex-grow-1" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['flex-grow-1']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "fw-semibold" },
    });
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "badge text-bg-info ms-1" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['badge']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-bg-info']} */ ;
    /** @type {__VLS_StyleScopedClasses['ms-1']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.small, __VLS_intrinsics.small)({
        ...{ class: "text-body-secondary d-block mt-1" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['d-block']} */ ;
    /** @type {__VLS_StyleScopedClasses['mt-1']} */ ;
    if (__VLS_ctx.composioEnabled) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mt-3 ps-5" },
        });
        /** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
        /** @type {__VLS_StyleScopedClasses['ps-5']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "form-label small fw-semibold mb-1" },
        });
        /** @type {__VLS_StyleScopedClasses['form-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "password",
            ...{ class: "form-control form-control-sm font-monospace" },
            placeholder: "ck_...",
        });
        (__VLS_ctx.composioApiKey);
        /** @type {__VLS_StyleScopedClasses['form-control']} */ ;
        /** @type {__VLS_StyleScopedClasses['form-control-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['font-monospace']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-text small" },
        });
        /** @type {__VLS_StyleScopedClasses['form-text']} */ ;
        /** @type {__VLS_StyleScopedClasses['small']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.a, __VLS_intrinsics.a)({
            href: "https://composio.dev",
            target: "_blank",
            rel: "noopener",
        });
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.onIntegrationsContinue) },
        ...{ class: "btn btn-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-arrow-right ms-1" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-arrow-right']} */ ;
    /** @type {__VLS_StyleScopedClasses['ms-1']} */ ;
}
else if (__VLS_ctx.currentStep === 'persona') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.h5, __VLS_intrinsics.h5)({
        ...{ class: "fw-semibold mb-1" },
    });
    /** @type {__VLS_StyleScopedClasses['fw-semibold']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-1']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "text-body-secondary small mb-3" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['small']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
    const __VLS_7 = Setup;
    // @ts-ignore
    const __VLS_8 = __VLS_asFunctionalComponent1(__VLS_7, new __VLS_7({
        ...{ 'onComplete': {} },
        forcePersona: (true),
    }));
    const __VLS_9 = __VLS_8({
        ...{ 'onComplete': {} },
        forcePersona: (true),
    }, ...__VLS_functionalComponentArgsRest(__VLS_8));
    let __VLS_12;
    const __VLS_13 = ({ complete: {} },
        { onComplete: (__VLS_ctx.onPersonaComplete) });
    var __VLS_10;
    var __VLS_11;
}
else if (__VLS_ctx.currentStep === 'complete') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
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
        ...{ class: "mt-3 mb-3" },
    });
    /** @type {__VLS_StyleScopedClasses['mt-3']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.table, __VLS_intrinsics.table)({
        ...{ class: "table table-sm text-start mx-auto mb-4" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['table']} */ ;
    /** @type {__VLS_StyleScopedClasses['table-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-start']} */ ;
    /** @type {__VLS_StyleScopedClasses['mx-auto']} */ ;
    /** @type {__VLS_StyleScopedClasses['mb-4']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.tbody, __VLS_intrinsics.tbody)({});
    if (__VLS_ctx.authInfo?.email) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.tr, __VLS_intrinsics.tr)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({
            ...{ class: "text-body-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({});
        (__VLS_ctx.authInfo.email);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.tr, __VLS_intrinsics.tr)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({
        ...{ class: "text-body-secondary" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({
        ...{ class: "text-capitalize" },
    });
    /** @type {__VLS_StyleScopedClasses['text-capitalize']} */ ;
    (__VLS_ctx.browserTool === "agent-browser" ? "Local Chrome" : __VLS_ctx.browserTool === "none" ? "None" : __VLS_ctx.browserOptions.find(o => o.id === __VLS_ctx.browserTool)?.name);
    __VLS_asFunctionalElement1(__VLS_intrinsics.tr, __VLS_intrinsics.tr)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({
        ...{ class: "text-body-secondary" },
    });
    /** @type {__VLS_StyleScopedClasses['text-body-secondary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.td, __VLS_intrinsics.td)({});
    (__VLS_ctx.composioEnabled ? 'Enabled' : 'Skipped');
    if (__VLS_ctx.error) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "alert alert-danger py-2 mb-3" },
        });
        /** @type {__VLS_StyleScopedClasses['alert']} */ ;
        /** @type {__VLS_StyleScopedClasses['alert-danger']} */ ;
        /** @type {__VLS_StyleScopedClasses['py-2']} */ ;
        /** @type {__VLS_StyleScopedClasses['mb-3']} */ ;
        (__VLS_ctx.error);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.launch) },
        ...{ class: "btn btn-primary btn-lg px-5" },
        disabled: (__VLS_ctx.saving),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-lg']} */ ;
    /** @type {__VLS_StyleScopedClasses['px-5']} */ ;
    if (__VLS_ctx.saving) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "spinner-border spinner-border-sm me-1" },
        });
        /** @type {__VLS_StyleScopedClasses['spinner-border']} */ ;
        /** @type {__VLS_StyleScopedClasses['spinner-border-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['me-1']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
        ...{ class: "bi bi-arrow-right ms-1" },
    });
    /** @type {__VLS_StyleScopedClasses['bi']} */ ;
    /** @type {__VLS_StyleScopedClasses['bi-arrow-right']} */ ;
    /** @type {__VLS_StyleScopedClasses['ms-1']} */ ;
}
// @ts-ignore
[currentStep, currentStep, currentStep, browserOptions, browserOptions, browserOptions, browserOptions, browserTool, browserTool, browserTool, browserTool, browserTool, browserTool, browserApiKey, onBrowserContinue, composioEnabled, composioEnabled, composioEnabled, composioApiKey, onIntegrationsContinue, onPersonaComplete, authInfo, authInfo, error, error, launch, saving, saving,];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
});
export default {};
