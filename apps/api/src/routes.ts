import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AiSettingsUpdateSchema,
  BulkRunSchema,
  CheckPlanUpdateSchema,
  CreateApplicationSchema,
  SetProgressSchema,
  SettingsUpdateSchema,
  UpdateApplicationSchema,
  siteForUrl,
  type BrowserStateEnvelope,
  type ApplicationRecognitionResult,
  type ProgressStatus,
  type RunnerJob,
  type RunnerLoginJob,
} from "@application-checker/contracts";
import type { StatusRecognizer } from "@application-checker/ai-status";
import type { Config } from "./config.js";
import type { DbContext, RunsTable } from "./db.js";
import { mapApplication, mapEvent, mapLogin, mapProfile, mapRecognitionResult, mapRun } from "./mappers.js";
import { assertPublicUrl } from "./security.js";
import {
  appSettings, calculateNextRun, cleanupExpiredScreenshots, clearGroupScheduleIfFullyPaused, loadBrowserState, queueRun,
  findOrCreateCheckGroup, recomputeInheritedSchedules, saveBrowserState,
} from "./service.js";
import {
  recognizerFromSettings, syncRuntimeSettingsFile, updateAiSettings,
} from "./runtime-settings.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const nowIso = () => new Date().toISOString();
const appliedAtIso = (value: string) => new Date(`${value}T00:00:00+08:00`).toISOString();
const apiPath = (request: FastifyRequest) => request.url.replace(/^\/api(?=\/)/, "").split("?")[0] ?? "";

async function syncAppliedEvent(context: DbContext, applicationId: string, appliedAt: string | null): Promise<void> {
  const existing = await context.db.selectFrom("status_events").select("id")
    .where("application_id", "=", applicationId).where("event_type", "=", "applied").executeTakeFirst();
  if (!appliedAt) {
    if (existing) await context.db.deleteFrom("status_events").where("id", "=", existing.id).execute();
    return;
  }
  const createdAt = appliedAtIso(appliedAt);
  if (existing) {
    await context.db.updateTable("status_events").set({ created_at: createdAt })
      .where("id", "=", existing.id).execute();
    return;
  }
  await context.db.insertInto("status_events").values({
    id: randomUUID(),
    application_id: applicationId,
    run_id: null,
    from_status: "unset",
    to_status: "unset",
    source: "manual",
    confidence: null,
    evidence: null,
    note: "投递",
    event_type: "applied",
    created_at: createdAt,
  }).execute();
}

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

async function applicationRows(context: DbContext) {
  return context.db.selectFrom("applications")
    .leftJoin("browser_profiles", "browser_profiles.site", "applications.site")
    .leftJoin("check_groups", "check_groups.id", "applications.check_group_id")
    .selectAll("applications")
    .select([
      "browser_profiles.updated_at as browser_profile_updated_at",
      "check_groups.schedule_mode as group_schedule_mode",
      "check_groups.cron_expression as group_cron_expression",
      "check_groups.next_run_at as group_next_run_at",
      "check_groups.resolved_url as group_resolved_url",
    ])
    .select((eb) => eb.selectFrom("applications as group_members")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .whereRef("group_members.check_group_id", "=", "applications.check_group_id")
      .as("group_member_count"));
}

function runnerAuthorized(request: FastifyRequest, config: Config): boolean {
  return request.headers.authorization === `Bearer ${config.runnerToken}`;
}

async function persistScreenshot(config: Config, groupId: string, runId: string, base64: string): Promise<string> {
  const folder = path.join(config.screenshotsPath, "groups", groupId);
  await mkdir(folder, { recursive: true });
  const filename = path.join(folder, `${runId}.png`);
  await writeFile(filename, Buffer.from(base64, "base64"));
  return filename;
}

function legacyStatus(status: ProgressStatus): string {
  return ["screening_passed", "interviewed"].includes(status) ? "screening" : status;
}

