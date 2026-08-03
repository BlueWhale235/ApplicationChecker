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
  const { context, config, aiDebugStore, recognitionPreviewStore, runnerHeartbeat } = deps;
  const previewStore = () => {
    if (!recognitionPreviewStore) throw httpError(503, "规则预览服务未启用");
    return recognitionPreviewStore;
  };

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

  app.get("/debug/recognition-traces", async (request) => {
    if (!config.debugTools || !aiDebugStore) throw httpError(404, "识别调试功能未启用");
    const limit = Math.min(50, Math.max(1, Number((request.query as { limit?: string }).limit) || 50));
    return aiDebugStore.list(limit);
  });

  app.get("/debug/ai-traces/:id", async (request) => {
    if (!config.debugTools || !aiDebugStore) throw httpError(404, "AI 调试功能未启用");
    const trace = aiDebugStore.get((request.params as { id: string }).id);
    if (!trace) throw httpError(404, "AI 调试记录不存在或已被清理");
    return trace;
  });

  app.get("/debug/recognition-traces/:id", async (request) => {
    if (!config.debugTools || !aiDebugStore) throw httpError(404, "识别调试功能未启用");
    const trace = aiDebugStore.get((request.params as { id: string }).id);
    if (!trace) throw httpError(404, "识别调试记录不存在或已被清理");
    return trace;
  });

  app.post("/debug/ai-traces/clear", async () => {
    if (!config.debugTools || !aiDebugStore) throw httpError(404, "AI 调试功能未启用");
    return { deleted: aiDebugStore.clear() };
  });

  app.post("/debug/recognition-traces/clear", async () => {
    if (!config.debugTools || !aiDebugStore) throw httpError(404, "识别调试功能未启用");
    return { deleted: aiDebugStore.clear() };
  });

  app.post("/recognition-previews", async (request) => {
    const store = previewStore();
    const applicationId = (request.body as { applicationId?: string }).applicationId;
    if (!applicationId) throw httpError(400, "applicationId is required");
    const application = await context.db.selectFrom("applications")
      .leftJoin("check_groups", "check_groups.id", "applications.check_group_id")
      .select([
        "applications.id", "applications.check_group_id", "applications.company", "applications.site",
        "applications.check_url", "applications.resolved_url",
        "check_groups.check_url as group_check_url", "check_groups.resolved_url as group_resolved_url",
        "check_groups.company as group_company",
      ])
      .where("applications.id", "=", applicationId).executeTakeFirst();
    if (!application) throw httpError(404, "岗位不存在");
    const url = application.group_resolved_url ?? application.resolved_url
      ?? application.group_check_url ?? application.check_url;
    if (!url) throw httpError(400, "岗位未设置检查链接");
    const groupId = application.check_group_id ?? application.id;
    const members = await context.db.selectFrom("applications")
      .select([
        "id", "company", "job_title", "check_url", "posting_url", "applied_at", "location", "notes",
        "site", "progress_status_v2",
      ])
      .where("check_group_id", "=", groupId).orderBy("created_at").execute();
    const settings = await appSettings(context);
    return store.enqueue({
      groupId,
      applicationId,
      url,
      company: application.group_company ?? application.company,
      applications: members.map((member) => ({
        id: member.id, company: member.company, jobTitle: member.job_title,
        checkUrl: member.check_url || null, postingUrl: member.posting_url,
        appliedAt: member.applied_at, location: member.location, notes: member.notes,
        site: member.site, progressStatus: member.progress_status_v2 ?? "unset",
      })),
      site: application.site,
      browserState: await loadBrowserState(context, config, application.site),
      proxyUrl: config.upstreamProxyUrl,
      userAgent: settings.default_user_agent,
    });
  });

  app.get("/recognition-previews", async () => {
    return previewStore().list();
  });

  app.get("/recognition-previews/:id", async (request) => {
    const preview = previewStore().get((request.params as { id: string }).id);
    if (!preview) throw httpError(404, "识别预览不存在");
    return preview;
  });

  app.get("/recognition-previews/:id/screenshot", async (request, reply) => {
    const image = previewStore().screenshot((request.params as { id: string }).id);
    if (!image) throw httpError(404, "预览截图不存在");
    return reply.header("content-type", "image/png").send(image);
  });

  app.get("/recognition-previews/:id/snapshot", async (request) => {
    const snapshot = previewStore().snapshot((request.params as { id: string }).id);
    if (!snapshot) throw httpError(404, "预览快照不存在");
    return snapshot;
  });
}
