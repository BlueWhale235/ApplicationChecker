import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatusRecognizer } from "@application-checker/ai-status";
import { normalizeCheckUrl, normalizeCompany } from "@application-checker/contracts";
import type { Config } from "./config.js";
import { createDb, type DbContext } from "./db.js";
import { registerRoutes } from "./routes.js";
import { cleanupExpiredScreenshots, queueRun } from "./service.js";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function setup(): Promise<{ folder: string; context: DbContext; config: Config }> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "application-checker-"));
  folders.push(folder);
  const screenshotsPath = path.join(folder, "screenshots");
  const context = createDb(path.join(folder, "test.sqlite"));
  const config = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataPath: folder,
    databasePath: path.join(folder, "test.sqlite"),
    screenshotsPath,
    runtimeSettingsPath: path.join(folder, "runtime-settings.json"),
    appBaseUrl: "http://127.0.0.1",
    runnerUrl: "http://runner",
    runnerToken: "test-runner-token-with-at-least-32-bytes",
    stateKey: Buffer.alloc(32, 1),
    upstreamProxyUrl: null,
    aiConfidenceThreshold: 0.75,
    webDistPath: null,
    desktopMode: false,
    desktopSessionToken: null,
  } satisfies Config;
  await context.db.insertInto("applications").values({
    id: "11111111-1111-4111-8111-111111111111",
    company: "示例公司",
    job_title: "产品经理",
    check_url: "https://example.com/status",
    resolved_url: null,
    posting_url: null,
    applied_at: null,
    location: null,
    notes: null,
    site: "example.com",
    progress_status: "screening",
    progress_status_v2: "screening",
    progress_source: null,
    manual_locked: 0,
    automation_paused: 0,
    automation_pause_reason: null,
    automation_paused_at: null,
    schedule_mode: "manual",
    cron_expression: null,
    next_run_at: null,
    last_run_at: null,
    last_run_status: null,
    last_status_changed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }).execute();
  return { folder, context, config };
}

describe("screenshot retention", () => {
  it("migrates an existing settings table to the 30-day default", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "application-checker-migration-"));
    folders.push(folder);
    const filename = path.join(folder, "old.sqlite");
    const old = new DatabaseDriver(filename);
    old.exec("CREATE TABLE app_settings(id INTEGER PRIMARY KEY, global_cron TEXT, timezone TEXT NOT NULL, updated_at TEXT NOT NULL)");
    old.prepare("INSERT INTO app_settings VALUES(1,NULL,'Asia/Shanghai',?)").run(new Date().toISOString());
    old.close();
    const context = createDb(filename);
    const row = await context.db.selectFrom("app_settings").selectAll().executeTakeFirstOrThrow();
    expect(row.screenshot_retention_days).toBe(30);
    expect(row.default_user_agent).toContain("Mozilla/5.0");
    expect(row.ai_confidence_threshold).toBe(0.75);
    await context.db.destroy();
    context.raw.close();
  });

  it("removes only expired files and keeps run history", async () => {
    const { context, config } = await setup();
    const appFolder = path.join(config.screenshotsPath, "11111111-1111-4111-8111-111111111111");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(appFolder, { recursive: true }));
    const oldPath = path.join(appFolder, "old.png");
    const freshPath = path.join(appFolder, "fresh.png");
    await writeFile(oldPath, Buffer.from("old"));
    await writeFile(freshPath, Buffer.from("fresh"));
    const base = {
      application_id: "11111111-1111-4111-8111-111111111111",
      trigger: "manual" as const,
      status: "succeeded" as const,
      final_url: "https://example.com/status",
      page_title: "Status",
      screenshot_truncated: 0,
      ai_status: "skipped" as const,
      ai_suggested_status: null,
      ai_confidence: null,
      ai_evidence: null,
      ai_provider: null,
      error_code: null,
      error_message: null,
      started_at: null,
    };
    await context.db.insertInto("runs").values([
      { ...base, id: "old", screenshot_path: oldPath, created_at: "2026-05-01T00:00:00.000Z", completed_at: "2026-05-01T00:00:00.000Z" },
      { ...base, id: "fresh", screenshot_path: freshPath, created_at: "2026-07-20T00:00:00.000Z", completed_at: "2026-07-20T00:00:00.000Z" },
      { ...base, id: "missing", screenshot_path: path.join(appFolder, "missing.png"), created_at: "2026-05-01T00:00:00.000Z", completed_at: "2026-05-01T00:00:00.000Z" },
    ]).execute();
    const result = await cleanupExpiredScreenshots(context, config, 30, new Date("2026-07-24T00:00:00.000Z"));
    expect(result).toEqual({ deleted: 1, missing: 1, failed: 0 });
    expect(await stat(oldPath).catch(() => null)).toBeNull();
    expect(await readFile(freshPath, "utf8")).toBe("fresh");
    const rows = await context.db.selectFrom("runs").select(["id", "screenshot_path"]).orderBy("id").execute();
    expect(rows.find((row) => row.id === "old")?.screenshot_path).toBeNull();
    expect(rows.find((row) => row.id === "missing")?.screenshot_path).toBeNull();
    expect(rows.find((row) => row.id === "fresh")?.screenshot_path).toBe(freshPath);
    await context.db.destroy();
    context.raw.close();
  });
});

