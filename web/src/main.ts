import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap/dist/js/bootstrap.bundle.min.js";
import App from "./App.vue";
import Dashboard from "./views/Dashboard.vue";
import Config from "./views/Config.vue";
import Console from "./views/Console.vue";
import Code from "./views/Code.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/dashboard" },
    { path: "/dashboard", component: Dashboard, meta: { title: "Dashboard" } },
    { path: "/code", component: Code, meta: { title: "Claude Code" } },
    { path: "/config/:section?", component: Config, meta: { title: "Configuration" } },
    { path: "/console", component: Console, meta: { title: "Console" } },
  ],
});

createApp(App).use(router).mount("#app");
