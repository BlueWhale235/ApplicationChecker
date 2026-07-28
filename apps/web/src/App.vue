<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import type {
  AiSettingsUpdate, AppSettings, ApplicationDetail, ApplicationSummary, BrowserProfileSummary, BrowserStorageUsage,
  CheckPlanUpdate, CreateApplication, NotificationPage, NotificationSummary, ProgressStatus, RecognitionMode, RunSummary, ScheduleMode, StatusMappings, TaskRunPage, TaskRunSummary,
} from "@application-checker/contracts";
import { DEFAULT_USER_AGENT, progressLabels } from "@application-checker/contracts";
import { api } from "./api";
import AppSidebar from "./components/AppSidebar.vue";
import ApplicationForm from "./components/ApplicationForm.vue";
import LoginDialog from "./components/LoginDialog.vue";
import ScreenshotViewer from "./components/ScreenshotViewer.vue";
import TaskManager from "./components/TaskManager.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import AiSettingsDialog from "./components/AiSettingsDialog.vue";
import StatusMappingsDialog from "./components/StatusMappingsDialog.vue";
import CheckPlanDialog from "./components/CheckPlanDialog.vue";
import NotificationsPage from "./components/NotificationsPage.vue";
import ProgressPage from "./pages/ProgressPage.vue";
import BrowserProfilesPage from "./pages/BrowserProfilesPage.vue";
import SettingsPage from "./pages/SettingsPage.vue";
import AiDebugPage from "./pages/AiDebugPage.vue";
import RuleStudioPage from "./pages/RuleStudioPage.vue";
import type { AssistedParserRule } from "@application-checker/contracts";
import { pagePaths, type AppPage } from "./router";

const route = useRoute();
const router = useRouter();
const active = computed<AppPage>(() => (route.meta.page as AppPage | undefined) ?? "progress");
const applications = ref<ApplicationSummary[]>([]);
const detail = ref<ApplicationDetail | null>(null);
const profiles = ref<BrowserProfileSummary[]>([]);
const browserStorage = ref<BrowserStorageUsage | null>(null);
const settings = ref<AppSettings>({
  globalCron: null,
  timezone: "Asia/Shanghai",
  screenshotRetentionDays: 30,
  defaultUserAgent: DEFAULT_USER_AGENT,
  aiConfigured: false,
  aiBaseUrl: null,
  aiModel: null,
  aiApiKeySet: false,
  aiConfidenceThreshold: 0.75,
  aiDeepThinking: false,
  recognitionMode: "local_first",
  statusMappings: {
    screening: [],
    screening_passed: [],
    interview_pending: [],
    interviewed: [],
    signing_pending: [],
    offer: [],
    rejected: [],
  },
  builtinStatusMappings: {
    screening: [],
    screening_passed: [],
    interview_pending: [],
    interviewed: [],
    signing_pending: [],
    offer: [],
    rejected: [],
  },
  runnerHealthy: false,
  loginPresentation: "vnc",
});
const settingsForm = reactive({
  globalCron: "",
  timezone: "Asia/Shanghai",
  screenshotRetentionDays: 30,
  defaultUserAgent: DEFAULT_USER_AGENT,
});
const emptyTaskPage = (): TaskRunPage => ({ items: [], total: 0, limit: 50, offset: 0 });
const taskPage = ref<TaskRunPage>(emptyTaskPage());
const taskScope = ref<"active" | "history">("active");
const taskQuery = ref("");
const taskHistoryPage = ref(1);
const taskHistoryPerPage = 10;
const taskHistoryPageCount = computed(() => Math.max(1, Math.ceil(taskPage.value.total / taskHistoryPerPage)));
const emptyNotificationPage = (): NotificationPage => ({ items: [], total: 0, unreadCount: 0, limit: 20, offset: 0 });
const notificationPage = ref<NotificationPage>(emptyNotificationPage());
const notificationScope = ref<"all" | "unread">("all");
const notificationCurrentPage = ref(1);
const notificationsPerPage = 10;
const notificationPageCount = computed(() => Math.max(1, Math.ceil(notificationPage.value.total / notificationsPerPage)));
const unreadNotificationCount = ref(0);
const screenshotRun = ref<RunSummary | null>(null);
const screenshotCompany = ref("");
const screenshotJobTitle = ref("");
const selected = ref(new Set<string>());
const query = ref("");
const statusFilter = ref("");
const scheduleFilter = ref<ScheduleMode | "">("");
const applicationPage = ref(1);
const applicationsPerPage = 10;
const loading = ref(true);
const detailLoading = ref(false);
const busy = ref(false);
const formOpen = ref(false);
const formEditItem = ref<ApplicationSummary | null>(null);
const loginOpen = ref(false);
const loginRunId = ref<string | null>(null);
const aiSettingsOpen = ref(false);
const statusMappingsOpen = ref(false);
const checkPlanOpen = ref(false);
const error = ref("");
const notice = ref("");
const debugEnabled = ref(false);
const debugRefreshToken = ref(0);
let timer: number | undefined;
let taskTimer: number | undefined;
let taskSearchTimer: number | undefined;
const confirmState = reactive({
  open: false,
  title: "",
  message: "",
  confirmLabel: "确认",
  danger: false,
});
let confirmResolver: ((value: boolean) => void) | undefined;

