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

export async function registerRunController(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { context, config, aiDebugStore } = deps;

  app.post("/runs/bulk", { schema: { body: BulkRunSchema } }, async (request, reply) => {
    const body = request.body as typeof BulkRunSchema.static;
    const rows = body.applicationIds?.length
      ? await context.db.selectFrom("applications").select(["id", "check_group_id"]).where("id", "in", body.applicationIds).execute()
      : await context.db.selectFrom("applications").select(["id", "check_group_id"]).where("automation_paused", "=", 0).execute();
    const queued: string[] = [];
    let skipped = 0;
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const groupId = row.check_group_id ?? row.id;
      grouped.set(groupId, [...(grouped.get(groupId) ?? []), row.id]);
    }
    for (const selectedIds of grouped.values()) {
      const id = await queueRun(context, selectedIds[0]!, "bulk", body.applicationIds?.length ? selectedIds : []);
      if (id) queued.push(id);
      else skipped += 1;
    }
    return reply.code(202).send({ queued, skipped });
  });

  app.get("/runs", async (request) => {
    const query = request.query as { scope?: string; status?: string; q?: string; limit?: string; offset?: string };
    const scope = query.scope === "active" ? "active" : "history";
    const activeStatuses = ["queued", "running", "needs_login"] as const;
    const historyStatuses = ["succeeded", "failed", "cancelled"] as const;
    const allowed = scope === "active" ? activeStatuses : historyStatuses;
    if (query.status && !allowed.includes(query.status as never)) throw httpError(400, "任务状态与分组不匹配");
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);
    const search = query.q?.trim() ?? "";
    let builder = context.db.selectFrom("runs")
      .innerJoin("check_groups", "check_groups.id", "runs.check_group_id")
      .innerJoin("applications", "applications.id", "runs.application_id")
      .selectAll("runs")
      .select([
        "check_groups.company as task_company",
        "applications.job_title as task_job_title",
        "check_groups.site as task_site",
        "applications.progress_status_v2 as task_progress_status",
      ])
      .select((eb) => eb.selectFrom("applications as task_members")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .whereRef("task_members.check_group_id", "=", "runs.check_group_id")
        .as("task_member_count"))
      .where("runs.status", "in", query.status ? [query.status as never] : [...allowed]);
    if (search) {
      const pattern = `%${search}%`;
      builder = builder.where((eb) => eb.or([
        eb("check_groups.company", "like", pattern),
        eb("applications.job_title", "like", pattern),
        eb("applications.site", "like", pattern),
      ]));
    }
    const totalRow = await builder.clearSelect().select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    const rows = await builder
      .orderBy(scope === "active" ? "runs.created_at" : "runs.completed_at", "desc")
      .limit(limit).offset(offset).execute();
    const resultMap = await recognitionResults(context, rows.map((row) => row.id));
    return {
      items: rows.map((row) => ({
        ...mapRun(row, resultMap.get(row.id) ?? [], Number(row.task_member_count ?? 1)),
        company: row.task_company,
        jobTitle: Number(row.task_member_count) > 1 ? `${row.task_member_count} 个岗位` : row.task_job_title,
        site: row.task_site,
        progressStatus: row.task_progress_status ?? "unset",
      })),
      total: Number(totalRow.count),
      limit,
      offset,
    };
  });

  app.post("/runs/history/delete-all", async () => {
    const historyStatuses = ["succeeded", "failed", "cancelled"] as const;
    const rows = await context.db.selectFrom("runs").select(["id", "screenshot_path"])
      .where("status", "in", [...historyStatuses]).execute();
    const runIds = rows.map((row) => row.id);
    let deleted = 0;
    if (runIds.length) {
      const result = await context.db.deleteFrom("runs").where("id", "in", runIds).executeTakeFirst();
      deleted = Number(result.numDeletedRows);
    }
    let screenshotsDeleted = 0;
    let screenshotsMissing = 0;
    let screenshotsFailed = 0;
    for (const row of rows) {
      if (!row.screenshot_path) continue;
      if (!isInside(config.screenshotsPath, row.screenshot_path)) {
        screenshotsFailed += 1;

        continue;
      }
      try {
        const info = await stat(row.screenshot_path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!info) {
          screenshotsMissing += 1;
          continue;
        }
        await rm(row.screenshot_path, { force: true });
        screenshotsDeleted += 1;
      } catch {
        screenshotsFailed += 1;
      }
    }
    aiDebugStore?.removeRuns(runIds);
    return { deleted, screenshotsDeleted, screenshotsMissing, screenshotsFailed };
  });

  app.post("/runs/:id/cancel", async (request) => {
    const id = (request.params as { id: string }).id;
    const row = await context.db.selectFrom("runs").select(["application_id", "check_group_id", "status"]).where("id", "=", id).executeTakeFirst();
    if (!row) throw httpError(404, "任务不存在");
    if (!["queued", "running", "needs_login"].includes(row.status)) throw httpError(409, "该任务已经结束");
    const now = nowIso();
    await context.db.transaction().execute(async (trx) => {
      const cancelled = await trx.updateTable("runs").set({
        status: "cancelled", completed_at: now, error_code: "CANCELLED", error_message: "用户取消",
      }).where("id", "=", id).where("status", "=", row.status).executeTakeFirst();
      if (!Number(cancelled.numUpdatedRows)) throw httpError(409, "任务状态已经变化");
      await trx.updateTable("login_sessions").set({
        status: "cancelled", completed_at: now, updated_at: now,
      }).where("run_id", "=", id).where("status", "in", ["queued", "starting", "ready", "active", "saving"]).execute();
      await trx.updateTable("applications").set({
        last_run_status: "cancelled", last_run_at: now, updated_at: now,
      }).where("check_group_id", "=", row.check_group_id).execute();
    });
    return { ok: true };
  });

  app.post("/runs/:id/retry", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const row = await context.db.selectFrom("runs").select(["application_id", "check_group_id", "status"]).where("id", "=", id).executeTakeFirst();
    if (!row) throw httpError(404, "任务不存在");
    if (!["failed", "cancelled"].includes(row.status)) throw httpError(409, "只有失败或已取消任务可以重试");
    const runId = await queueRun(context, row.application_id, "manual", [row.application_id]);
    if (!runId) throw httpError(409, "该岗位已有进行中的任务");
    return reply.code(202).send({ runId });
  });

  app.get("/applications/:id/runs", async (request) => {
    const id = (request.params as { id: string }).id;
    const rows = await context.db.selectFrom("runs")
      .innerJoin("run_application_results", "run_application_results.run_id", "runs.id")
      .selectAll("runs").where("run_application_results.application_id", "=", id)
      .orderBy("runs.created_at", "desc").execute();
    const results = await recognitionResults(context, rows.map((row) => row.id));
    return rows.map((row) => mapRun(row, results.get(row.id) ?? []));
  });

  app.get("/runs/:id/screenshot", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const row = await context.db.selectFrom("runs").select(["screenshot_path"]).where("id", "=", id).executeTakeFirst();
    if (!row?.screenshot_path) throw httpError(404, "截图不存在");
    const info = await stat(row.screenshot_path).catch(() => null);
    if (!info) throw httpError(404, "截图文件不存在");
    reply.type("image/png").header("cache-control", "private, max-age=300").header("content-length", String(info.size));
    return reply.send(createReadStream(row.screenshot_path));
  });

  app.post("/runs/:id/screenshot/delete", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const row = await context.db.selectFrom("runs").select("screenshot_path").where("id", "=", id).executeTakeFirst();
    if (!row) throw httpError(404, "运行记录不存在");
    if (row.screenshot_path) await rm(row.screenshot_path, { force: true });
    await context.db.updateTable("runs").set({ screenshot_path: null }).where("id", "=", id).execute();
    return reply.code(204).send();
  });

  app.post("/applications/:id/progress", { schema: { body: SetProgressSchema } }, async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as typeof SetProgressSchema.static;
    const current = await context.db.selectFrom("applications").select(["progress_status_v2", "check_group_id"]).where("id", "=", id).executeTakeFirst();
    if (!current) throw httpError(404, "岗位不存在");
    const now = nowIso();
    await context.db.transaction().execute(async (trx) => {
      await trx.updateTable("applications").set({
        progress_status: legacyStatus(body.status),
        progress_status_v2: body.status,
        progress_source: "manual",
        manual_locked: 1,
        ...(body.status === "rejected" ? {
          automation_paused: 1,
          automation_pause_reason: "rejected" as const,
          automation_paused_at: now,
          next_run_at: null,
        } : {}),
        last_status_changed_at: now,
        updated_at: now,
      }).where("id", "=", id).execute();
      await trx.insertInto("status_events").values({
        id: randomUUID(),
        application_id: id,
        run_id: null,
        from_status: current.progress_status_v2 ?? "unset",
        to_status: body.status,
        source: "manual",
        confidence: null,
        evidence: null,
        note: body.note ?? null,
        event_type: "progress",
        created_at: now,
      }).execute();
    });
    if (body.status === "rejected" && current.check_group_id) {
      await clearGroupScheduleIfFullyPaused(context, current.check_group_id);
    }
    return { ok: true };
  });

  app.post("/applications/:id/automation/resume", async (request) => {
    const id = (request.params as { id: string }).id;
    const application = await context.db.selectFrom("applications")
      .select(["progress_status_v2", "check_group_id"]).where("id", "=", id).executeTakeFirst();
    if (!application) throw httpError(404, "岗位不存在");
    if (application.progress_status_v2 === "rejected") throw httpError(409, "请先将岗位状态改为非淘汰状态");
    if (!application.check_group_id) throw httpError(409, "岗位尚未加入检查组");
    const group = await context.db.selectFrom("check_groups").selectAll()
      .where("id", "=", application.check_group_id).executeTakeFirstOrThrow();
    const nextRunAt = await calculateNextRun(context, group);
    const now = nowIso();
    await context.db.transaction().execute(async (trx) => {
      await trx.updateTable("applications").set({
        automation_paused: 0,
        automation_pause_reason: null,
        automation_paused_at: null,
        next_run_at: nextRunAt,
        updated_at: now,
      }).where("id", "=", id).execute();
      await trx.updateTable("check_groups").set({ next_run_at: nextRunAt, updated_at: now })
        .where("id", "=", group.id).execute();
      await trx.updateTable("applications").set({ next_run_at: nextRunAt, updated_at: now })
        .where("check_group_id", "=", group.id).where("automation_paused", "=", 0).execute();
    });
    return { ok: true, nextRunAt };
  });

  app.post("/applications/:id/progress/unlock", async (request) => {
    const id = (request.params as { id: string }).id;
    const result = await context.db.updateTable("applications").set({ manual_locked: 0, updated_at: nowIso() }).where("id", "=", id).executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw httpError(404, "岗位不存在");
    return { ok: true };
  });
}