describe("runtime settings and POST action routes", () => {
  it("persists browser and encrypted AI settings to the local runtime file", async () => {
    const { folder, context, config } = await setup();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });

    const settings = await app.inject({
      method: "POST",
      url: "/settings/update",
      payload: {
        globalCron: null,
        timezone: "Asia/Shanghai",
        screenshotRetentionDays: 30,
        defaultUserAgent: "ApplicationChecker-QA/1.0",
      },
    });
    expect(settings.statusCode).toBe(200);

    const ai = await app.inject({
      method: "POST",
      url: "/settings/ai/update",
      payload: {
        baseUrl: "https://api.example.com/v1",
        model: "vision-model",
        apiKey: "secret-test-key",
        confidenceThreshold: 0.8,
      },
    });
    expect(ai.statusCode).toBe(200);
    expect(ai.json()).toMatchObject({ aiConfigured: true, aiApiKeySet: true, aiModel: "vision-model" });

    const runtime = await readFile(path.join(folder, "runtime-settings.json"), "utf8");
    expect(runtime).toContain("ApplicationChecker-QA/1.0");
    expect(runtime).toContain("vision-model");
    expect(runtime).not.toContain("secret-test-key");

    expect((await app.inject({ method: "PATCH", url: "/settings" })).statusCode).toBe(404);
    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("uses POST delete/progress actions and passes the saved User-Agent to Runner", async () => {
    const { context, config } = await setup();
    await context.db.updateTable("app_settings").set({ default_user_agent: "ApplicationChecker-QA/2.0" }).where("id", "=", 1).execute();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });

    const progress = await app.inject({
      method: "POST",
      url: "/applications/11111111-1111-4111-8111-111111111111/progress",
      payload: { status: "interview_pending" },
    });
    expect(progress.statusCode).toBe(200);
    expect((await app.inject({
      method: "PUT",
      url: "/applications/11111111-1111-4111-8111-111111111111/progress",
      payload: { status: "offer" },
    })).statusCode).toBe(404);

    await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual");
    const claim = await app.inject({
      method: "POST",
      url: "/internal/claim",
      headers: { authorization: `Bearer ${config.runnerToken}` },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ kind: "capture", userAgent: "ApplicationChecker-QA/2.0" });

    await app.close();
    await context.db.destroy();
    context.raw.close();
  });
});