const filtered = computed(() => applications.value.filter((item) => {
  const matchesQuery = !query.value || `${item.company} ${item.jobTitle} ${item.checkUrl}`.toLowerCase().includes(query.value.toLowerCase());
  const matchesStatus = !statusFilter.value
    || (statusFilter.value === "needs_login" ? item.lastRunStatus === "needs_login" : item.progressStatus === statusFilter.value);
  const matchesSchedule = !scheduleFilter.value || item.scheduleMode === scheduleFilter.value;
  return matchesQuery && matchesStatus && matchesSchedule;
}));
const applicationPageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / applicationsPerPage)));
const paginatedApplications = computed(() => {
  const start = (applicationPage.value - 1) * applicationsPerPage;
  return filtered.value.slice(start, start + applicationsPerPage);
});
const progressFilterItems = computed(() => [
  { title: "全部状态", value: "" },
  { title: "需要登录", value: "needs_login" },
  ...Object.entries(progressLabels).map(([value, title]) => ({ value, title })),
]);
const scheduleFilterItems: Array<{ title: string; value: ScheduleMode | "" }> = [
  { title: "全部检查计划", value: "" },
  { title: "继承全局计划", value: "inherit" },
  { title: "自定义计划", value: "custom" },
  { title: "仅手动检查", value: "manual" },
];

async function refreshTasks() {
  const history = taskScope.value === "history";
  const limit = history ? taskHistoryPerPage : 50;
  const offset = history ? (taskHistoryPage.value - 1) * taskHistoryPerPage : 0;
  taskPage.value = await api.tasks(taskScope.value, { q: taskQuery.value, limit, offset });
}

async function refreshNotifications() {
  const offset = (notificationCurrentPage.value - 1) * notificationsPerPage;
  const page = await api.notifications(notificationScope.value, notificationsPerPage, offset);
  notificationPage.value = page;
  unreadNotificationCount.value = page.unreadCount;
}

