import {
  AiSettingsUpdateSchema,
  BulkRunSchema,
  CheckPlanUpdateSchema,
  CreateApplicationSchema,
  SetProgressSchema,
  SettingsUpdateSchema,
  UpdateApplicationSchema,
  activeRunStatuses,
  apiPath,
  appSettings,
  applicationRows,
  assertPublicUrl,
  calculateNextRun,
  cancelActiveRuns,
  cleanupExpiredScreenshots,
  clearGroupScheduleIfFullyPaused,
  createReadStream,
  findOrCreateCheckGroup,
  httpError,
  isActiveRunConstraint,
  isInside,
  legacyStatus,
  loadBrowserState,
  mapApplication,
  mapEvent,
  mapLogin,
  mapProfile,
  mapRun,
  nowIso,
  path,
  persistScreenshot,
  queueRun,
  randomBytes,
  randomUUID,
  recognitionResults,
  recognizerFromSettings,
  recomputeInheritedSchedules,
  rm,
  runnerAuthorized,
  saveBrowserState,
  sha,
  siteForUrl,
  stat,
  syncAppliedEvent,
  syncRuntimeSettingsFile,
  updateAiSettings,
} from "./shared.js";
import type {
  BrowserStateEnvelope,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  ProgressStatus,
  RouteDeps,
  RunnerJob,
  RunnerLoginJob,
  RunsTable,
} from "./shared.js";

export async function registerCoreController(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, aiDebugStore, runnerHeartbeat } = deps;

  app.addHook("preHandler", async (request) => {

    const pathname = apiPath(request);
    if (!config.desktopMode || pathname === "/health" || pathname.startsWith("/internal/")) return;
    if (request.cookies.ac_desktop !== config.desktopSessionToken) {
      throw httpError(401, "Desktop session authorization failed");
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    runner: Date.now() - runnerHeartbeat.at < 20_000 ? "healthy" : "unavailable",
  }));

  app.get("/debug/status", async () => ({ enabled: Boolean(config.debugTools && aiDebugStore) }));

  app.get("/debug/ai-traces", async (request) => {
    if (!config.debugTools || !aiDebugStore) throw httpError(404, "AI 调试功能未启用");
    const limit = Math.min(50, Math.max(1, Number((request.query as { limit?: string }).limit) || 50));
    return aiDebugStore.list(limit);
  });

  app.get("/debug/ai-traces/:id", async (request) => {
    if (!config.debugTools || !aiDebugStore) throw httpError(404, "AI 调试功能未启用");
    const trace = aiDebugStore.get((request.params as { id: string }).id);
    if (!trace) throw httpError(404, "AI 调试记录不存在或已被清理");
    return trace;
  });

  app.post("/debug/ai-traces/clear", async () => {
    if (!config.debugTools || !aiDebugStore) throw httpError(404, "AI 调试功能未启用");
    return { deleted: aiDebugStore.clear() };
  });
}
