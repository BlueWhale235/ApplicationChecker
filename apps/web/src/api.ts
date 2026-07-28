import type {
  AiDebugTraceDetail,
  AiDebugTraceSummary,
  AssistedParserRule,
  AssistedParserRuleDefinition,
  AssistedRuleSelection,
  AssistedRuleTestResult,
  AppSettings,
  AiSettingsUpdate,
  ApplicationDetail,
  ApplicationSummary,
  BrowserProfileSummary,
  BrowserStorageCleanupResult,
  BrowserStorageUsage,
  CheckGroupSummary,
  CheckPlanUpdate,
  CreateApplication,
  LoginSessionSummary,
  NotificationPage,
  ProgressStatus,
  RecognitionMode,
  RecognitionPreviewDetail,
  RecognitionPreviewSnapshot,
  RuleStudioCheckGroupOption,
  SettingsUpdate,
  StatusMappings,
  TaskRunPage,
  UpdateApplication,
} from "@application-checker/contracts";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `请求失败：${response.status}` })) as { error?: string };
    throw new Error(body.error ?? `请求失败：${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  applications: (q = "", status = "") =>
    request<ApplicationSummary[]>(`/applications?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`),
  application: (id: string) => request<ApplicationDetail>(`/applications/${id}`),
  createApplication: (body: CreateApplication) => request<ApplicationSummary>("/applications", { method: "POST", body: JSON.stringify(body) }),
  updateApplication: (id: string, body: UpdateApplication) => request<ApplicationSummary>(`/applications/${id}/update`, { method: "POST", body: JSON.stringify(body) }),
  updateCheckPlan: (id: string, body: CheckPlanUpdate) => request<{ checkGroup: CheckGroupSummary; affected: number }>(
    `/applications/${id}/check-plan/update`, { method: "POST", body: JSON.stringify(body) },
  ),
  deleteApplication: (id: string) => request<void>(`/applications/${id}/delete`, { method: "POST" }),
  run: (id: string) => request<{ runId: string }>(`/applications/${id}/runs`, { method: "POST" }),
  refreshLogin: (id: string) => request<{ runId: string }>(`/applications/${id}/login`, { method: "POST" }),
  bulkRun: (applicationIds?: string[]) => request<{ queued: string[]; skipped: number }>("/runs/bulk", {
    method: "POST", body: JSON.stringify(applicationIds ? { applicationIds } : {}),
  }),
  setProgress: (id: string, status: ProgressStatus, note?: string) => request<{ ok: true }>(`/applications/${id}/progress`, {
    method: "POST", body: JSON.stringify({ status, ...(note ? { note } : {}) }),
  }),
  unlockProgress: (id: string) => request<{ ok: true }>(`/applications/${id}/progress/unlock`, { method: "POST" }),
  resumeAutomation: (id: string) => request<{ ok: true; nextRunAt: string | null }>(`/applications/${id}/automation/resume`, { method: "POST" }),
  notifications: (scope: "all" | "unread", limit = 20, offset = 0) =>
    request<NotificationPage>(`/notifications?scope=${scope}&limit=${limit}&offset=${offset}`),
  unreadNotifications: () => request<{ unreadCount: number }>("/notifications/unread-count"),
  readNotification: (id: string) => request<{ ok: true }>(`/notifications/${id}/read`, { method: "POST" }),
  readAllNotifications: () => request<{ ok: true }>("/notifications/read-all", { method: "POST" }),
  deleteAllNotifications: () => request<{ deleted: number }>("/notifications/delete-all", { method: "POST" }),
  screenshotUrl: (runId: string) => `/api/runs/${runId}/screenshot`,
  deleteScreenshot: (runId: string) => request<void>(`/runs/${runId}/screenshot/delete`, { method: "POST" }),
  tasks: (scope: "active" | "history", options: { status?: string; q?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams({ scope });
    if (options.status) params.set("status", options.status);
    if (options.q) params.set("q", options.q);
    params.set("limit", String(options.limit ?? 50));
    params.set("offset", String(options.offset ?? 0));
    return request<TaskRunPage>(`/runs?${params.toString()}`);
  },
  cancelRun: (runId: string) => request<{ ok: true }>(`/runs/${runId}/cancel`, { method: "POST" }),
  retryRun: (runId: string) => request<{ runId: string }>(`/runs/${runId}/retry`, { method: "POST" }),
  deleteAllHistoryRuns: () => request<{
    deleted: number;
    screenshotsDeleted: number;
    screenshotsMissing: number;
    screenshotsFailed: number;
  }>("/runs/history/delete-all", { method: "POST" }),
  debugStatus: () => request<{ enabled: boolean }>("/debug/status"),
  aiDebugTraces: (limit = 50) => request<AiDebugTraceSummary[]>(`/debug/recognition-traces?limit=${limit}`),
  aiDebugTrace: (id: string) => request<AiDebugTraceDetail>(`/debug/recognition-traces/${id}`),
  clearAiDebugTraces: () => request<{ deleted: number }>("/debug/recognition-traces/clear", { method: "POST" }),
  recognitionPreviews: () => request<RecognitionPreviewDetail[]>("/recognition-previews"),
  createRecognitionPreview: (applicationId: string) => request<RecognitionPreviewDetail>("/recognition-previews", {
    method: "POST", body: JSON.stringify({ applicationId }),
  }),
  recognitionPreview: (id: string) => request<RecognitionPreviewDetail>(`/recognition-previews/${id}`),
  recognitionPreviewSnapshot: (id: string) => request<RecognitionPreviewSnapshot>(`/recognition-previews/${id}/snapshot`),
  recognitionPreviewScreenshotUrl: (id: string) => `/api/recognition-previews/${id}/screenshot`,
  parserRules: () => request<AssistedParserRule[]>("/parser-rules"),
  parserRuleCheckGroups: (q = "", limit = 30) =>
    request<RuleStudioCheckGroupOption[]>(`/parser-rules/check-groups?q=${encodeURIComponent(q)}&limit=${limit}`),
  generateParserRule: (previewId: string, selection: AssistedRuleSelection) =>
    request<{ definition: AssistedParserRuleDefinition; errors: string[] }>("/parser-rules/generate", {
      method: "POST", body: JSON.stringify({ previewId, selection }),
    }),
  testParserRule: (previewId: string, rule: AssistedParserRule) =>
    request<AssistedRuleTestResult>("/parser-rules/test", {
      method: "POST", body: JSON.stringify({ previewId, rule }),
    }),
  createParserRule: (body: {
    name: string; enabled: boolean; priority: number; definition: AssistedParserRuleDefinition; tested?: boolean;
  }) => request<AssistedParserRule>("/parser-rules", { method: "POST", body: JSON.stringify(body) }),
  updateParserRule: (id: string, body: {
    name: string; enabled: boolean; priority: number; definition: AssistedParserRuleDefinition; tested?: boolean;
  }) => request<AssistedParserRule>(`/parser-rules/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteParserRule: (id: string) => request<{ deleted: number }>(`/parser-rules/${id}/delete`, { method: "POST" }),
  exportParserRules: () => request<{ schemaVersion: 1; exportedAt: string; rules: AssistedParserRule[] }>("/parser-rules/export"),
  exportParserRule: (id: string) =>
    request<{ schemaVersion: 1; exportedAt: string; rules: AssistedParserRule[] }>(`/parser-rules/${id}/export`),
  importParserRules: (body: { schemaVersion: number; rules: AssistedParserRule[]; confirm: boolean }) =>
    request<{ added: number; skipped: number; conflicts: string[] }>("/parser-rules/import", {
      method: "POST", body: JSON.stringify(body),
    }),
  profiles: () => request<BrowserProfileSummary[]>("/browser-profiles"),
  deleteProfile: (site: string) => request<void>(`/browser-profiles/${encodeURIComponent(site)}/delete`, { method: "POST" }),
  settings: () => request<AppSettings>("/settings"),
  browserStorage: () => request<BrowserStorageUsage>("/settings/browser-storage"),
  clearBrowserStorage: (kind: "cache" | "temp") =>
    request<BrowserStorageCleanupResult>(`/settings/browser-storage/${kind}/clear`, { method: "POST" }),
  updateSettings: (body: SettingsUpdate) => request<{
    ok: true;
    screenshotCleanup: { deleted: number; missing: number; failed: number };
  }>("/settings/update", { method: "POST", body: JSON.stringify(body) }),
  updateAiSettings: (body: AiSettingsUpdate) => request<{
    ok: true;
    aiConfigured: boolean;
    aiModel: string | null;
    aiApiKeySet: boolean;
    aiDeepThinking: boolean;
  }>("/settings/ai/update", { method: "POST", body: JSON.stringify(body) }),
  updateRecognitionMode: (recognitionMode: RecognitionMode) => request<{ ok: true; recognitionMode: RecognitionMode }>(
    "/settings/recognition/update",
    { method: "POST", body: JSON.stringify({ recognitionMode }) },
  ),
  updateStatusMappings: (statusMappings: StatusMappings) => request<{ ok: true; statusMappings: StatusMappings }>(
    "/settings/status-mappings/update",
    { method: "POST", body: JSON.stringify({ statusMappings }) },
  ),
  createLogin: (runId: string) => request<{ session: LoginSessionSummary; accessUrl: string | null }>("/login-sessions", {
    method: "POST", body: JSON.stringify({ runId }),
  }),
  login: (id: string) => request<LoginSessionSummary>(`/login-sessions/${id}`),
  completeLogin: (id: string) => request<{ ok: true }>(`/login-sessions/${id}/complete`, { method: "POST" }),
  extendLogin: (id: string) => request<{ expiresAt: string }>(`/login-sessions/${id}/extend`, { method: "POST" }),
  cancelLogin: (id: string) => request<void>(`/login-sessions/${id}/cancel`, { method: "POST" }),
};