async function refresh(silent = false) {
  if (!silent) loading.value = true;
  try {
    const [apps, appSettings, browserProfiles, notificationCount, debugStatus] = await Promise.all([
      api.applications(), api.settings(), api.profiles(), api.unreadNotifications(), api.debugStatus(),
    ]);
    applications.value = apps;
    settings.value = appSettings;
    profiles.value = browserProfiles;
    unreadNotificationCount.value = notificationCount.unreadCount;
    debugEnabled.value = debugStatus.enabled;
    if (active.value === "debug" && !debugStatus.enabled) void router.replace(pagePaths.settings);
    if (!silent) {
      settingsForm.globalCron = appSettings.globalCron ?? "";
      settingsForm.timezone = appSettings.timezone;
      settingsForm.screenshotRetentionDays = appSettings.screenshotRetentionDays;
      settingsForm.defaultUserAgent = appSettings.defaultUserAgent;
    }
    if (detail.value) detail.value = await api.application(detail.value.application.id).catch(() => null);
  } catch (value) {
    error.value = value instanceof Error ? value.message : "加载失败";
  } finally {
    loading.value = false;
  }
}
onMounted(() => {
  void refresh();
  timer = window.setInterval(() => void refresh(true), 5000);
  taskTimer = window.setInterval(() => {
    if (active.value === "tasks" && taskScope.value === "active") void refreshTasks();
    if (active.value === "notifications") void refreshNotifications();
  }, 3000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  if (taskTimer) clearInterval(taskTimer);
  if (taskSearchTimer) clearTimeout(taskSearchTimer);
});
watch([active, taskScope], ([page], previous) => {
  if (previous && taskScope.value !== previous[1] && taskHistoryPage.value !== 1) {
    taskHistoryPage.value = 1;
    return;
  }
  if (page === "tasks") void refreshTasks();
  if (page === "notifications") void refreshNotifications();
});
watch(notificationScope, () => {
  if (notificationCurrentPage.value !== 1) {
    notificationCurrentPage.value = 1;
    return;
  }
  void refreshNotifications();
});
watch(notificationCurrentPage, () => {
  if (active.value === "notifications") void refreshNotifications();
});
watch(notificationPageCount, (count) => {
  if (notificationCurrentPage.value > count) notificationCurrentPage.value = count;
});
watch(taskQuery, () => {
  if (taskSearchTimer) clearTimeout(taskSearchTimer);
  taskHistoryPage.value = 1;
  taskSearchTimer = window.setTimeout(() => void refreshTasks(), 250);
});
watch(taskHistoryPage, () => {
  if (active.value === "tasks" && taskScope.value === "history") void refreshTasks();
});
watch(taskHistoryPageCount, (count) => {
  if (taskHistoryPage.value > count) taskHistoryPage.value = count;
});
watch([query, statusFilter, scheduleFilter], () => { applicationPage.value = 1; });
watch([active, debugEnabled], ([page, enabled]) => {
  if (page === "debug" && !loading.value && !enabled) void router.replace(pagePaths.settings);
});
watch(applicationPageCount, (count) => {
  if (applicationPage.value > count) applicationPage.value = count;
});
watch(
  () => [active.value, route.query.applicationId] as const,
  ([page, applicationId]) => {
    if (page === "progress" && typeof applicationId === "string" && detail.value?.application.id !== applicationId) {
      void openDetail(applicationId);
    }
  },
  { immediate: true },
);

function navigate(page: AppPage) {
  detail.value = null;
  void router.push(pagePaths[page]);
}

async function openNotification(item: NotificationSummary) {
  await action(async () => {
    if (!item.readAt) await api.readNotification(item.id);
    unreadNotificationCount.value = Math.max(0, unreadNotificationCount.value - (item.readAt ? 0 : 1));
    await refreshNotifications();
    await openDetail(item.applicationId);
  });
}

async function readAllNotifications() {
  await action(async () => {
    await api.readAllNotifications();
    unreadNotificationCount.value = 0;
    await refreshNotifications();
    flash("消息已全部标记为已读");
  });
}

async function clearAllNotifications() {
  if (!await askConfirm({
    title: "清空全部消息",
    message: "将删除全部消息通知，不受当前筛选和分页影响。岗位进度与状态时间线会继续保留，此操作无法恢复。",
    confirmLabel: "清空消息",
    danger: true,
  })) return;
  await action(async () => {
    const result = await api.deleteAllNotifications();
    detail.value = null;
    notificationCurrentPage.value = 1;
    unreadNotificationCount.value = 0;
    await refreshNotifications();
    flash(result.deleted ? `已清空 ${result.deleted} 条消息` : "没有可清空的消息");
  });
}

async function clearAllHistoryTasks() {
  if (!await askConfirm({
    title: "删除全部历史任务",
    message: "将删除全部成功、失败和已取消任务，不受当前搜索和分页影响，并清理相关截图与 AI 调试记录。进行中的任务、岗位进度、时间线和消息不会被删除。",
    confirmLabel: "删除历史任务",
    danger: true,
  })) return;
  await action(async () => {
    const result = await api.deleteAllHistoryRuns();
    taskHistoryPage.value = 1;
    screenshotRun.value = null;
    await Promise.all([refreshTasks(), refresh(true)]);
    const warning = result.screenshotsFailed ? `，${result.screenshotsFailed} 张截图清理失败` : "";
    flash(result.deleted ? `已删除 ${result.deleted} 条历史任务${warning}` : "没有可删除的历史任务");
  });
}

async function clearAiDebugTraces() {
  if (!await askConfirm({
    title: "清空 AI 调试记录",
    message: "将清空当前 API 进程内存中的全部 AI 输入输出记录，不会删除任务或截图。",
    confirmLabel: "清空调试记录",
    danger: true,
  })) return;
  await action(async () => {
    const result = await api.clearAiDebugTraces();
    debugRefreshToken.value += 1;
    flash(result.deleted ? `已清空 ${result.deleted} 条 AI 调试记录` : "没有可清空的调试记录");
  });
}

async function deleteParserRule(rule: AssistedParserRule) {
  if (!await askConfirm({
    title: "删除解析规则",
    message: `将删除“${rule.name}”。使用该规则的网站会回退到内置解析器或 AI，此操作无法恢复。`,
    confirmLabel: "删除规则",
    danger: true,
  })) return;
  await action(async () => {
    await api.deleteParserRule(rule.id);
    debugRefreshToken.value += 1;
    flash("解析规则已删除");
  });
}

function confirmRuleStudio(
  options: { title: string; message: string; confirmLabel: string; danger: boolean },
  done: (confirmed: boolean) => void,
) {
  void askConfirm(options).then(done);
}

function askConfirm(options: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  confirmState.title = options.title;
  confirmState.message = options.message;
  confirmState.confirmLabel = options.confirmLabel ?? "确认";
  confirmState.danger = options.danger ?? false;
  confirmState.open = true;
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function finishConfirm(value: boolean) {
  confirmState.open = false;
  confirmResolver?.(value);
  confirmResolver = undefined;
}

function flash(message: string) {
  notice.value = message;
  window.setTimeout(() => { notice.value = ""; }, 3500);
}
async function action(work: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  try { await work(); }
  catch (value) { error.value = value instanceof Error ? value.message : "操作失败"; }
  finally { busy.value = false; }
}
async function openDetail(id: string) {
  detailLoading.value = true;
  try { detail.value = await api.application(id); }
  finally { detailLoading.value = false; }
}
function toggle(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  selected.value = next;
}
function togglePage(ids: string[], checked: boolean) {
  const next = new Set(selected.value);
  for (const id of ids) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  selected.value = next;
}
function openCreateApplication() {
  formEditItem.value = null;
  formOpen.value = true;
}
function openApplicationEditor() {
  if (!detail.value) return;
  formEditItem.value = detail.value.application;
  formOpen.value = true;
}
function closeApplicationForm() {
  formOpen.value = false;
  formEditItem.value = null;
}
async function run(id: string) {
  await action(async () => {
    await api.run(id);
    flash("已加入检查队列");
    await refresh(true);
    if (detail.value?.application.id === id) detail.value = await api.application(id);
  });
}
async function bulkRun() {
  if (!selected.value.size && (query.value.trim() || statusFilter.value || scheduleFilter.value) && !filtered.value.length) {
    flash("当前筛选没有可检查的岗位");
    return;
  }
  await action(async () => {
    const hasActiveFilter = Boolean(query.value.trim() || statusFilter.value || scheduleFilter.value);
    const applicationIds = selected.value.size
      ? [...selected.value]
      : hasActiveFilter
        ? filtered.value.map((item) => item.id)
        : undefined;
    const result = await api.bulkRun(applicationIds);
    selected.value = new Set();
    flash(`已加入 ${result.queued.length} 个检查${result.skipped ? `，跳过 ${result.skipped} 个进行中岗位` : ""}`);
    await refresh(true);
  });
}
async function saveApplication(value: CreateApplication, runNow: boolean) {
  await action(async () => {
    if (formEditItem.value) {
      const id = formEditItem.value.id;
      const updated = await api.updateApplication(id, value);
      closeApplicationForm();
      applications.value = applications.value.map((item) => item.id === id ? updated : item);
      if (detail.value?.application.id === id) detail.value = await api.application(id);
      await refresh(true);
      flash("投递信息已更新");
      return;
    }
    const created = await api.createApplication(value);
    closeApplicationForm();
    if (runNow) await api.run(created.id);
    const joined = created.checkGroupMemberCount > 1 ? "，已加入现有检查组并共享检查计划" : "";
    flash(`${runNow ? "岗位已保存并加入检查队列" : "岗位已保存"}${joined}`);
    await refresh(true);
  });
}
async function setProgress(id: string, status: ProgressStatus) {
  await action(async () => {
    await api.setProgress(id, status);
    detail.value = await api.application(id);
    await refresh(true);
    flash(`已手动设置为“${progressLabels[status]}”`);
  });
}
async function saveNotes(id: string, notes: string, done: (ok: boolean) => void) {
  try {
    const updated = await api.updateApplication(id, { notes });
    applications.value = applications.value.map((item) => item.id === id ? updated : item);
    if (detail.value?.application.id === id) {
      detail.value = { ...detail.value, application: updated };
    }
    done(true);
  } catch (value) {
    error.value = value instanceof Error ? value.message : "备注保存失败";
    done(false);
  }
}
async function saveCheckPlan(value: CheckPlanUpdate) {
  if (!detail.value) return;
  await action(async () => {
    const result = await api.updateCheckPlan(detail.value!.application.id, value);
    checkPlanOpen.value = false;
    detail.value = await api.application(detail.value!.application.id);
    await refresh(true);
    flash(`检查计划已更新，并同步到 ${result.affected} 个岗位`);
  });
}
async function unlock(id: string) {
  await action(async () => {
    await api.unlockProgress(id);
    detail.value = await api.application(id);
    await refresh(true);
    flash("已恢复 AI 自动识别");
  });
}
async function resumeAutomation(id: string) {
  await action(async () => {
    await api.resumeAutomation(id);
    detail.value = await api.application(id);
    await refresh(true);
    flash("已恢复自动检查");
  });
}
function startLogin(runId: string) {
  loginRunId.value = runId;
  loginOpen.value = true;
}
async function refreshLogin(id: string) {
  await action(async () => {
    const result = await api.refreshLogin(id);
    if (detail.value?.application.id === id) detail.value = await api.application(id);
    await refresh(true);
    startLogin(result.runId);
  });
}
async function deleteApplication(id: string) {
  if (!await askConfirm({
    title: "删除岗位",
    message: "删除后，该岗位的运行记录和全部截图也会被删除。此操作无法恢复。",
    confirmLabel: "删除岗位",
    danger: true,
  })) return;
  await action(async () => {
    await api.deleteApplication(id);
    detail.value = null;
    await refresh(true);
    flash("岗位及其截图已删除");
  });
}
async function saveSettings() {
  if (settingsForm.screenshotRetentionDays < settings.value.screenshotRetentionDays
      && !await askConfirm({
        title: "缩短截图保留期限",
        message: "保存后会立即删除超过新期限的旧截图，但任务历史和识别结果仍会保留。",
        confirmLabel: "保存并清理",
        danger: true,
      })) return;
  await action(async () => {
    const result = await api.updateSettings({
      globalCron: settingsForm.globalCron.trim() || null,
      timezone: settingsForm.timezone,
      screenshotRetentionDays: Number(settingsForm.screenshotRetentionDays),
      defaultUserAgent: settingsForm.defaultUserAgent.trim(),
    });
    await refresh();
    const cleaned = result.screenshotCleanup.deleted + result.screenshotCleanup.missing;
    flash(cleaned ? `设置已保存，并清理了 ${cleaned} 张过期截图` : "设置已保存");
  });
}
async function refreshBrowserStorage() {
  try {
    browserStorage.value = await api.browserStorage();
  } catch (value) {
    error.value = value instanceof Error ? value.message : "无法读取浏览器存储占用";
  }
}
async function clearBrowserStorage(kind: "cache" | "temp") {
  const cache = kind === "cache";
  if (!await askConfirm({
    title: cache ? "清除浏览器缓存" : "清理临时文件",
    message: cache
      ? "将删除自动检查浏览器缓存的 JS、CSS、字体、图片等资源。登录状态不会被删除，后续检查可能需要重新下载页面资源。"
      : "将删除 data/tmp 中旧版或异常退出后遗留的临时文件。登录状态、岗位、任务和截图不会被删除。",
    confirmLabel: cache ? "清除缓存" : "清理临时文件",
    danger: true,
  })) return;
  await action(async () => {
    const result = await api.clearBrowserStorage(kind);
    await refreshBrowserStorage();
    const freed = result.freedBytes < 1024 ** 2
      ? `${Math.round(result.freedBytes / 1024)} KB`
      : `${(result.freedBytes / 1024 ** 2).toFixed(1)} MB`;
    flash(`${cache ? "浏览器缓存" : "临时文件"}已清理，释放 ${freed}${result.failed ? `，${result.failed} 项因占用未能删除` : ""}`);
  });
}
async function saveAiSettings(value: AiSettingsUpdate) {
  await action(async () => {
    await api.updateAiSettings(value);
    aiSettingsOpen.value = false;
    await refresh();
    flash("AI 配置已保存并同步到本地加密配置文件");
  });
}
async function saveRecognitionMode(value: RecognitionMode) {
  await action(async () => {
    await api.updateRecognitionMode(value);
    settings.value = { ...settings.value, recognitionMode: value };
    flash("识别模式已保存");
  });
}
async function saveStatusMappings(statusMappings: StatusMappings) {
  await action(async () => {
    const result = await api.updateStatusMappings(statusMappings);
    settings.value = { ...settings.value, statusMappings: result.statusMappings };
    statusMappingsOpen.value = false;
    flash("状态映射已保存，本地解析和 AI 识别会共同使用");
  });
}
function viewScreenshot(run: RunSummary, company: string, jobTitle: string) {
  screenshotRun.value = run;
  screenshotCompany.value = company;
  screenshotJobTitle.value = jobTitle;
}
async function deleteScreenshot(run: RunSummary) {
  if (!await askConfirm({
    title: run.groupMemberCount > 1 ? "删除共享截图" : "删除截图",
    message: run.groupMemberCount > 1
      ? `这张截图由同组 ${run.groupMemberCount} 个岗位共享，删除后所有岗位都无法再查看；任务记录和识别结果仍会保留。`
      : "只删除这张截图，任务记录和识别结果会继续保留。",
    confirmLabel: "删除截图",
    danger: true,
  })) return;
  await action(async () => {
    await api.deleteScreenshot(run.id);
    if (screenshotRun.value?.id === run.id) screenshotRun.value = null;
    if (detail.value) detail.value = await api.application(detail.value.application.id);
    if (active.value === "tasks") await refreshTasks();
    flash("截图已删除");
  });
}
async function cancelTask(run: TaskRunSummary) {
  if (!await askConfirm({
    title: "取消截图任务",
    message: `确认取消 ${run.company} · ${run.jobTitle} 的当前截图任务？`,
    confirmLabel: "取消任务",
    danger: true,
  })) return;
  await action(async () => {
    await api.cancelRun(run.id);
    await Promise.all([refreshTasks(), refresh(true)]);
    flash("任务已取消");
  });
}
async function retryTask(run: TaskRunSummary) {
  await action(async () => {
    await api.retryRun(run.id);
    taskScope.value = "active";
    await Promise.all([refreshTasks(), refresh(true)]);
    flash("任务已重新加入队列");
  });
}
async function deleteProfile(site: string) {
  if (!await askConfirm({
    title: "清除浏览器状态",
    message: `清除 ${site} 的登录状态后，下一次检查可能需要重新登录。`,
    confirmLabel: "清除状态",
    danger: true,
  })) return;
  await action(async () => {
    await api.deleteProfile(site);
    await refresh(true);
    flash("浏览器状态已清除");
  });
}
</script>

<template>
  <v-app>
    <div class="app-shell">
      <AppSidebar
        :active="active"
        :runner-healthy="settings.runnerHealthy"
        :unread-count="unreadNotificationCount"
        :debug-enabled="debugEnabled"
        @change="navigate"
      />
      <main class="main-area" :class="{ 'with-drawer': detail }">
        <header class="topbar">
          <div class="window-controls"><span></span><span></span><span></span></div>
          <div class="topbar-spacer"></div>
          <span class="local-mode"><i></i>本地模式</span>
        </header>
        <v-snackbar :model-value="Boolean(error)" color="error" location="top" :timeout="-1" @update:model-value="!$event && (error = '')">
          {{ error }}
          <template #actions><v-btn icon="mdi-close" variant="text" aria-label="关闭错误提示" @click="error = ''" /></template>
        </v-snackbar>
        <v-snackbar :model-value="Boolean(notice)" color="success" location="top" :timeout="3500" @update:model-value="!$event && (notice = '')">
          {{ notice }}
          <template #actions><v-btn icon="mdi-close" variant="text" aria-label="关闭提示" @click="notice = ''" /></template>
        </v-snackbar>

        <ProgressPage
          v-if="active === 'progress'"
          :applications="applications"
          :items="paginatedApplications"
          :selected="selected"
          :active-id="detail?.application.id ?? null"
          :detail="detail"
          :detail-loading="detailLoading"
          :query="query"
          :status-filter="statusFilter"
          :status-items="progressFilterItems"
          :schedule-filter="scheduleFilter"
          :schedule-items="scheduleFilterItems"
          :busy="busy"
          :page="applicationPage"
          :page-count="applicationPageCount"
          :total="filtered.length"
          :per-page="applicationsPerPage"
          @add="openCreateApplication"
          @query="query = $event"
          @status-filter="statusFilter = $event"
          @schedule-filter="scheduleFilter = $event"
          @page="applicationPage = $event"
          @toggle="toggle"
          @toggle-page="togglePage"
          @open="openDetail"
          @run="run"
          @bulk-run="bulkRun"
          @close-detail="detail = null"
          @progress="setProgress"
          @unlock="unlock"
          @resume-automation="resumeAutomation"
          @login="startLogin($event.id)"
          @refresh-login="refreshLogin"
          @view-screenshot="viewScreenshot($event, detail?.application.company || '', detail?.application.jobTitle || '')"
          @delete-screenshot="deleteScreenshot"
          @remove="deleteApplication"
          @save-notes="saveNotes"
          @edit-plan="checkPlanOpen = true"
          @edit-application="openApplicationEditor"
        />

        <NotificationsPage
          v-else-if="active === 'notifications'"
          :page="notificationPage"
          :scope="notificationScope"
          :busy="busy"
          :detail="detail"
          :detail-loading="detailLoading"
          :current-page="notificationCurrentPage"
          :page-count="notificationPageCount"
          :per-page="notificationsPerPage"
          @scope="notificationScope = $event"
          @page="notificationCurrentPage = $event"
          @open="openNotification"
          @read-all="readAllNotifications"
          @clear-all="clearAllNotifications"
          @close-detail="detail = null"
          @run="run"
          @progress="setProgress"
          @unlock="unlock"
          @resume-automation="resumeAutomation"
          @login="startLogin($event.id)"
          @refresh-login="refreshLogin"
          @view-screenshot="viewScreenshot($event, detail?.application.company || '', detail?.application.jobTitle || '')"
          @delete-screenshot="deleteScreenshot"
          @remove="deleteApplication"
          @save-notes="saveNotes"
          @edit-plan="checkPlanOpen = true"
          @edit-application="openApplicationEditor"
        />

        <TaskManager
          v-else-if="active === 'tasks'"
          :scope="taskScope"
          :page="taskPage"
          :query="taskQuery"
          :busy="busy"
          :current-page="taskHistoryPage"
          :page-count="taskHistoryPageCount"
          @scope="taskScope = $event"
          @query="taskQuery = $event"
          @refresh="refreshTasks()"
          @page="taskHistoryPage = $event"
          @cancel="cancelTask"
          @retry="retryTask"
          @login="startLogin($event.id)"
          @view="viewScreenshot($event, $event.company, $event.jobTitle)"
          @delete-screenshot="deleteScreenshot"
          @clear-history="clearAllHistoryTasks"
        />

        <BrowserProfilesPage v-else-if="active === 'profiles'" :profiles="profiles" @remove="deleteProfile" />
        <SettingsPage
          v-else-if="active === 'settings'"
          :settings="settings"
          :form="settingsForm"
          :storage="browserStorage"
          :busy="busy"
          @save="saveSettings"
          @refresh-storage="refreshBrowserStorage"
          @clear-storage="clearBrowserStorage"
          @configure-ai="aiSettingsOpen = true"
          @configure-status-mappings="statusMappingsOpen = true"
          @recognition-mode="saveRecognitionMode"
        />
        <AiDebugPage
          v-else-if="active === 'debug' && debugEnabled"
          :busy="busy"
          :refresh-token="debugRefreshToken"
          @clear="clearAiDebugTraces"
          @failure="error = $event"
          @notice="flash"
        />
        <RuleStudioPage
          v-else-if="active === 'rule_studio'"
          :busy="busy"
          :key="debugRefreshToken"
          @delete="deleteParserRule"
          @confirm="confirmRuleStudio"
          @failure="error = $event"
          @notice="flash"
        />
        <RouterView class="route-marker" />
      </main>

    </div>
    <ApplicationForm :open="formOpen" :edit-item="formEditItem" @close="closeApplicationForm" @save="saveApplication" />
    <LoginDialog :open="loginOpen" :run-id="loginRunId" @close="loginOpen = false" @completed="refresh(true)" />
    <ScreenshotViewer
      :open="Boolean(screenshotRun)"
      :run="screenshotRun"
      :company="screenshotCompany"
      :job-title="screenshotJobTitle"
      @close="screenshotRun = null"
    />
    <ConfirmDialog
      :open="confirmState.open"
      :title="confirmState.title"
      :message="confirmState.message"
      :confirm-label="confirmState.confirmLabel"
      :danger="confirmState.danger"
      :busy="busy"
      @confirm="finishConfirm(true)"
      @cancel="finishConfirm(false)"
    />
    <AiSettingsDialog
      :open="aiSettingsOpen"
      :settings="settings"
      :busy="busy"
      @close="aiSettingsOpen = false"
      @save="saveAiSettings"
    />
    <StatusMappingsDialog
      :open="statusMappingsOpen"
      :mappings="settings.statusMappings"
      :builtin-mappings="settings.builtinStatusMappings"
      :busy="busy"
      @close="statusMappingsOpen = false"
      @save="saveStatusMappings"
    />
    <CheckPlanDialog
      :open="checkPlanOpen"
      :group="detail?.checkGroup ?? null"
      :settings="settings"
      :saving="busy"
      @close="checkPlanOpen = false"
      @save="saveCheckPlan"
    />
  </v-app>
</template>

<style scoped>
.app-shell { min-height: 100vh; display: flex; background: radial-gradient(circle at 85% 0, #efe5ce 0, transparent 27%), var(--ivory); }
.main-area { margin-left: 202px; width: calc(100% - 202px); min-height: 100vh; }
.topbar { height: 51px; padding: 0 20px; border-bottom: 1px solid #ded8ca; background: #fffdf9d9; backdrop-filter: blur(12px); display: flex; align-items: center; position: sticky; top: 0; z-index: 10; }
.window-controls { display: flex; gap: 7px; }
.window-controls span { width: 10px; height: 10px; border-radius: 50%; background: #df6354; }
.window-controls span:nth-child(2) { background: #dfa832; }
.window-controls span:nth-child(3) { background: #49a86d; }
.topbar-spacer { flex: 1; }
.local-mode { font-size: 12px; color: #51615b; display: flex; gap: 8px; align-items: center; }
.local-mode i { width: 7px; height: 7px; border-radius: 50%; background: #34a261; box-shadow: 0 0 0 4px #34a26114; }
</style>