async function recognitionResults(context: DbContext, runIds: string[]): Promise<Map<string, ApplicationRecognitionResult[]>> {
  const mapped = new Map<string, ApplicationRecognitionResult[]>();
  if (!runIds.length) return mapped;
  const rows = await context.db.selectFrom("run_application_results").selectAll().where("run_id", "in", runIds).execute();
  for (const row of rows) mapped.set(row.run_id, [...(mapped.get(row.run_id) ?? []), mapRecognitionResult(row)]);
  return mapped;
}

export interface RouteDeps {
  context: DbContext;
  config: Config;
  recognizer?: StatusRecognizer;
  runnerHeartbeat: { at: number };
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { context, config, recognizer: injectedRecognizer, runnerHeartbeat } = deps;
  const publicUrlOptions = { allowProxyFakeIp: config.desktopMode };

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

    const activeRun = await context.db.selectFrom("runs").select(["id", "status"])
      .where("check_group_id", "=", application.check_group_id)
      .where("status", "in", ["queued", "running", "needs_login"])
      .executeTakeFirst();
    if (activeRun) {
      if (activeRun.status === "needs_login") return { runId: activeRun.id };
      throw httpError(409, "该岗位已有截图任务正在执行，请稍后再刷新登录状态");
    }

    const runId = randomUUID();
    const now = nowIso();
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
    return reply.code(201).send({ runId });
  });

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
      runnerHealthy: Date.now() - runnerHeartbeat.at < 20_000,
      loginPresentation: config.desktopMode ? "external-window" : "vnc",
    };
  });

  app.post("/settings/update", { schema: { body: SettingsUpdateSchema } }, async (request) => {
    const body = request.body as typeof SettingsUpdateSchema.static;
    const { validateCron } = await import("./cron.js");
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
    };
  });

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

  // Runner-only endpoints.
  app.addHook("preHandler", async (request) => {
    if (apiPath(request).startsWith("/internal/") && !runnerAuthorized(request, config)) {
      throw httpError(401, "Runner authorization failed");
    }
  });

  app.post("/internal/heartbeat", async () => {
    runnerHeartbeat.at = Date.now();
    return { ok: true };
  });

  app.get("/internal/runs/:id/control", async (request) => {
    const id = (request.params as { id: string }).id;
    const row = await context.db.selectFrom("runs").select("status").where("id", "=", id).executeTakeFirst();
    if (!row) throw httpError(404, "Run not found");
    return { status: row.status };
  });

  app.post("/internal/claim", async (): Promise<RunnerLoginJob | RunnerJob | { kind: "idle" }> => {
    const login = await context.db.selectFrom("login_sessions")
      .innerJoin("applications", "applications.id", "login_sessions.application_id")
      .leftJoin("check_groups", "check_groups.id", "applications.check_group_id")
      .select([
        "login_sessions.id", "login_sessions.run_id", "login_sessions.application_id",
        "login_sessions.expires_at", "applications.check_group_id", "applications.resolved_url", "applications.check_url", "applications.site",
        "check_groups.resolved_url as group_resolved_url", "check_groups.check_url as group_check_url",
      ])
      .where("login_sessions.status", "=", "queued").orderBy("login_sessions.created_at").executeTakeFirst();
    if (login) {
      const updated = await context.db.updateTable("login_sessions").set({ status: "starting", updated_at: nowIso() })
        .where("id", "=", login.id).where("status", "=", "queued").executeTakeFirst();
      if (Number(updated.numUpdatedRows)) return {
        kind: "login",
        sessionId: login.id,
        runId: login.run_id,
        groupId: login.check_group_id ?? login.application_id,
        applicationId: login.application_id,
        url: login.group_resolved_url ?? login.resolved_url ?? login.group_check_url ?? login.check_url,
        site: login.site,
        browserState: await loadBrowserState(context, config, login.site),
        expiresAt: login.expires_at,
        proxyUrl: config.upstreamProxyUrl,
        userAgent: (await appSettings(context)).default_user_agent,
      };
    }
    const run = await context.db.selectFrom("runs")
      .innerJoin("applications", "applications.id", "runs.application_id")
      .leftJoin("check_groups", "check_groups.id", "runs.check_group_id")
      .select([
        "runs.id", "runs.application_id", "runs.check_group_id", "applications.resolved_url", "applications.check_url",
        "applications.company", "applications.job_title", "applications.site", "check_groups.check_url as group_check_url",
        "check_groups.resolved_url as group_resolved_url", "check_groups.company as group_company",
      ])
      .where("runs.status", "=", "queued").orderBy("runs.created_at").executeTakeFirst();
    if (!run) return { kind: "idle" };
    const started = nowIso();
    const updated = await context.db.updateTable("runs").set({ status: "running", started_at: started, error_code: null, error_message: null })
      .where("id", "=", run.id).where("status", "=", "queued").executeTakeFirst();
    if (!Number(updated.numUpdatedRows)) return { kind: "idle" };
    const groupId = run.check_group_id ?? run.application_id;
    await context.db.updateTable("applications").set({ last_run_status: "running", last_run_at: started, updated_at: started })
      .where("check_group_id", "=", groupId).execute();
    const members = await context.db.selectFrom("applications")
      .innerJoin("run_application_results", "run_application_results.application_id", "applications.id")
      .select(["applications.id", "applications.job_title", "applications.applied_at", "applications.location"])
      .where("run_application_results.run_id", "=", run.id).orderBy("applications.created_at").execute();
    return {
      kind: "capture",
      runId: run.id,
      groupId,
      applicationId: run.application_id,
      url: run.group_resolved_url ?? run.resolved_url ?? run.group_check_url ?? run.check_url,
      company: run.group_company ?? run.company,
      jobTitle: run.job_title,
      applications: members.map((member) => ({
        id: member.id, jobTitle: member.job_title, appliedAt: member.applied_at, location: member.location,
      })),
      site: run.site,
      browserState: await loadBrowserState(context, config, run.site),
      proxyUrl: config.upstreamProxyUrl,
      userAgent: (await appSettings(context)).default_user_agent,
    };
  });

  app.post("/internal/runs/:id/needs-login", async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { finalUrl: string; pageTitle: string | null; screenshotBase64?: string; reason?: string };
    const run = await context.db.selectFrom("runs").select(["application_id", "check_group_id", "status"]).where("id", "=", id).executeTakeFirst();
    if (!run) throw httpError(404, "Run not found");
    if (run.status !== "running") return { ok: true, discarded: true };
    const groupId = run.check_group_id ?? run.application_id;
    const screenshot = body.screenshotBase64 ? await persistScreenshot(config, groupId, id, body.screenshotBase64) : null;
    const completed = nowIso();
    const updated = await context.db.updateTable("runs").set({
      status: "needs_login",
      final_url: body.finalUrl,
      page_title: body.pageTitle,
      ...(screenshot ? { screenshot_path: screenshot } : {}),
      error_code: "LOGIN_REQUIRED",
      error_message: body.reason?.slice(0, 500) ?? "需要登录后继续",
      completed_at: completed,
    }).where("id", "=", id).where("status", "=", "running").executeTakeFirst();
    if (!Number(updated.numUpdatedRows)) {
      if (screenshot) await rm(screenshot, { force: true });
      return { ok: true, discarded: true };
    }
    await context.db.updateTable("applications").set({ last_run_status: "needs_login", updated_at: completed })
      .where("check_group_id", "=", groupId).execute();
    return { ok: true };
  });

  app.post("/internal/runs/:id/complete", async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as {
      finalUrl: string; pageTitle: string | null; screenshotBase64: string; truncated: boolean; browserState: BrowserStateEnvelope;
    };
    const run = await context.db.selectFrom("runs").innerJoin("applications", "applications.id", "runs.application_id")
      .select([
        "runs.application_id", "runs.check_group_id", "runs.status", "applications.company", "applications.job_title", "applications.site",
      ]).where("runs.id", "=", id).executeTakeFirst();
    if (!run) throw httpError(404, "Run not found");
    if (run.status !== "running") return { ok: true, discarded: true };
    const groupId = run.check_group_id ?? run.application_id;
    const members = await context.db.selectFrom("applications")
      .innerJoin("run_application_results", "run_application_results.application_id", "applications.id")
      .select([
        "applications.id", "applications.company", "applications.job_title", "applications.applied_at", "applications.location",
        "applications.progress_status_v2", "applications.manual_locked", "applications.automation_paused",
      ])
      .where("run_application_results.run_id", "=", id).orderBy("applications.created_at").execute();
    const screenshotPath = await persistScreenshot(config, groupId, id, body.screenshotBase64);
    await saveBrowserState(context, config, run.site, body.browserState);
    let aiStatus: RunsTable["ai_status"] = "skipped";
    let provider: string | null = null;
    let aiError: string | null = null;
    let groupResults: Array<{
      applicationId: string; matched: boolean; rawStatus: string | null; status: ProgressStatus | null;
      confidence: number; evidence: string;
    }> = [];
    const settings = await appSettings(context);
    const recognizer = injectedRecognizer ?? recognizerFromSettings(settings, config);
    if (recognizer.configured) {
      aiStatus = "pending";
      try {
        const input = {
          screenshot: Buffer.from(body.screenshotBase64, "base64"),
          company: run.company,
          applications: members.map((member) => ({
            id: member.id, jobTitle: member.job_title, appliedAt: member.applied_at, location: member.location,
          })),
          pageTitle: body.pageTitle,
          finalUrl: body.finalUrl,
        };
        if (!recognizer.recognizeGroup) {
          if (members.length !== 1) throw new Error("AI 适配器不支持同页多岗位识别");
          const single = await recognizer.recognize({
            screenshot: input.screenshot,
            company: input.company,
            jobTitle: members[0]!.job_title,
            pageTitle: input.pageTitle,
            finalUrl: input.finalUrl,
          });
          groupResults = [{
            applicationId: members[0]!.id, matched: Boolean(single.status), rawStatus: null,
            status: single.status, confidence: single.confidence, evidence: single.evidence,
          }];
          provider = single.provider;
        } else {
          const result = await recognizer.recognizeGroup(input);
          groupResults = result.results;
          provider = result.provider;
        }
        aiStatus = "succeeded";
      } catch (error) {
        aiStatus = "failed";
        aiError = error instanceof Error ? error.message.slice(0, 500) : "AI recognition failed";
      }
    }
    const stillRunning = await context.db.selectFrom("runs").select("status").where("id", "=", id).executeTakeFirst();
    if (stillRunning?.status !== "running") {
      await rm(screenshotPath, { force: true });
      return { ok: true, discarded: true };
    }
    const completed = nowIso();
    const candidateIds = new Set(members.map((member) => member.id));
    const seen = new Set<string>();
    const validResults = new Map(groupResults
      .filter((result) => candidateIds.has(result.applicationId) && !seen.has(result.applicationId) && seen.add(result.applicationId))
      .map((result) => [result.applicationId, result]));
    const firstSuggestion = groupResults.find((result) => result.status)?.status ?? null;
    const firstEvidence = aiError ?? groupResults.find((result) => result.evidence)?.evidence ?? null;
    const firstConfidence = groupResults.find((result) => result.status)?.confidence ?? null;
    let updated = { numUpdatedRows: 0n };
    let pausedByRejection = false;
    await context.db.transaction().execute(async (trx) => {
      for (const member of members) {
        const result = validResults.get(member.id);
        const matched = aiStatus === "succeeded" && Boolean(result?.matched && result.status);
        const blockedByPause = Boolean(member.automation_paused);
        const applied = matched && result!.confidence >= settings.ai_confidence_threshold && !member.manual_locked && !blockedByPause;
        const notAppliedReason = aiStatus === "failed" ? "ai_failed"
          : !matched ? "unmatched"
            : member.manual_locked ? "manual_locked"
              : blockedByPause ? null
              : result!.confidence < settings.ai_confidence_threshold ? "low_confidence" : null;
        await trx.updateTable("run_application_results").set({
          matched: matched ? 1 : 0,
          raw_status: result?.rawStatus ?? null,
          suggested_status: result?.status ?? null,
          confidence: result?.confidence ?? null,
          evidence: aiError ?? result?.evidence ?? null,
          applied: applied ? 1 : 0,
          not_applied_reason: notAppliedReason,
          automation_paused: blockedByPause ? 1 : 0,
        }).where("run_id", "=", id).where("application_id", "=", member.id).execute();
        if (applied && result?.status) {
          const previous = member.progress_status_v2 ?? "unset";
          const rejected = result.status === "rejected";
          await trx.updateTable("applications").set({
            progress_status: legacyStatus(result.status),
            progress_status_v2: result.status,
            progress_source: "ai",
            ...(rejected ? {
              automation_paused: 1,
              automation_pause_reason: "rejected" as const,
              automation_paused_at: completed,
              next_run_at: null,
            } : {}),
            last_status_changed_at: completed,
            updated_at: completed,
          }).where("id", "=", member.id).execute();
          if (rejected) pausedByRejection = true;
          if (previous !== result.status) {
            const statusEventId = randomUUID();
            await trx.insertInto("status_events").values({
              id: statusEventId, application_id: member.id, run_id: id, from_status: previous,
              to_status: result.status, source: "ai", confidence: result.confidence,
              evidence: result.evidence, note: result.rawStatus, event_type: "progress", created_at: completed,
            }).execute();
            await trx.insertInto("notifications").values({
              id: randomUUID(),
              application_id: member.id,
              run_id: id,
              status_event_id: statusEventId,
              company_snapshot: member.company,
              job_title_snapshot: member.job_title,
              from_status: previous,
              to_status: result.status,
              confidence: result.confidence,
              evidence: result.evidence,
              read_at: null,
              created_at: completed,
            }).execute();
          }
        }
      }
      updated = await trx.updateTable("runs").set({
        status: "succeeded",
        final_url: body.finalUrl,
        page_title: body.pageTitle,
        screenshot_path: screenshotPath,
        screenshot_truncated: body.truncated ? 1 : 0,
        ai_status: aiStatus,
        ai_suggested_status: firstSuggestion ? legacyStatus(firstSuggestion) : null,
        ai_suggested_status_v2: firstSuggestion,
        ai_confidence: firstConfidence,
        ai_evidence: firstEvidence,
        ai_provider: provider,
        error_code: null,
        error_message: null,
        completed_at: completed,
      }).where("id", "=", id).where("status", "=", "running").executeTakeFirst();
    });
    if (!Number(updated.numUpdatedRows)) {
      await rm(screenshotPath, { force: true });
      return { ok: true, discarded: true };
    }
    if (pausedByRejection) await clearGroupScheduleIfFullyPaused(context, groupId);
    await context.db.updateTable("applications").set({
      last_run_status: "succeeded", last_run_at: completed, updated_at: completed,
    }).where("check_group_id", "=", groupId).execute();
    return { ok: true };
  });

  app.post("/internal/runs/:id/fail", async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { code?: string; message?: string };
    const run = await context.db.selectFrom("runs").select(["application_id", "check_group_id", "status"]).where("id", "=", id).executeTakeFirst();
    if (!run) throw httpError(404, "Run not found");
    if (run.status !== "running") return { ok: true, discarded: true };
    const completed = nowIso();
    const updated = await context.db.updateTable("runs").set({
      status: "failed",
      error_code: body.code?.slice(0, 100) ?? "CAPTURE_FAILED",
      error_message: body.message?.slice(0, 500) ?? "Capture failed",
      completed_at: completed,
    }).where("id", "=", id).where("status", "=", "running").executeTakeFirst();
    if (!Number(updated.numUpdatedRows)) return { ok: true, discarded: true };
    await context.db.updateTable("applications").set({
      last_run_status: "failed", last_run_at: completed, updated_at: completed,
    }).where("check_group_id", "=", run.check_group_id ?? run.application_id).execute();
    return { ok: true };
  });

  app.post("/internal/login/:id/ready", async (request) => {
    const id = (request.params as { id: string }).id;
    await context.db.updateTable("login_sessions").set({ status: "ready", updated_at: nowIso() })
      .where("id", "=", id).where("status", "=", "starting").execute();
    return { ok: true };
  });

  app.get("/internal/login/:id/control", async (request) => {
    const id = (request.params as { id: string }).id;
    const row = await context.db.selectFrom("login_sessions").select(["status", "expires_at"]).where("id", "=", id).executeTakeFirst();
    if (!row) throw httpError(404, "Session not found");
    return row;
  });

  app.post("/internal/login/:id/complete", async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { finalUrl: string; browserState: BrowserStateEnvelope };
    const session = await context.db.selectFrom("login_sessions").innerJoin("applications", "applications.id", "login_sessions.application_id")
      .select(["login_sessions.run_id", "login_sessions.application_id", "applications.check_group_id", "applications.site"])
      .where("login_sessions.id", "=", id).executeTakeFirst();
    if (!session) throw httpError(404, "Session not found");
    await saveBrowserState(context, config, session.site, body.browserState);
    let resolvedUrl: string | undefined;
    try {
      if (siteForUrl(body.finalUrl) === session.site) resolvedUrl = body.finalUrl;
    } catch {}
    const completed = nowIso();
    await context.db.transaction().execute(async (trx) => {
      await trx.updateTable("login_sessions").set({
        status: "completed", completed_at: completed, updated_at: completed,
      }).where("id", "=", id).execute();
      await trx.updateTable("runs").set({
        status: "queued",
        trigger: "login_resume",
        started_at: null,
        completed_at: null,
        error_code: null,
        error_message: null,
      }).where("id", "=", session.run_id).execute();
      await trx.updateTable("applications").set({
        ...(resolvedUrl ? { resolved_url: resolvedUrl } : {}),
        last_run_status: "queued",
        updated_at: completed,
      }).where("check_group_id", "=", session.check_group_id).execute();
      if (session.check_group_id && resolvedUrl) {
        await trx.updateTable("check_groups").set({ resolved_url: resolvedUrl, updated_at: completed })
          .where("id", "=", session.check_group_id).execute();
      }
    });
    return { ok: true };
  });

  app.post("/internal/login/:id/fail", async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { message?: string };
    await context.db.updateTable("login_sessions").set({
      status: "failed",
      error_message: body.message?.slice(0, 500) ?? "Login runner failed",
      completed_at: nowIso(),
      updated_at: nowIso(),
    }).where("id", "=", id).execute();
    return { ok: true };
  });
}

