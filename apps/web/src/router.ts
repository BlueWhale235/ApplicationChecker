import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { h } from "vue";

export type AppPage = "progress" | "notifications" | "tasks" | "profiles" | "settings" | "debug";
const RouteMarker = { render: () => h("span") };

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/applications" },
  { path: "/applications", name: "progress", component: RouteMarker, meta: { page: "progress" } },
  { path: "/notifications", name: "notifications", component: RouteMarker, meta: { page: "notifications" } },
  { path: "/tasks", name: "tasks", component: RouteMarker, meta: { page: "tasks" } },
  { path: "/browser-profiles", name: "profiles", component: RouteMarker, meta: { page: "profiles" } },
  { path: "/settings", name: "settings", component: RouteMarker, meta: { page: "settings" } },
  { path: "/recognition-debug", name: "debug", component: RouteMarker, meta: { page: "debug" } },
  { path: "/ai-debug", redirect: "/recognition-debug" },
  { path: "/:pathMatch(.*)*", redirect: "/applications" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

export const pagePaths: Record<AppPage, string> = {
  progress: "/applications",
  notifications: "/notifications",
  tasks: "/tasks",
  profiles: "/browser-profiles",
  settings: "/settings",
  debug: "/recognition-debug",
};
