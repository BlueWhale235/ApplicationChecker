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
import type { NextLoginSummary } from "@application-checker/contracts";

export async function registerLoginController(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { context, config } = deps;

  app.post("/login-sessions", async (request, reply) => {
    const { runId } = request.body as { runId: string };
    const run = await context.db.selectFrom("runs").innerJoin("applications", "applications.id", "runs.application_id")
      .select(["runs.id", "runs.application_id", "runs.status"])
      .where("runs.id", "=", runId).executeTakeFirst();
    if (!run) throw httpError(404, "运行记录不存在");
    if (run.status !== "needs_login") throw httpError(409, "该运行当前不需要登录");
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const replacedExisting = await context.db.transaction().execute(async (trx) => {
      const saving = await trx.selectFrom("login_sessions").select("id")
        .where("status", "=", "saving").executeTakeFirst();
      if (saving) throw httpError(409, "登录状态正在保存，请稍后再试");
      const replaceable = await trx.selectFrom("login_sessions").select("id")
        .where("status", "in", ["queued", "starting", "ready", "active"]).execute();
      if (replaceable.length) {
        await trx.updateTable("login_sessions").set({
          status: "cancelled",
          error_message: "已切换到新的登录窗口",
          updated_at: now.toISOString(),
          completed_at: now.toISOString(),
        }).where("id", "in", replaceable.map((session) => session.id)).execute();
      }
      await trx.insertInto("login_sessions").values({
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
      return replaceable.length > 0;
    });
    const row = await context.db.selectFrom("login_sessions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    return reply.code(201).send({
      session: mapLogin(row),
      accessUrl: config.desktopMode ? null : `/remote-login/${id}?token=${encodeURIComponent(token)}`,
      replacedExisting,
    });
  });

  app.get("/login-sessions/:id", async (request) => {
    const id = (request.params as { id: string }).id;
    const row = await context.db.selectFrom("login_sessions").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) throw httpError(404, "登录会话不存在");
    return mapLogin(row);
  });

  app.get("/login-sessions/next-needed", async (request): Promise<NextLoginSummary | null> => {
    const excludeRunId = (request.query as { excludeRunId?: string }).excludeRunId;
    let query = context.db.selectFrom("runs")
      .innerJoin("applications", "applications.id", "runs.application_id")
      .leftJoin("check_groups", "check_groups.id", "runs.check_group_id")
      .select([
        "runs.id as run_id",
        "applications.company",
        "applications.job_title",
        "applications.site",
        "check_groups.company as group_company",
      ])
      .where("runs.status", "=", "needs_login")
      .orderBy("runs.created_at");
    if (excludeRunId) query = query.where("runs.id", "!=", excludeRunId);
    const next = await query.executeTakeFirst();
    return next ? {
      runId: next.run_id,
      company: next.group_company ?? next.company,
      jobTitle: next.job_title,
      site: next.site,
    } : null;
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
