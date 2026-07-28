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

export async function registerApplicationController(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { context, config } = deps;
  const publicUrlOptions = {
    allowProxyFakeIp: config.desktopMode,
    allowUnresolvedHostname: config.desktopMode,
  };

  app.get("/applications", async (request) => {
    const query = (request.query as { q?: string; status?: ProgressStatus }).q?.trim().toLowerCase() ?? "";
    const status = (request.query as { status?: ProgressStatus }).status;
    let builder = (await applicationRows(context)).orderBy("applications.updated_at", "desc");
    if (status) builder = builder.where("applications.progress_status_v2", "=", status);
    const rows = await builder.execute();
    return rows.filter((row) => !query || `${row.company} ${row.job_title} ${row.check_url}`.toLowerCase().includes(query)).map(mapApplication);
  });

  app.post("/applications", { schema: { body: CreateApplicationSchema } }, async (request, reply) => {
    const body = request.body as typeof CreateApplicationSchema.static;
    const checkUrl = body.checkUrl?.trim() ?? "";
    if (checkUrl) await assertPublicUrl(checkUrl, publicUrlOptions);
    if (body.postingUrl) await assertPublicUrl(body.postingUrl, publicUrlOptions);
    const site = checkUrl ? siteForUrl(checkUrl) : "manual";
    const id = randomUUID();
    const now = nowIso();
    const schedule = {
      schedule_mode: checkUrl ? (body.scheduleMode ?? "inherit") : "manual",
      cron_expression: checkUrl ? (body.cronExpression ?? null) : null,
    };
    if (schedule.schedule_mode === "custom" && !schedule.cron_expression) throw httpError(400, "自定义计划需要 Cron 表达式");
    const requestedNextRunAt = await calculateNextRun(context, schedule);
    const { group } = await findOrCreateCheckGroup(context, {
      company: body.company,
      checkUrl,
      site,
      scheduleMode: schedule.schedule_mode,
      cronExpression: schedule.cron_expression,
      nextRunAt: requestedNextRunAt,
      manualKey: id,
    });
    await context.db.insertInto("applications").values({
      id,
      check_group_id: group.id,
      company: body.company.trim(),
      job_title: body.jobTitle.trim(),
      check_url: checkUrl,
      resolved_url: null,
      posting_url: body.postingUrl ?? null,
      applied_at: body.appliedAt ?? null,
      location: body.location?.trim() || null,
      notes: body.notes?.trim() || null,
      site,
      progress_status: "unset",
      progress_status_v2: "unset",
      progress_source: null,
      manual_locked: 0,
      automation_paused: 0,
      automation_pause_reason: null,
      automation_paused_at: null,
      schedule_mode: group.schedule_mode,
      cron_expression: group.cron_expression,
      next_run_at: group.next_run_at,
      last_run_at: null,
      last_run_status: null,
      last_status_changed_at: null,
      created_at: now,
      updated_at: now,
    }).execute();
    await syncAppliedEvent(context, id, body.appliedAt ?? null);
    const created = await (await applicationRows(context)).where("applications.id", "=", id).executeTakeFirstOrThrow();
    return reply.code(201).send(mapApplication(created));
  });

  app.get("/applications/:id", async (request) => {
    const id = (request.params as { id: string }).id;
    const application = await (await applicationRows(context)).where("applications.id", "=", id).executeTakeFirst();
    if (!application) throw httpError(404, "岗位不存在");
    const groupId = application.check_group_id ?? application.id;
    const [runs, events, group, members] = await Promise.all([
      context.db.selectFrom("runs")
        .innerJoin("run_application_results", "run_application_results.run_id", "runs.id")
        .selectAll("runs").where("run_application_results.application_id", "=", id)
        .orderBy("runs.created_at", "desc").execute(),
      context.db.selectFrom("status_events").selectAll().where("application_id", "=", id).orderBy("created_at", "desc").execute(),
      context.db.selectFrom("check_groups").selectAll().where("id", "=", groupId).executeTakeFirstOrThrow(),
      context.db.selectFrom("applications").select(["id", "job_title", "progress_status_v2", "manual_locked", "automation_paused"])
        .where("check_group_id", "=", groupId).orderBy("created_at").execute(),
    ]);
    const allResults = await recognitionResults(context, runs.map((run) => run.id));
    return {
      application: mapApplication(application),
      checkGroup: {
        id: group.id,
        company: group.company,
        checkUrl: group.check_url || null,
        resolvedUrl: group.resolved_url,
        site: group.site,
        scheduleMode: group.schedule_mode,
        cronExpression: group.cron_expression,
        nextRunAt: group.next_run_at,
        memberCount: members.length,
        members: members.map((member) => ({
          id: member.id,
          jobTitle: member.job_title,
          progressStatus: member.progress_status_v2 ?? "unset",
          manualLocked: Boolean(member.manual_locked),
          automationPaused: Boolean(member.automation_paused),
        })),
      },
      runs: runs.map((run) => mapRun(run, allResults.get(run.id) ?? [], members.length)),
      statusEvents: events.map(mapEvent),
    };
  });

  app.post("/applications/:id/update", { schema: { body: UpdateApplicationSchema } }, async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as typeof UpdateApplicationSchema.static;
    const current = await context.db.selectFrom("applications").selectAll().where("id", "=", id).executeTakeFirst();
    if (!current) throw httpError(404, "岗位不存在");
    if (body.checkUrl) await assertPublicUrl(body.checkUrl, publicUrlOptions);
    if (body.postingUrl) await assertPublicUrl(body.postingUrl, publicUrlOptions);
    const currentGroup = current.check_group_id
      ? await context.db.selectFrom("check_groups").selectAll().where("id", "=", current.check_group_id).executeTakeFirst()
      : null;
    const checkUrl = body.checkUrl === undefined ? current.check_url : (body.checkUrl?.trim() ?? "");
    const scheduleMode = checkUrl ? (body.scheduleMode ?? currentGroup?.schedule_mode ?? current.schedule_mode) : "manual";
    const cronExpression = checkUrl
      ? (body.cronExpression === undefined ? (currentGroup?.cron_expression ?? current.cron_expression) : body.cronExpression)

      : null;
    if (scheduleMode === "custom" && !cronExpression) throw httpError(400, "自定义计划需要 Cron 表达式");
    const nextRunAt = await calculateNextRun(context, { schedule_mode: scheduleMode, cron_expression: cronExpression });
    const company = body.company?.trim() ?? current.company;
    const site = checkUrl ? siteForUrl(checkUrl) : "manual";
    const { group } = await findOrCreateCheckGroup(context, {
      company,
      checkUrl,
      site,
      scheduleMode,
      cronExpression,
      nextRunAt,
      manualKey: id,
    });
    if (currentGroup && currentGroup.id !== group.id) {
      const activeRuns = await context.db.selectFrom("runs").select("id")
        .where("check_group_id", "=", currentGroup.id)
        .where("status", "in", [...activeRunStatuses]).execute();
      await cancelActiveRuns(
        context,
        activeRuns.map((run) => run.id),
        "CHECK_GROUP_CHANGED",
        "岗位查询链接已变更，原检查任务已取消",
      );
      if (activeRuns.length) {
        const cancelledAt = nowIso();
        await context.db.updateTable("applications").set({
          last_run_status: "cancelled",
          last_run_at: cancelledAt,
          updated_at: cancelledAt,
        }).where("check_group_id", "=", currentGroup.id).execute();
      }
    }
    await context.db.updateTable("applications").set({
      check_group_id: group.id,
      ...(body.company !== undefined ? { company: body.company.trim() } : {}),
      ...(body.jobTitle !== undefined ? { job_title: body.jobTitle.trim() } : {}),
      ...(body.checkUrl !== undefined ? { check_url: checkUrl, site, resolved_url: null } : {}),
      ...(body.postingUrl !== undefined ? { posting_url: body.postingUrl } : {}),
      ...(body.appliedAt !== undefined ? { applied_at: body.appliedAt } : {}),
      ...(body.location !== undefined ? { location: body.location?.trim() || null } : {}),
      ...(body.notes !== undefined ? { notes: body.notes?.trim() || null } : {}),
      schedule_mode: group.schedule_mode,
      cron_expression: group.cron_expression,
      next_run_at: group.next_run_at,
      updated_at: nowIso(),
    }).where("id", "=", id).execute();
    if (body.appliedAt !== undefined) await syncAppliedEvent(context, id, body.appliedAt ?? null);
    if (currentGroup && currentGroup.id !== group.id) {
      const remaining = await context.db.selectFrom("applications").select(({ fn }) => fn.countAll<number>().as("count"))
        .where("check_group_id", "=", currentGroup.id).executeTakeFirstOrThrow();
      if (!Number(remaining.count)) await context.db.deleteFrom("check_groups").where("id", "=", currentGroup.id).execute();
    }
    const updated = await (await applicationRows(context)).where("applications.id", "=", id).executeTakeFirstOrThrow();
    return mapApplication(updated);
  });

  app.post("/applications/:id/check-plan/update", { schema: { body: CheckPlanUpdateSchema } }, async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as typeof CheckPlanUpdateSchema.static;
    const application = await context.db.selectFrom("applications").select(["check_group_id", "check_url"])
      .where("id", "=", id).executeTakeFirst();
    if (application && !application.check_url && body.scheduleMode !== "manual") {
      throw httpError(400, "未填写状态页 URL，只能手动更新状态");
    }
    if (!application?.check_group_id) throw httpError(404, "岗位或检查组不存在");
    if (body.scheduleMode === "custom" && !body.cronExpression) throw httpError(400, "自定义计划需要 Cron 表达式");
    const cronExpression = body.scheduleMode === "custom" ? body.cronExpression ?? null : null;
    let nextRunAt: string | null;
    try {
      nextRunAt = await calculateNextRun(context, { schedule_mode: body.scheduleMode, cron_expression: cronExpression });
    } catch {
      throw httpError(400, "Cron 表达式或时区无效");
    }
    const now = nowIso();
    await context.db.transaction().execute(async (trx) => {
      await trx.updateTable("check_groups").set({
        schedule_mode: body.scheduleMode,
        cron_expression: cronExpression,
        next_run_at: nextRunAt,
        updated_at: now,
      }).where("id", "=", application.check_group_id!).execute();
      await trx.updateTable("applications").set({
        schedule_mode: body.scheduleMode,
        cron_expression: cronExpression,
        next_run_at: nextRunAt,
        updated_at: now,
      }).where("check_group_id", "=", application.check_group_id!).execute();
    });
    const members = await context.db.selectFrom("applications").select(["id", "job_title", "progress_status_v2", "manual_locked", "automation_paused"])
      .where("check_group_id", "=", application.check_group_id).orderBy("created_at").execute();
    const group = await context.db.selectFrom("check_groups").selectAll().where("id", "=", application.check_group_id).executeTakeFirstOrThrow();
    return {
      checkGroup: {
        id: group.id, company: group.company, checkUrl: group.check_url || null, resolvedUrl: group.resolved_url,
        site: group.site, scheduleMode: group.schedule_mode, cronExpression: group.cron_expression,
        nextRunAt: group.next_run_at, memberCount: members.length,
        members: members.map((member) => ({
          id: member.id, jobTitle: member.job_title, progressStatus: member.progress_status_v2 ?? "unset",
          manualLocked: Boolean(member.manual_locked),
          automationPaused: Boolean(member.automation_paused),
        })),
      },
      affected: members.length,
    };
  });

  app.post("/applications/:id/delete", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const current = await context.db.selectFrom("applications").select(["id", "check_group_id"])
      .where("id", "=", id).executeTakeFirst();
    if (!current) throw httpError(404, "岗位不存在");
    const groupId = current.check_group_id ?? current.id;
    const replacement = await context.db.selectFrom("applications").select("id")
      .where("check_group_id", "=", groupId).where("id", "!=", id).orderBy("created_at").executeTakeFirst();
    const screenshotRows = replacement ? [] : await context.db.selectFrom("runs").select("screenshot_path")
      .where("check_group_id", "=", groupId).where("screenshot_path", "is not", null).execute();
    await context.db.transaction().execute(async (trx) => {
      if (replacement) {
        await trx.updateTable("runs").set({ application_id: replacement.id }).where("application_id", "=", id).execute();
        await trx.updateTable("login_sessions").set({ application_id: replacement.id }).where("application_id", "=", id).execute();
      }
      await trx.deleteFrom("applications").where("id", "=", id).execute();
      if (!replacement) {
        await trx.deleteFrom("runs").where("check_group_id", "=", groupId).execute();
        await trx.deleteFrom("check_groups").where("id", "=", groupId).execute();
      }
    });
    for (const row of screenshotRows) if (row.screenshot_path) await rm(row.screenshot_path, { force: true });
    if (!replacement) await rm(path.join(config.screenshotsPath, "groups", groupId), { recursive: true, force: true });
    await rm(path.join(config.screenshotsPath, id), { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.post("/applications/:id/runs", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = await context.db.selectFrom("applications").select(["id", "check_group_id", "check_url"]).where("id", "=", id).executeTakeFirst();
    if (exists && !exists.check_url) throw httpError(400, "未填写状态页 URL，无法运行截图检查");
    if (!exists) throw httpError(404, "岗位不存在");
    const runId = await queueRun(context, id, "manual", [id]);
    if (!runId) throw httpError(409, "该检查组已有进行中的检查");
    return reply.code(202).send({ runId, groupId: exists.check_group_id ?? exists.id });
  });

  app.post("/applications/:id/login", async (request, reply) => {
    const applicationId = (request.params as { id: string }).id;
    const application = await context.db.selectFrom("applications").select(["id", "check_group_id", "check_url"])
      .where("id", "=", applicationId).executeTakeFirst();
    if (application && !application.check_url) throw httpError(400, "未填写状态页 URL，无需刷新登录状态");
    if (!application) throw httpError(404, "岗位不存在");

    const activeRuns = await context.db.selectFrom("runs")
      .select(["id", "application_id", "check_group_id", "status"])
      .where("status", "in", [...activeRunStatuses])
      .where((eb) => eb.or([
        eb("check_group_id", "=", application.check_group_id),
        eb("application_id", "=", applicationId),
      ])).execute();
    const staleRuns = activeRuns.filter((run) =>
      run.application_id === applicationId && run.check_group_id !== application.check_group_id);

    await cancelActiveRuns(
      context,
      staleRuns.map((run) => run.id),
      "CHECK_GROUP_CHANGED",
      "岗位查询链接已变更，原登录任务已取消",
    );
    const activeRun = activeRuns.find((run) =>
      run.check_group_id === application.check_group_id && !staleRuns.some((stale) => stale.id === run.id));
    if (activeRun) {
      if (activeRun.status === "needs_login") return { runId: activeRun.id };
      throw httpError(409, "该岗位已有截图任务正在执行，请稍后再刷新登录状态");
    }

    const runId = randomUUID();
    const now = nowIso();
    try {
      await context.db.transaction().execute(async (trx) => {
        await trx.insertInto("runs").values({
          id: runId,
          check_group_id: application.check_group_id,
          application_id: applicationId,
          trigger: "manual",
          status: "needs_login",
          final_url: null,
          page_title: null,
          screenshot_path: null,
          screenshot_truncated: 0,
          ai_status: "skipped",
          ai_suggested_status: null,
          ai_suggested_status_v2: null,
          ai_confidence: null,
          ai_evidence: null,
          ai_provider: null,
          error_code: "MANUAL_LOGIN_REFRESH",
          error_message: "用户手动刷新登录状态",
          created_at: now,
          started_at: now,
          completed_at: now,
        }).execute();
        const members = (await trx.selectFrom("applications").select(["id", "job_title", "automation_paused"])
          .where("check_group_id", "=", application.check_group_id).execute())
          .filter((member) => !member.automation_paused || member.id === applicationId);
        await trx.insertInto("run_application_results").values(members.map((member) => ({
          id: randomUUID(), run_id: runId, application_id: member.id, job_title_snapshot: member.job_title,
          matched: 0, raw_status: null, suggested_status: null, confidence: null, evidence: null,
          applied: 0, not_applied_reason: null, automation_paused: member.automation_paused ? 1 : 0, created_at: now,
        }))).execute();
        await trx.updateTable("applications").set({
          last_run_status: "needs_login",
          last_run_at: now,
          updated_at: now,
        }).where("check_group_id", "=", application.check_group_id).execute();
      });
    } catch (error) {
      if (!isActiveRunConstraint(error)) throw error;
      const concurrent = await context.db.selectFrom("runs").select(["id", "status"])
        .where("status", "in", [...activeRunStatuses])
        .where((eb) => eb.or([
          eb("check_group_id", "=", application.check_group_id),
          eb("application_id", "=", applicationId),
        ])).executeTakeFirst();
      if (concurrent?.status === "needs_login") return reply.code(200).send({ runId: concurrent.id });
      throw httpError(409, "该岗位已有截图任务正在执行，请稍后再刷新登录状态");
    }
    return reply.code(201).send({ runId });
  });
}
