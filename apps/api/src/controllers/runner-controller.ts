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

export async function registerRunnerController(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { context, config, recognizer: injectedRecognizer, aiDebugStore, runnerHeartbeat } = deps;

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
    const recognizer = injectedRecognizer ?? recognizerFromSettings(settings, config, aiDebugStore);
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
          debugContext: {
            runId: id,
            screenshotTruncated: body.truncated,
          },
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