export async function exchangeRemoteLogin(
  request: FastifyRequest,
  reply: FastifyReply,
  context: DbContext,
): Promise<void> {
  const id = (request.params as { id: string }).id;
  const token = (request.query as { token?: string }).token;
  if (!token) throw httpError(401, "缺少远程登录令牌");
  const row = await context.db.selectFrom("login_sessions").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row || row.token_used_at || sha(token) !== row.access_token_hash ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      !["starting", "ready", "active"].includes(row.status)) throw httpError(401, "远程登录链接已失效");
  await context.db.updateTable("login_sessions").set({
    token_used_at: nowIso(),
    status: row.status === "ready" ? "active" : row.status,
    updated_at: nowIso(),
  }).where("id", "=", id).execute();
  reply.setCookie("ac_remote", `${id}.${token}`, {
    httpOnly: true,
    sameSite: "strict",
    path: "/vnc",
    maxAge: Math.max(1, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
  });
  return reply.redirect("/vnc/vnc.html?autoconnect=1&resize=scale&path=vnc/websockify");
}

export async function authorizeVncRequest(request: FastifyRequest, context: DbContext): Promise<boolean> {
  const value = request.cookies.ac_remote;
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot < 0) return false;
  const id = value.slice(0, dot);
  const token = value.slice(dot + 1);
  const row = await context.db.selectFrom("login_sessions").select(["access_token_hash", "status", "expires_at"])
    .where("id", "=", id).executeTakeFirst();
  return Boolean(row && sha(token) === row.access_token_hash &&
    new Date(row.expires_at).getTime() > Date.now() &&
    ["starting", "ready", "active", "saving"].includes(row.status));
}
