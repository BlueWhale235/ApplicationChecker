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

export async function registerLoginController(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { context, config } = deps;

  app.post("/login-sessions", async (request, reply) => {
    const { runId } = request.body as { runId: string };
    const run = await context.db.selectFrom("runs").innerJoin("applications", "applications.id", "runs.application_id")
      .select(["runs.id", "runs.application_id", "runs.status"])
      .where("runs.id", "=", runId).executeTakeFirst();
    if (!run) throw httpError(404, "运行记录不存在");
    if (run.status !== "needs_login") throw httpError(409, "该运行当前不需要登录");
    const active = await context.db.selectFrom("login_sessions").select("id")
      .where("status", "in", ["queued", "starting", "ready", "active", "saving"]).executeTakeFirst();
    if (active) throw httpError(409, "已有登录窗口正在使用");
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    await context.db.insertInto("login_sessions").values({
      id,
      application_id: run.application_id,
      run_id: run.id,
      status: "queued",
      access_token_hash: sha(token),
      token_used_at: null,
      expires_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
      error_message: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),

      completed_at: null,
    }).execute();
    const row = await context.db.selectFrom("login_sessions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    return reply.code(201).send({
      session: mapLogin(row),
      accessUrl: config.desktopMode ? null : `/remote-login/${id}?token=${encodeURIComponent(token)}`,
    });
  });

  app.get("/login-sessions/:id", async (request) => {
    const id = (request.params as { id: string }).id;
    const row = await context.db.selectFrom("login_sessions").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) throw httpError(404, "登录会话不存在");
    return mapLogin(row);
  });

  app.post("/login-sessions/:id/complete", async (request) => {
    const id = (request.params as { id: string }).id;
    const result = await context.db.updateTable("login_sessions").set({ status: "saving", updated_at: nowIso() })
      .where("id", "=", id).where("status", "in", ["ready", "active"]).executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw httpError(409, "登录会话不能完成");
    return { ok: true };
  });

  app.post("/login-sessions/:id/extend", async (request) => {
    const id = (request.params as { id: string }).id;
    const row = await context.db.selectFrom("login_sessions").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row || !["ready", "active"].includes(row.status)) throw httpError(409, "登录会话不能延长");
    const expires = new Date(Math.max(Date.now(), new Date(row.expires_at).getTime()) + 15 * 60_000).toISOString();
    await context.db.updateTable("login_sessions").set({ expires_at: expires, updated_at: nowIso() }).where("id", "=", id).execute();
    return { expiresAt: expires };
  });

  app.post("/login-sessions/:id/cancel", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    await context.db.updateTable("login_sessions").set({
      status: "cancelled", updated_at: nowIso(), completed_at: nowIso(),
    }).where("id", "=", id).where("status", "in", ["queued", "starting", "ready", "active", "saving"]).execute();
    return reply.code(204).send();
  });
}
