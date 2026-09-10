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
  NextLoginSummary,
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
import { checkBackupPasswordLocally } from "./backup-header";

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

export interface DataTransferSummary {
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  sourceKeyId: string;
  targetKeyId: string;
  keyChanged: boolean;
  counts: Record<string, number>;
  targetCounts: Record<string, number>;
  screenshotCount: number;
  screenshotBytes: number;
  sensitiveData: string[];
  targetHasData: boolean;
}

export interface DataBackupUploadProgress {
  percent: number;
  message: string;
}

async function transferError(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({ error: `请求失败：${response.status}` })) as { error?: string };
  throw new Error(body.error ?? `请求失败：${response.status}`);
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
  createRecognitionPreview: (applicationId: string, keepAlive = false) => request<RecognitionPreviewDetail>("/recognition-previews", {
    method: "POST", body: JSON.stringify({ applicationId, keepAlive }),
  }),
  recognitionPreview: (id: string) => request<RecognitionPreviewDetail>(`/recognition-previews/${id}`),
  releaseRecognitionPreview: (id: string) => request<{ ok: true }>(`/recognition-previews/${id}/release`, { method: "POST" }),
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
  testScriptParserRule: (previewId: string, rule: AssistedParserRule) =>
    request<RecognitionPreviewDetail>("/parser-rules/test-script", {
      method: "POST", body: JSON.stringify({ previewId, rule }),
    }),
  createParserRule: (body: {
    name: string; enabled: boolean; priority: number; definition: AssistedParserRuleDefinition; tested?: boolean;
  }) => request<AssistedParserRule>("/parser-rules", { method: "POST", body: JSON.stringify(body) }),
  updateParserRule: (id: string, body: {
    name: string; enabled: boolean; priority: number; definition: AssistedParserRuleDefinition; tested?: boolean;
  }) => request<AssistedParserRule>(`/parser-rules/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteParserRule: (id: string) => request<{ deleted: number }>(`/parser-rules/${id}/delete`, { method: "POST" }),
  exportParserRules: () => request<{ schemaVersion: 2; exportedAt: string; rules: AssistedParserRule[] }>("/parser-rules/export"),
  exportParserRule: (id: string) =>
    request<{ schemaVersion: 2; exportedAt: string; rules: AssistedParserRule[] }>(`/parser-rules/${id}/export`),
  importParserRules: (body: { schemaVersion: number; rules: AssistedParserRule[]; confirm: boolean }) =>
    request<{ added: number; skipped: number; conflicts: string[] }>("/parser-rules/import", {
      method: "POST", body: JSON.stringify(body),
    }),
  profiles: () => request<BrowserProfileSummary[]>("/browser-profiles"),
  deleteProfile: (site: string) => request<void>(`/browser-profiles/${encodeURIComponent(site)}/delete`, { method: "POST" }),
  settings: () => request<AppSettings>("/settings"),
  browserStorage: () => request<BrowserStorageUsage>("/settings/browser-storage"),
  clearBrowserStorage: (kind: "cache" | "temp" | "logs") =>
    request<BrowserStorageCleanupResult>(`/settings/browser-storage/${kind}/clear`, { method: "POST" }),
  exportAllData: async (password: string, passwordConfirmation: string) => {
    const response = await fetch("/api/data-transfer/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, passwordConfirmation }),
    });
    if (!response.ok) return transferError(response);
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "application-checker.acbackup";
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
  inspectDataBackup: async (
    file: File,
    password: string,
    onProgress?: (progress: DataBackupUploadProgress) => void,
  ) => {
    let uploadId: string | null = null;
    try {
      onProgress?.({ percent: 0, message: "正在检查文件格式和迁移密码…" });
      const localCheck = await checkBackupPasswordLocally(file, password, (progress) => {
        onProgress?.({ percent: 0, message: `正在本地检查迁移密码… ${Math.round(progress * 100)}%` });
      });
      const preflightResponse = await fetch("/api/data-transfer/imports/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          headerBase64: localCheck.headerBase64,
        }),
      });
      if (!preflightResponse.ok) await transferError(preflightResponse);
      const preflight = await preflightResponse.json() as {
        id: string;
        chunkSize: number;
        formatVersion: number;
      };
      if (preflight.formatVersion !== localCheck.formatVersion) throw new Error("服务端识别的备份版本与本地不一致");
      uploadId = preflight.id;
      onProgress?.({
        percent: 0,
        message: "本地密码检查通过，正在分片上传…",
      });
      let chunkIndex = 0;
      for (let offset = 0; offset < file.size; offset += preflight.chunkSize) {
        const end = Math.min(offset + preflight.chunkSize, file.size);
        const chunkResponse = await fetch(
          `/api/data-transfer/imports/${encodeURIComponent(preflight.id)}/chunks/${chunkIndex}?offset=${offset}`,
          {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: file.slice(offset, end),
          },
        );
        if (!chunkResponse.ok) await transferError(chunkResponse);
        onProgress?.({ percent: Math.round((end / file.size) * 100), message: `正在上传备份… ${Math.round((end / file.size) * 100)}%` });
        chunkIndex += 1;
      }
      onProgress?.({ percent: 100, message: "上传完成，正在解密并校验完整性…" });
      const completeResponse = await fetch(`/api/data-transfer/imports/${encodeURIComponent(preflight.id)}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!completeResponse.ok) await transferError(completeResponse);
      uploadId = null;
      return completeResponse.json() as Promise<{ id: string; summary: DataTransferSummary; expiresAt: string }>;
    } catch (error) {
      if (uploadId) await fetch(`/api/data-transfer/imports/${encodeURIComponent(uploadId)}`, { method: "DELETE" }).catch(() => {});
      throw error;
    }
  },
  applyDataBackup: (id: string) => request<{ ok: true; summary: DataTransferSummary; resumedQueued: number }>(
    `/data-transfer/imports/${id}/apply`, { method: "POST", body: JSON.stringify({ confirmReplace: true }) },
  ),
  cancelDataBackup: (id: string) => request<void>(`/data-transfer/imports/${id}`, { method: "DELETE" }),
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
  createLogin: (runId: string) => request<{ session: LoginSessionSummary; accessUrl: string | null; replacedExisting: boolean }>("/login-sessions", {
    method: "POST", body: JSON.stringify({ runId }),
  }),
  login: (id: string) => request<LoginSessionSummary>(`/login-sessions/${id}`),
  nextLogin: (excludeRunId: string) => request<NextLoginSummary | null>(
    `/login-sessions/next-needed?excludeRunId=${encodeURIComponent(excludeRunId)}`,
  ),
  completeLogin: (id: string) => request<{ ok: true }>(`/login-sessions/${id}/complete`, { method: "POST" }),
  extendLogin: (id: string) => request<{ expiresAt: string }>(`/login-sessions/${id}/extend`, { method: "POST" }),
  cancelLogin: (id: string) => request<void>(`/login-sessions/${id}/cancel`, { method: "POST" }),
};
