import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap/dist/js/bootstrap.bundle.min.js";
import App from "./App.vue";
import Dashboard from "./views/Dashboard.vue";
import Config from "./views/Config.vue";
import Code from "./views/Code.vue";
import Terminal from "./views/Terminal.vue";
import Chat from "./views/Chat.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/dashboard" },
    { path: "/dashboard", component: Dashboard, meta: { title: "Dashboard" } },
    { path: "/chat", component: Chat, meta: { title: "Chat" } },
    { path: "/config/:section?", component: Config, meta: { title: "Configuration" } },
    { path: "/code", component: Code, meta: { title: "Code" } },
    { path: "/terminal", component: Terminal, meta: { title: "Terminal" } },
  ],
});

createApp(App).use(router).mount("#app");