describe("task management routes", () => {
  it("applies validated per-application AI results from one group completion", async () => {
    const { context, config } = await setup();
    const recognizeGroup = vi.fn().mockResolvedValue({
      provider: "vision-test",
      results: [{
        applicationId: "11111111-1111-4111-8111-111111111111",
        matched: true,
        rawStatus: "业务筛选-进行中",
        status: "screening_passed",
        confidence: 0.96,
        evidence: "页面显示业务筛选进行中",
      }],
    });
    const recognizer = {
      configured: true,
      model: "vision-test",
      recognize: vi.fn(),
      recognizeGroup,
    } satisfies StatusRecognizer;
    const app = Fastify();
    await registerRoutes(app, { context, config, recognizer, runnerHeartbeat: { at: Date.now() } });
    const runId = await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual");
    await app.inject({
      method: "POST", url: "/internal/claim",
      headers: { authorization: `Bearer ${config.runnerToken}` },
    });
    const complete = await app.inject({
      method: "POST",
      url: `/internal/runs/${runId}/complete`,
      headers: { authorization: `Bearer ${config.runnerToken}` },
      payload: {
        finalUrl: "https://example.com/status",
        pageTitle: "投递记录",
        screenshotBase64: Buffer.from("png").toString("base64"),
        truncated: false,
        browserState: { version: 1, cookies: [], origins: [] },
      },
    });
    expect(complete.statusCode, complete.body).toBe(200);
    expect(recognizeGroup).toHaveBeenCalledTimes(1);
    const detail = (await app.inject({
      method: "GET", url: "/applications/11111111-1111-4111-8111-111111111111",
    })).json();
    expect(detail.application.progressStatus).toBe("screening_passed");
    expect(detail.runs[0].recognitionResults[0]).toMatchObject({
      rawStatus: "业务筛选-进行中", suggestedStatus: "screening_passed", applied: true,
    });
    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("creates one notification when AI rejects an application and keeps automation paused until explicit resume", async () => {
    const { context, config } = await setup();
    const recognizeGroup = vi.fn().mockResolvedValue({
      provider: "vision-test",
      results: [{
        applicationId: "11111111-1111-4111-8111-111111111111",
        matched: true,
        rawStatus: "不合适",
        status: "rejected",
        confidence: 0.98,
        evidence: "页面显示该岗位不合适",
      }],
    });
    const recognizer = {
      configured: true,
      model: "vision-test",
      recognize: vi.fn(),
      recognizeGroup,
    } satisfies StatusRecognizer;
    const app = Fastify();
    await registerRoutes(app, { context, config, recognizer, runnerHeartbeat: { at: Date.now() } });
    const runId = await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual");
    await app.inject({
      method: "POST",
      url: "/internal/claim",
      headers: { authorization: `Bearer ${config.runnerToken}` },
    });
    const complete = await app.inject({
      method: "POST",
      url: `/internal/runs/${runId}/complete`,
      headers: { authorization: `Bearer ${config.runnerToken}` },
      payload: {
        finalUrl: "https://example.com/status",
        pageTitle: "投递记录",
        screenshotBase64: Buffer.from("png").toString("base64"),
        truncated: false,
        browserState: { version: 1, cookies: [], origins: [] },
      },
    });
    expect(complete.statusCode, complete.body).toBe(200);

    const detail = (await app.inject({
      method: "GET",
      url: "/applications/11111111-1111-4111-8111-111111111111",
    })).json();
    expect(detail.application).toMatchObject({
      progressStatus: "rejected",
      automationPaused: true,
      automationPauseReason: "rejected",
      scheduleMode: "manual",
      nextRunAt: null,
    });

    const notifications = await app.inject({ method: "GET", url: "/notifications?scope=unread" });
    expect(notifications.statusCode).toBe(200);
    expect(notifications.json()).toMatchObject({ total: 1 });
    expect(notifications.json().items[0]).toMatchObject({
      applicationId: "11111111-1111-4111-8111-111111111111",
      fromStatus: "screening",
      toStatus: "rejected",
      confidence: 0.98,
      readAt: null,
    });
    expect((await app.inject({ method: "GET", url: "/notifications/unread-count" })).json()).toEqual({ unreadCount: 1 });

    const notificationId = notifications.json().items[0].id as string;
    expect((await app.inject({ method: "POST", url: `/notifications/${notificationId}/read` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/notifications/unread-count" })).json()).toEqual({ unreadCount: 0 });

    expect((await app.inject({
      method: "POST",
      url: "/applications/11111111-1111-4111-8111-111111111111/progress",
      payload: { status: "interviewed" },
    })).statusCode).toBe(200);
    const stillPaused = (await app.inject({
      method: "GET",
      url: "/applications/11111111-1111-4111-8111-111111111111",
    })).json();
    expect(stillPaused.application).toMatchObject({ progressStatus: "interviewed", automationPaused: true });

    const resumed = await app.inject({
      method: "POST",
      url: "/applications/11111111-1111-4111-8111-111111111111/automation/resume",
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json()).toMatchObject({ ok: true });
    const resumedRow = await context.db.selectFrom("applications").select("automation_paused")
      .where("id", "=", "11111111-1111-4111-8111-111111111111").executeTakeFirstOrThrow();
    expect(resumedRow.automation_paused).toBe(0);

    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("pauses manual rejection without creating a notification", async () => {
    const { context, config } = await setup();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const progress = await app.inject({
      method: "POST",
      url: "/applications/11111111-1111-4111-8111-111111111111/progress",
      payload: { status: "rejected" },
    });
    expect(progress.statusCode).toBe(200);
    const row = await context.db.selectFrom("applications")
      .select(["progress_status_v2", "automation_paused"])
      .where("id", "=", "11111111-1111-4111-8111-111111111111")
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ progress_status_v2: "rejected", automation_paused: 1 });
    expect((await app.inject({ method: "GET", url: "/notifications" })).json()).toMatchObject({ total: 0 });
    expect((await app.inject({
      method: "POST",
      url: "/applications/11111111-1111-4111-8111-111111111111/automation/resume",
    })).statusCode).toBe(409);
    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("groups normalized company and URL into one shared run and plan", async () => {
    const { context, config } = await setup();
    const seedRun = await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual");
    await context.db.updateTable("runs").set({ status: "cancelled", completed_at: new Date().toISOString() })
      .where("id", "=", seedRun!).execute();
    const seed = await context.db.selectFrom("applications").selectAll()
      .where("id", "=", "11111111-1111-4111-8111-111111111111").executeTakeFirstOrThrow();
    expect(normalizeCompany("  示例公司 ")).toBe(normalizeCompany(seed.company));
    expect(normalizeCheckUrl("https://EXAMPLE.com:443/status/")).toBe(normalizeCheckUrl(seed.check_url));
    const secondId = "22222222-2222-4222-8222-222222222222";
    await context.db.insertInto("applications").values({
      ...seed,
      id: secondId,
      job_title: "销售经理",
      created_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    }).execute();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const detail = await app.inject({ method: "GET", url: `/applications/${secondId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().checkGroup.memberCount).toBe(2);
    const firstRun = await app.inject({ method: "POST", url: `/applications/${secondId}/runs` });
    expect(firstRun.statusCode).toBe(202);
    expect((await app.inject({
      method: "POST", url: "/applications/11111111-1111-4111-8111-111111111111/runs",
    })).statusCode).toBe(409);
    const activeRuns = await context.db.selectFrom("runs").selectAll().where("status", "=", "queued").execute();
    expect(activeRuns).toHaveLength(1);
    expect(await context.db.selectFrom("run_application_results").selectAll()
      .where("run_id", "=", activeRuns[0]!.id).execute()).toHaveLength(2);
    const plan = await app.inject({
      method: "POST",
      url: `/applications/${secondId}/check-plan/update`,
      payload: { scheduleMode: "custom", cronExpression: "0 9 * * *" },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({ affected: 2, checkGroup: { scheduleMode: "custom", memberCount: 2 } });
    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("lists, cancels and retries tasks without removing history", async () => {
    const { context, config } = await setup();
    const app = Fastify();
    const recognizer = { configured: false, model: null } as unknown as StatusRecognizer;
    await registerRoutes(app, { context, config, recognizer, runnerHeartbeat: { at: Date.now() } });
    const runId = await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual");
    expect(runId).toBeTruthy();
    const active = await app.inject({ method: "GET", url: "/runs?scope=active" });
    expect(active.statusCode).toBe(200);
    expect(active.json().items[0]).toMatchObject({ id: runId, company: "示例公司", status: "queued" });
    expect((await app.inject({ method: "POST", url: `/runs/${runId}/cancel` })).statusCode).toBe(200);
    const history = await app.inject({ method: "GET", url: "/runs?scope=history" });
    expect(history.json().items[0]).toMatchObject({ id: runId, status: "cancelled" });
    const retry = await app.inject({ method: "POST", url: `/runs/${runId}/retry` });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().runId).not.toBe(runId);
    expect((await app.inject({ method: "POST", url: `/runs/${runId}/retry` })).statusCode).toBe(409);
    expect(await context.db.selectFrom("runs").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow())
      .toEqual({ count: 2 });
    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("records email applications without a URL and adds the applied date to the timeline", async () => {
    const { context, config } = await setup();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const created = await app.inject({
      method: "POST",
      url: "/applications",
      payload: {
        company: "邮件投递公司",
        jobTitle: "客户经理",
        appliedAt: "2026-07-20",
        scheduleMode: "inherit",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      checkUrl: null,
      site: "manual",
      scheduleMode: "manual",
      nextRunAt: null,
    });
    const id = created.json().id as string;
    const detail = await app.inject({ method: "GET", url: `/applications/${id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().statusEvents[0]).toMatchObject({
      eventType: "applied",
      note: "投递",
      toStatus: "unset",
    });
    expect(new Date(detail.json().statusEvents[0].createdAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }))
      .toBe("2026/7/20");
    const run = await app.inject({ method: "POST", url: `/applications/${id}/runs` });
    expect(run.statusCode).toBe(400);
    expect(await context.db.selectFrom("runs").selectAll().where("application_id", "=", id).execute()).toHaveLength(0);
    await app.close();
    await context.db.destroy();
    context.raw.close();
    const reopened = createDb(config.databasePath);
    const reopenedApplication = await reopened.db.selectFrom("applications")
      .innerJoin("check_groups", "check_groups.id", "applications.check_group_id")
      .select(["applications.id", "check_groups.normalized_url"])
      .where("applications.id", "=", id)
      .executeTakeFirstOrThrow();
    expect(reopenedApplication.normalized_url).toBe(`manual:${id}`);
    await reopened.db.destroy();
    reopened.raw.close();
  });
});
