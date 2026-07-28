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

export async function registerNotificationSettingsController(
  app: FastifyInstance,
  deps: RouteDeps,

): Promise<void> {
  const { context, config, recognizer: injectedRecognizer, runnerHeartbeat } = deps;

  app.get("/notifications", async (request) => {
    const query = request.query as { scope?: string; limit?: string; offset?: string };
    const unreadOnly = query.scope === "unread";
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = Math.max(0, Number(query.offset) || 0);
    let rowsQuery = context.db.selectFrom("notifications").selectAll().orderBy("created_at", "desc").limit(limit).offset(offset);
    let totalQuery = context.db.selectFrom("notifications").select(({ fn }) => fn.countAll<number>().as("count"));
    if (unreadOnly) {
      rowsQuery = rowsQuery.where("read_at", "is", null);
      totalQuery = totalQuery.where("read_at", "is", null);
    }
    const [rows, total, unread] = await Promise.all([
      rowsQuery.execute(),
      totalQuery.executeTakeFirstOrThrow(),
      context.db.selectFrom("notifications").select(({ fn }) => fn.countAll<number>().as("count"))
        .where("read_at", "is", null).executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        applicationId: row.application_id,
        runId: row.run_id,
        statusEventId: row.status_event_id,
        company: row.company_snapshot,
        jobTitle: row.job_title_snapshot,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        confidence: row.confidence,
        evidence: row.evidence,
        readAt: row.read_at,
        createdAt: row.created_at,
      })),
      total: Number(total.count),
      unreadCount: Number(unread.count),
      limit,
      offset,
    };
  });

  app.get("/notifications/unread-count", async () => {
    const row = await context.db.selectFrom("notifications").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("read_at", "is", null).executeTakeFirstOrThrow();
    return { unreadCount: Number(row.count) };
  });

  app.post("/notifications/:id/read", async (request) => {
    const id = (request.params as { id: string }).id;
    const exists = await context.db.selectFrom("notifications").select("id").where("id", "=", id).executeTakeFirst();
    if (!exists) throw httpError(404, "消息不存在");
    await context.db.updateTable("notifications").set({ read_at: nowIso() })
      .where("id", "=", id).where("read_at", "is", null).execute();
    return { ok: true };
  });

  app.post("/notifications/read-all", async () => {
    await context.db.updateTable("notifications").set({ read_at: nowIso() }).where("read_at", "is", null).execute();
    return { ok: true };
  });

  app.post("/notifications/delete-all", async () => {
    const result = await context.db.deleteFrom("notifications").executeTakeFirst();
    return { deleted: Number(result.numDeletedRows) };
  });

  app.get("/browser-profiles", async () =>
    (await context.db.selectFrom("browser_profiles").selectAll().orderBy("updated_at", "desc").execute()).map(mapProfile));

  app.post("/browser-profiles/:site/delete", async (request, reply) => {
    const site = decodeURIComponent((request.params as { site: string }).site);
    await context.db.deleteFrom("browser_profiles").where("site", "=", site).execute();
    return reply.code(204).send();
  });

  app.get("/settings", async () => {
    const settings = await appSettings(context);
    const activeRecognizer = injectedRecognizer ?? recognizerFromSettings(settings, config);
    return {
      globalCron: settings.global_cron,
      timezone: settings.timezone,
      screenshotRetentionDays: settings.screenshot_retention_days,
      defaultUserAgent: settings.default_user_agent,
      aiConfigured: activeRecognizer.configured,
      aiBaseUrl: settings.ai_base_url,
      aiModel: activeRecognizer.model,
      aiApiKeySet: Boolean(settings.ai_api_key_encrypted) || Boolean(injectedRecognizer?.configured),
      aiConfidenceThreshold: settings.ai_confidence_threshold,
      aiDeepThinking: Boolean(settings.ai_deep_thinking),
      runnerHealthy: Date.now() - runnerHeartbeat.at < 20_000,
      loginPresentation: config.desktopMode ? "external-window" : "vnc",
    };
  });

  app.post("/settings/update", { schema: { body: SettingsUpdateSchema } }, async (request) => {
    const body = request.body as typeof SettingsUpdateSchema.static;
    const { validateCron } = await import("../cron.js");
    try {
      validateCron(body.globalCron || "0 0 * * *", body.timezone);
    } catch {
      throw httpError(400, "Cron 表达式或时区无效");
    }
    await context.db.updateTable("app_settings").set({
      global_cron: body.globalCron,
      timezone: body.timezone,
      screenshot_retention_days: body.screenshotRetentionDays,
      default_user_agent: body.defaultUserAgent.trim(),
      updated_at: nowIso(),
    }).where("id", "=", 1).execute();
    await recomputeInheritedSchedules(context);
    const screenshotCleanup = await cleanupExpiredScreenshots(context, config, body.screenshotRetentionDays);
    await syncRuntimeSettingsFile(await appSettings(context), config);
    return { ok: true, screenshotCleanup };
  });

  app.post("/settings/ai/update", { schema: { body: AiSettingsUpdateSchema } }, async (request) => {
    const body = request.body as typeof AiSettingsUpdateSchema.static;
    if ((body.baseUrl || body.model || body.apiKey) && !(body.baseUrl && body.model && (body.apiKey || (await appSettings(context)).ai_api_key_encrypted))) {
      throw httpError(400, "启用 AI 识别需要同时填写模型地址、模型名称和 API Key");
    }
    const settings = await updateAiSettings(context, config, body);
    const activeRecognizer = recognizerFromSettings(settings, config);
    return {
      ok: true,
      aiConfigured: activeRecognizer.configured,
      aiModel: activeRecognizer.model,
      aiApiKeySet: Boolean(settings.ai_api_key_encrypted),
      aiDeepThinking: Boolean(settings.ai_deep_thinking),
    };
  });
}
