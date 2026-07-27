import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";

export type AppPage = "progress" | "notifications" | "tasks" | "profiles" | "settings" | "debug";

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/applications" },
  { path: "/applications", name: "progress", component: { template: "<span />" }, meta: { page: "progress" } },
  { path: "/notifications", name: "notifications", component: { template: "<span />" }, meta: { page: "notifications" } },
  { path: "/tasks", name: "tasks", component: { template: "<span />" }, meta: { page: "tasks" } },
  { path: "/browser-profiles", name: "profiles", component: { template: "<span />" }, meta: { page: "profiles" } },
  { path: "/settings", name: "settings", component: { template: "<span />" }, meta: { page: "settings" } },
  { path: "/ai-debug", name: "debug", component: { template: "<span />" }, meta: { page: "debug" } },
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
  debug: "/ai-debug",
};
