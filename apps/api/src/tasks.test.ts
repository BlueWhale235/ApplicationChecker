import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { appSettings, cleanupExpiredScreenshots, queueRun, updateAppSettings } from "./service.js";
import { AiDebugStore } from "./ai-debug.js";
import { RecognitionPreviewStore } from "./recognition-preview.js";
import { recoverInterruptedWork } from "./startup-recovery.js";

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
    logsPath: path.join(folder, "logs"),
    browserCachePath: path.join(folder, "browser", "cache"),
    tempPath: path.join(folder, "tmp"),
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
    debugTools: false,
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
    const row = await appSettings(context);
    expect(row.check_concurrency).toBe(1);
    expect(row.screenshot_retention_days).toBe(30);
    expect(row.default_user_agent).toContain("Mozilla/5.0");
    expect(row.ai_confidence_threshold).toBe(0.75);
    expect(row.ai_deep_thinking).toBe(0);
    await context.db.destroy();
    context.raw.close();
  });

  it("keeps the precise v2 application status while removing the legacy status column", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "application-checker-progress-migration-"));
    folders.push(folder);
    const filename = path.join(folder, "old.sqlite");
    const initial = createDb(filename);
    const now = new Date().toISOString();
    initial.raw.prepare(`
      INSERT INTO applications(
        id,company,job_title,check_url,site,progress_status,manual_locked,schedule_mode,created_at,updated_at
      ) VALUES(?,?,?,?,?,'screening_passed',0,'manual',?,?)
    `).run("legacy-progress", "迁移公司", "迁移岗位", "https://example.com/status", "example.com", now, now);
    initial.raw.exec(`
      ALTER TABLE applications RENAME COLUMN progress_status TO progress_status_v2;
      ALTER TABLE applications ADD COLUMN progress_status TEXT NOT NULL DEFAULT 'unset'
        CHECK(progress_status IN ('unset','screening','interview_pending','interview_result_pending','signing_pending','offer','rejected'));
      UPDATE applications SET progress_status = 'screening';
    `);
    await initial.db.destroy();
    initial.raw.close();

    const migrated = createDb(filename);
    const columns = migrated.raw.prepare("PRAGMA table_info(applications)").all() as Array<{ name: string; notnull: number }>;
    expect(columns.filter((column) => column.name.startsWith("progress_status"))).toEqual([
      expect.objectContaining({ name: "progress_status", notnull: 1 }),
    ]);
    expect(migrated.raw.prepare("SELECT progress_status FROM applications WHERE id = ?").get("legacy-progress"))
      .toEqual({ progress_status: "screening_passed" });
    expect(migrated.raw.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.raw.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    await expect(migrated.db.updateTable("applications").set({ progress_status: "interviewed" }).where("id", "=", "legacy-progress").execute())
      .resolves.toBeDefined();
    await migrated.db.destroy();
    migrated.raw.close();
  });

  it("migrates run statuses and script result reasons without losing rows", async () => {
    const { context, config } = await setup();
    const runId = await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual");
    await context.db.updateTable("runs").set({ status: "cancelled", completed_at: new Date().toISOString() }).where("id", "=", runId!).execute();
    const before = {
      runs: Number((context.raw.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count),
      results: Number((context.raw.prepare("SELECT COUNT(*) count FROM run_application_results").get() as { count: number }).count),
    };
    context.raw.pragma("foreign_keys = OFF");
    context.raw.exec(`
      BEGIN;
      CREATE TABLE runs_legacy (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK(trigger IN ('manual','bulk','cron','login_resume')),
        status TEXT NOT NULL CHECK(status IN ('queued','running','needs_login','succeeded','failed','cancelled')),
        final_url TEXT, page_title TEXT, screenshot_path TEXT, screenshot_truncated INTEGER NOT NULL DEFAULT 0,
        ai_status TEXT NOT NULL DEFAULT 'skipped' CHECK(ai_status IN ('skipped','pending','succeeded','failed')),
        ai_suggested_status TEXT, ai_confidence REAL, ai_evidence TEXT, ai_provider TEXT,
        error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
        check_group_id TEXT, ai_suggested_status_v2 TEXT,
        recognition_mode TEXT NOT NULL DEFAULT 'local_first', recognition_status TEXT NOT NULL DEFAULT 'skipped',
        recognition_source TEXT, recognition_suggested_status_v2 TEXT, recognition_confidence REAL,
        recognition_evidence TEXT, recognition_provider TEXT
      );
      INSERT INTO runs_legacy (
        id, application_id, trigger, status, final_url, page_title, screenshot_path, screenshot_truncated,
        ai_status, ai_suggested_status, ai_confidence, ai_evidence, ai_provider, error_code, error_message,
        created_at, started_at, completed_at, check_group_id, ai_suggested_status_v2, recognition_mode,
        recognition_status, recognition_source, recognition_suggested_status_v2, recognition_confidence,
        recognition_evidence, recognition_provider
      ) SELECT
        id, application_id, trigger, status, final_url, page_title, screenshot_path, screenshot_truncated,
        ai_status, ai_suggested_status, ai_confidence, ai_evidence, ai_provider, error_code, error_message,
        created_at, started_at, completed_at, check_group_id, ai_suggested_status_v2, recognition_mode,
        recognition_status, recognition_source, recognition_suggested_status_v2, recognition_confidence,
        recognition_evidence, recognition_provider
      FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_legacy RENAME TO runs;
      CREATE UNIQUE INDEX runs_one_active_per_application ON runs(application_id) WHERE status IN ('queued','running','needs_login');
      CREATE INDEX runs_application_created ON runs(application_id, created_at DESC);

      CREATE TABLE run_application_results_legacy (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        job_title_snapshot TEXT NOT NULL, matched INTEGER NOT NULL DEFAULT 0, raw_status TEXT,
        suggested_status TEXT, confidence REAL, evidence TEXT, applied INTEGER NOT NULL DEFAULT 0,
        not_applied_reason TEXT CHECK(not_applied_reason IN ('manual_locked','low_confidence','unmatched','ai_failed')),
        created_at TEXT NOT NULL, automation_paused INTEGER NOT NULL DEFAULT 0,
        recognition_source TEXT, adapter_id TEXT, rule_version TEXT, UNIQUE(run_id, application_id)
      );
      INSERT INTO run_application_results_legacy (
        id, run_id, application_id, job_title_snapshot, matched, raw_status, suggested_status, confidence,
        evidence, applied, not_applied_reason, created_at, automation_paused, recognition_source, adapter_id, rule_version
      ) SELECT
        id, run_id, application_id, job_title_snapshot, matched, raw_status, suggested_status, confidence,
        evidence, applied, not_applied_reason, created_at, automation_paused, recognition_source, adapter_id, rule_version
      FROM run_application_results;
      DROP TABLE run_application_results;
      ALTER TABLE run_application_results_legacy RENAME TO run_application_results;
      CREATE INDEX run_results_application ON run_application_results(application_id, created_at DESC);
      COMMIT;
    `);
    context.raw.pragma("foreign_keys = ON");
    await context.db.destroy(); context.raw.close();
    const reopened = createDb(config.databasePath);
    const runsSql = (reopened.raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'").get() as { sql: string }).sql;
    const resultsSql = (reopened.raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_application_results'").get() as { sql: string }).sql;
    expect(runsSql).toContain("'partial'");
    expect(resultsSql).toContain("'script_error'");
    expect(resultsSql).toContain("'script_skipped'");
    expect(reopened.raw.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(Number((reopened.raw.prepare("SELECT COUNT(*) count FROM runs").get() as { count: number }).count)).toBe(before.runs);
    expect(Number((reopened.raw.prepare("SELECT COUNT(*) count FROM run_application_results").get() as { count: number }).count)).toBe(before.results);
    await reopened.db.destroy(); reopened.raw.close();
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
  it("reports and clears browser storage only while no task is active", async () => {
    const { context, config } = await setup();
    await mkdir(path.join(config.browserCachePath, "Cache"), { recursive: true });
    await mkdir(config.tempPath, { recursive: true });
    await mkdir(config.logsPath, { recursive: true });
    await writeFile(path.join(config.browserCachePath, "Cache", "asset.js"), "12345");
    await writeFile(path.join(config.tempPath, "edge.tmp"), "1234");
    await writeFile(path.join(config.logsPath, "api.log"), "warning");
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });

    const usage = await app.inject({ method: "GET", url: "/settings/browser-storage" });
    expect(usage.statusCode, usage.body).toBe(200);
    expect(usage.json()).toEqual({ cacheBytes: 5, tempBytes: 4, logBytes: 7 });

    const cleared = await app.inject({ method: "POST", url: "/settings/browser-storage/cache/clear" });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ kind: "cache", beforeBytes: 5, afterBytes: 0, freedBytes: 5, failed: 0 });

    expect(await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual")).toBeTruthy();
    const blocked = await app.inject({ method: "POST", url: "/settings/browser-storage/temp/clear" });
    expect(blocked.statusCode).toBe(409);
    expect(await stat(path.join(config.tempPath, "edge.tmp"))).toBeTruthy();
    const logsCleared = await app.inject({ method: "POST", url: "/settings/browser-storage/logs/clear" });
    expect(logsCleared.statusCode, logsCleared.body).toBe(200);
    expect(logsCleared.json()).toMatchObject({ kind: "logs", beforeBytes: 7, afterBytes: 0, freedBytes: 7, failed: 0 });
    expect((await stat(path.join(config.logsPath, "api.log"))).size).toBe(0);

    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("requeues interrupted runs and closes orphaned login sessions on startup", async () => {
    const { context } = await setup();
    const runId = await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual");
    expect(runId).toBeTruthy();
    await context.db.updateTable("runs").set({
      status: "running",
      started_at: "2026-07-31T03:10:32.171Z",
    }).where("id", "=", runId!).execute();
    await context.db.updateTable("applications").set({ last_run_status: "running" })
      .where("id", "=", "11111111-1111-4111-8111-111111111111").execute();
    await context.db.insertInto("login_sessions").values({
      id: "22222222-2222-4222-8222-222222222222",
      application_id: "11111111-1111-4111-8111-111111111111",
      run_id: runId!,
      status: "active",
      access_token_hash: "hash",
      token_used_at: "2026-07-31T03:10:35.000Z",
      expires_at: "2026-07-31T04:10:35.000Z",
      error_message: null,
      created_at: "2026-07-31T03:10:35.000Z",
      updated_at: "2026-07-31T03:10:35.000Z",
      completed_at: null,
    }).execute();

    expect(await recoverInterruptedWork(context)).toEqual({
      runsRequeued: 1,
      loginSessionsFailed: 1,
      applicationStatusesRepaired: 0,
    });
    expect(await context.db.selectFrom("runs").select(["status", "started_at", "error_code"])
      .where("id", "=", runId!).executeTakeFirst()).toMatchObject({
      status: "queued",
      started_at: null,
      error_code: "RECOVERED_AFTER_RESTART",
    });
    expect(await context.db.selectFrom("applications").select("last_run_status")
      .where("id", "=", "11111111-1111-4111-8111-111111111111").executeTakeFirst())
      .toEqual({ last_run_status: "queued" });
    expect(await context.db.selectFrom("login_sessions").select(["status", "completed_at"])
      .where("id", "=", "22222222-2222-4222-8222-222222222222").executeTakeFirst())
      .toMatchObject({ status: "failed", completed_at: expect.any(String) });

    await context.db.deleteFrom("runs").where("id", "=", runId!).execute();
    expect(await recoverInterruptedWork(context)).toEqual({
      runsRequeued: 0,
      loginSessionsFailed: 0,
      applicationStatusesRepaired: 1,
    });
    expect(await context.db.selectFrom("applications").select(["last_run_status", "last_run_at"])
      .where("id", "=", "11111111-1111-4111-8111-111111111111").executeTakeFirst())
      .toEqual({ last_run_status: null, last_run_at: null });

    await context.db.destroy();
    context.raw.close();
  });

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
        checkConcurrency: 3,
        screenshotRetentionDays: 30,
        defaultUserAgent: "ApplicationChecker-QA/1.0",
      },
    });
    expect(settings.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/settings" })).json().checkConcurrency).toBe(3);

    const legacySettings = await app.inject({
      method: "POST",
      url: "/settings/update",
      payload: {
        globalCron: null,
        timezone: "Asia/Shanghai",
        screenshotRetentionDays: 30,
        defaultUserAgent: "ApplicationChecker-QA/1.0",
      },
    });
    expect(legacySettings.statusCode).toBe(200);
    expect((await appSettings(context)).check_concurrency).toBe(3);

    const ai = await app.inject({
      method: "POST",
      url: "/settings/ai/update",
      payload: {
        baseUrl: "https://api.example.com/v1",
        model: "vision-model",
        apiKey: "secret-test-key",
        confidenceThreshold: 0.8,
        deepThinking: true,
      },
    });
    expect(ai.statusCode).toBe(200);
    expect(ai.json()).toMatchObject({
      aiConfigured: true,
      aiApiKeySet: true,
      aiModel: "vision-model",
      aiDeepThinking: true,
    });

    const runtime = await readFile(path.join(folder, "runtime-settings.json"), "utf8");
    expect(runtime).toContain("ApplicationChecker-QA/1.0");
    expect(runtime).toContain("vision-model");
    expect(runtime).toContain('"deepThinking": true');
    expect(runtime).not.toContain("secret-test-key");

    expect((await app.inject({ method: "PATCH", url: "/settings" })).statusCode).toBe(404);
    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("uses POST delete/progress actions and passes the saved User-Agent to Runner", async () => {
    const { context, config } = await setup();
    updateAppSettings(context, { default_user_agent: "ApplicationChecker-QA/2.0" });
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
  it("applies normal script results while keeping controlled error jobs unchanged", async () => {
    const { context, config } = await setup();
    const seedRunId = await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual");
    await context.db.updateTable("runs").set({ status: "cancelled", completed_at: new Date().toISOString() })
      .where("id", "=", seedRunId!).execute();
    const first = await context.db.selectFrom("applications").selectAll()
      .where("id", "=", "11111111-1111-4111-8111-111111111111").executeTakeFirstOrThrow();
    const secondId = "22222222-2222-4222-8222-222222222222";
    await context.db.insertInto("applications").values({
      ...first, id: secondId, check_group_id: first.check_group_id, job_title: "销售工程师", progress_status: "screening",
      created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
    }).execute();
    const app = Fastify();
    await registerRoutes(app, { context, config, recognizer: { configured: false, model: null } as StatusRecognizer, runnerHeartbeat: { at: Date.now() } });
    const runId = await queueRun(context, first.id, "manual");
    await app.inject({ method: "POST", url: "/internal/claim", headers: { authorization: `Bearer ${config.runnerToken}` } });
    const complete = await app.inject({
      method: "POST", url: `/internal/runs/${runId}/complete`, headers: { authorization: `Bearer ${config.runnerToken}` },
      payload: {
        finalUrl: first.check_url, pageTitle: "投递记录", screenshotBase64: Buffer.from("png").toString("base64"), truncated: false,
        browserState: { version: 1, cookies: [], origins: [] },
        scriptExecution: {
          ruleId: "controlled-error", ruleVersion: 1, durationMs: 5, logs: [], logsTruncated: false,
          results: [
            { applicationId: first.id, rawStatus: "已过初筛", directStatus: "screening_passed" },
            { applicationId: secondId, rawStatus: "script_error", error: "查询接口没有返回该岗位", errorLine: 8, evidence: "查询接口没有返回该岗位" },
          ],
        },
      },
    });
    expect(complete.statusCode, complete.body).toBe(200);
    expect(await context.db.selectFrom("runs").select(["status", "error_code"]).where("id", "=", runId!).executeTakeFirstOrThrow())
      .toEqual({ status: "partial", error_code: "SCRIPT_RULE_ERROR" });
    expect(await context.db.selectFrom("applications").select(["id", "progress_status", "last_run_status"])
      .where("id", "in", [first.id, secondId]).orderBy("id").execute()).toEqual([
      { id: first.id, progress_status: "screening_passed", last_run_status: "succeeded" },
      { id: secondId, progress_status: "screening", last_run_status: "failed" },
    ]);
    const notifications = await context.db.selectFrom("notifications").select(["application_id", "kind", "evidence"]).execute();
    expect(notifications.some((item) => item.application_id === secondId && item.kind === "recognition_failed" && item.evidence?.includes("Line:8"))).toBe(true);
    expect((await app.inject({ method: "POST", url: `/runs/${runId}/retry` })).statusCode).toBe(202);
    await app.close(); await context.db.destroy(); context.raw.close();
  });

  it("applies direct script progress and needs-login statuses", async () => {
    const { context, config } = await setup();
    const recognizer = {
      configured: false,
      model: null,
      recognize: vi.fn(),
    } satisfies StatusRecognizer;
    const app = Fastify();
    await registerRoutes(app, { context, config, recognizer, runnerHeartbeat: { at: Date.now() } });
    const applicationId = "11111111-1111-4111-8111-111111111111";
    const runId = await queueRun(context, applicationId, "manual");
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
        scriptExecution: {
          ruleId: "direct-rule", ruleVersion: 1, durationMs: 5,
          results: [{ applicationId, rawStatus: "未设置", directStatus: "unset", evidence: "脚本直接判定" }],
          logs: [], logsTruncated: false,
        },
      },
    });
    expect(complete.statusCode, complete.body).toBe(200);
    const application = await context.db.selectFrom("applications")
      .select(["progress_status", "last_run_status"])
      .where("id", "=", applicationId).executeTakeFirstOrThrow();
    expect(application).toEqual({ progress_status: "unset", last_run_status: "succeeded" });
    const result = await context.db.selectFrom("run_application_results")
      .select(["matched", "suggested_status", "applied"])
      .where("run_id", "=", runId!).executeTakeFirstOrThrow();
    expect(result).toEqual({ matched: 1, suggested_status: "unset", applied: 1 });

    const loginRunId = await queueRun(context, applicationId, "manual");
    await app.inject({
      method: "POST", url: "/internal/claim",
      headers: { authorization: `Bearer ${config.runnerToken}` },
    });
    const loginComplete = await app.inject({
      method: "POST",
      url: `/internal/runs/${loginRunId}/complete`,
      headers: { authorization: `Bearer ${config.runnerToken}` },
      payload: {
        finalUrl: "https://example.com/login",
        pageTitle: "账号登录",
        screenshotBase64: Buffer.from("png").toString("base64"),
        truncated: false,
        browserState: { version: 1, cookies: [], origins: [] },
        scriptExecution: {
          ruleId: "login-rule", ruleVersion: 1, durationMs: 5,
          results: [{ applicationId, rawStatus: "login_required", directStatus: "needs_login", evidence: "登录状态过期" }],
          logs: [], logsTruncated: false,
        },
      },
    });
    expect(loginComplete.json()).toEqual({ ok: true, needsLogin: true });
    const loginRun = await context.db.selectFrom("runs").select("status")
      .where("id", "=", loginRunId!).executeTakeFirstOrThrow();
    expect(loginRun.status).toBe("needs_login");
    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

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
      kind: "progress",
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

  it("notifies the user when recognition returns no matching status", async () => {
    const { context, config } = await setup();
    const recognizer = {
      configured: true,
      model: "vision-test",
      recognize: vi.fn(),
      recognizeGroup: vi.fn().mockResolvedValue({
        provider: "vision-test",
        results: [{
          applicationId: "11111111-1111-4111-8111-111111111111",
          matched: false,
          rawStatus: null,
          status: null,
          confidence: 0,
          evidence: "页面中没有找到该岗位的状态",
        }],
      }),
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
    const notifications = (await app.inject({ method: "GET", url: "/notifications" })).json();
    expect(notifications).toMatchObject({
      total: 1,
      unreadCount: 1,
      items: [{
        kind: "recognition_unmatched",
        applicationId: "11111111-1111-4111-8111-111111111111",
        statusEventId: null,
        fromStatus: "screening",
        toStatus: "screening",
      }],
    });
    expect(notifications.items[0].evidence).toContain("未命中岗位状态");
    expect(await context.db.selectFrom("status_events").select("id").execute()).toHaveLength(0);
    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("keeps the current status and notifies when AI identifies a non-application page after local fallback", async () => {
    const { context, config } = await setup();
    await context.db.updateTable("applications").set({ manual_locked: 1 })
      .where("id", "=", "11111111-1111-4111-8111-111111111111").execute();
    const recognizer = {
      configured: true,
      model: "vision-test",
      recognize: vi.fn(),
      recognizeGroup: vi.fn().mockResolvedValue({
        provider: "vision-test",
        results: [{
          applicationId: "11111111-1111-4111-8111-111111111111",
          matched: false,
          rawStatus: "official_homepage",
          status: null,
          confidence: 1,
          evidence: "公司招聘官网首页，无个人投递记录",
        }],
      }),
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
        pageTitle: "公司招聘官网",
        screenshotBase64: Buffer.from("png").toString("base64"),
        truncated: false,
        browserState: { version: 1, cookies: [], origins: [] },
        pageSnapshot: {
          url: "https://example.com/status",
          title: "公司招聘官网",
          language: "zh-CN",
          visibleText: "欢迎访问公司招聘官网",
          nodes: [],
          truncated: false,
          nodeLimitReached: false,
          textLimitReached: false,
        },
      },
    });
    expect(complete.statusCode, complete.body).toBe(200);
    expect(recognizer.recognizeGroup).toHaveBeenCalledTimes(1);

    const result = await context.db.selectFrom("run_application_results")
      .select(["matched", "suggested_status", "confidence", "applied", "not_applied_reason", "recognition_source"])
      .where("run_id", "=", runId!).executeTakeFirstOrThrow();
    expect(result).toEqual({
      matched: 0,
      suggested_status: null,
      confidence: 1,
      applied: 0,
      not_applied_reason: "unmatched",
      recognition_source: "ai",
    });
    const notifications = (await app.inject({ method: "GET", url: "/notifications" })).json();
    expect(notifications).toMatchObject({
      total: 1,
      unreadCount: 1,
      items: [{
        kind: "recognition_unmatched",
        applicationId: "11111111-1111-4111-8111-111111111111",
        confidence: 1,
      }],
    });
    expect(notifications.items[0].evidence).toContain("公司招聘官网首页，无个人投递记录");
    const detail = (await app.inject({ method: "GET", url: `/applications/11111111-1111-4111-8111-111111111111` })).json();
    expect(detail.application).toMatchObject({ progressStatus: "screening" });
    expect(detail.runs[0]).toMatchObject({
      recognitionSuggestedStatus: null,
      recognitionConfidence: null,
      recognitionResults: [{ matched: false, suggestedStatus: null, notAppliedReason: "unmatched" }],
    });

    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("moves the run to needs_login when AI emits the login_required rule", async () => {
    const { context, config } = await setup();
    const recognizer = {
      configured: true,
      model: "vision-test",
      recognize: vi.fn(),
      recognizeGroup: vi.fn().mockResolvedValue({
        provider: "vision-test",
        results: [{
          applicationId: "11111111-1111-4111-8111-111111111111",
          matched: false,
          rawStatus: "login_required",
          status: null,
          confidence: 1,
          evidence: "页面要求登录后查看投递记录",
        }],
      }),
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
        finalUrl: "https://example.com/login",
        pageTitle: "账号登录",
        screenshotBase64: Buffer.from("png").toString("base64"),
        truncated: false,
        browserState: { version: 1, cookies: [], origins: [] },
      },
    });
    expect(complete.statusCode, complete.body).toBe(200);
    expect(complete.json()).toEqual({ ok: true, needsLogin: true });

    const run = await context.db.selectFrom("runs")
      .select(["status", "error_code", "error_message", "recognition_status", "recognition_source"])
      .where("id", "=", runId!).executeTakeFirstOrThrow();
    expect(run).toMatchObject({
      status: "needs_login",
      error_code: "LOGIN_REQUIRED",
      error_message: "页面要求登录后查看投递记录",
      recognition_status: "succeeded",
      recognition_source: "ai",
    });
    const application = await context.db.selectFrom("applications")
      .select(["progress_status", "last_run_status"])
      .where("id", "=", "11111111-1111-4111-8111-111111111111").executeTakeFirstOrThrow();
    expect(application).toEqual({ progress_status: "screening", last_run_status: "needs_login" });
    const result = await context.db.selectFrom("run_application_results")
      .select(["matched", "raw_status", "suggested_status", "applied", "not_applied_reason"])
      .where("run_id", "=", runId!).executeTakeFirstOrThrow();
    expect(result).toEqual({
      matched: 0,
      raw_status: "login_required",
      suggested_status: null,
      applied: 0,
      not_applied_reason: "unmatched",
    });
    expect(await context.db.selectFrom("notifications").select("id").execute()).toHaveLength(0);

    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("notifies every affected application when page capture or recognition fails", async () => {
    const { context, config } = await setup();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const runId = await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual");
    await app.inject({
      method: "POST", url: "/internal/claim",
      headers: { authorization: `Bearer ${config.runnerToken}` },
    });
    const failed = await app.inject({
      method: "POST",
      url: `/internal/runs/${runId}/fail`,
      headers: { authorization: `Bearer ${config.runnerToken}` },
      payload: { code: "CAPTURE_FAILED", message: "页面执行上下文已销毁" },
    });
    expect(failed.statusCode, failed.body).toBe(200);
    const notifications = (await app.inject({ method: "GET", url: "/notifications" })).json();
    expect(notifications).toMatchObject({
      total: 1,
      items: [{
        kind: "recognition_failed",
        statusEventId: null,
        fromStatus: "screening",
        toStatus: "screening",
      }],
    });
    expect(notifications.items[0].evidence).toContain("页面执行上下文已销毁");
    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("creates a failure notification when the AI recognizer throws", async () => {
    const { context, config } = await setup();
    const recognizer = {
      configured: true,
      model: "vision-test",
      recognize: vi.fn(),
      recognizeGroup: vi.fn().mockRejectedValue(new Error("AI 服务暂时不可用")),
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
    const notifications = (await app.inject({ method: "GET", url: "/notifications" })).json();
    expect(notifications).toMatchObject({
      total: 1,
      items: [{
        kind: "recognition_failed",
        statusEventId: null,
        fromStatus: "screening",
        toStatus: "screening",
      }],
    });
    expect(notifications.items[0].evidence).toContain("AI 服务暂时不可用");
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
      .select(["progress_status", "automation_paused"])
      .where("id", "=", "11111111-1111-4111-8111-111111111111")
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ progress_status: "rejected", automation_paused: 1 });
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
    const editedPlan = await app.inject({
      method: "POST",
      url: `/applications/${secondId}/update`,
      payload: { scheduleMode: "inherit", cronExpression: null },
    });
    expect(editedPlan.statusCode, editedPlan.body).toBe(200);
    expect(editedPlan.json()).toMatchObject({ scheduleMode: "inherit", cronExpression: null });
    expect(await context.db.selectFrom("applications").select(["schedule_mode", "cron_expression"])
      .where("check_group_id", "=", seed.check_group_id).execute()).toEqual([
      { schedule_mode: "inherit", cron_expression: null },
      { schedule_mode: "inherit", cron_expression: null },
    ]);
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

  it("paginates active tasks with live work first and reports counts for the full result set", async () => {
    const { context, config } = await setup();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const runs: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      const created = await app.inject({
        method: "POST",
        url: "/applications",
        payload: {
          company: `分页公司${index}`,
          jobTitle: `岗位${index}`,
          checkUrl: `https://example.com/status/${index}`,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const runId = await queueRun(context, created.json().id as string, "manual");
      expect(runId).toBeTruthy();
      runs.push(runId!);
      await context.db.updateTable("runs").set({
        created_at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      }).where("id", "=", runId!).execute();
    }
    await context.db.updateTable("runs").set({
      status: "running",
      started_at: "2026-01-01T00:01:00.000Z",
    }).where("id", "=", runs[23]!).execute();
    await context.db.updateTable("runs").set({
      status: "needs_login",
      completed_at: "2026-01-01T00:01:01.000Z",
    }).where("id", "=", runs[22]!).execute();

    const first = await app.inject({ method: "GET", url: "/runs?scope=active&limit=20&offset=0" });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      total: 24,
      limit: 20,
      offset: 0,
      statusCounts: { running: 1, queued: 22, needsLogin: 1 },
    });
    expect(first.json().items).toHaveLength(20);
    expect(first.json().items[0]).toMatchObject({ id: runs[23], status: "running" });
    expect(first.json().items[1]).toMatchObject({ id: runs[0], status: "queued" });

    const second = await app.inject({ method: "GET", url: "/runs?scope=active&limit=20&offset=20" });
    expect(second.json().items).toHaveLength(4);
    expect(second.json().items.at(-1)).toMatchObject({ id: runs[22], status: "needs_login" });

    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("clears every notification while preserving status events", async () => {
    const { context, config } = await setup();
    await context.db.insertInto("status_events").values({
      id: "event-clear",
      application_id: "11111111-1111-4111-8111-111111111111",
      run_id: null,
      from_status: "screening",
      to_status: "screening_passed",
      source: "ai",
      confidence: 0.9,
      evidence: "业务筛选",
      note: "业务筛选",
      event_type: "progress",
      created_at: new Date().toISOString(),
    }).execute();
    await context.db.insertInto("notifications").values({
      id: "notification-clear",
      application_id: "11111111-1111-4111-8111-111111111111",
      run_id: null,
      status_event_id: "event-clear",
      company_snapshot: "示例公司",
      job_title_snapshot: "产品经理",
      from_status: "screening",
      to_status: "screening_passed",
      confidence: 0.9,
      evidence: "业务筛选",
      read_at: null,
      created_at: new Date().toISOString(),
    }).execute();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const cleared = await app.inject({ method: "POST", url: "/notifications/delete-all" });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ deleted: 1 });
    expect((await app.inject({ method: "GET", url: "/notifications" })).json()).toMatchObject({ total: 0 });
    expect(await context.db.selectFrom("status_events").select("id").where("id", "=", "event-clear").executeTakeFirst())
      .toEqual({ id: "event-clear" });
    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("deletes all finished tasks, screenshots and matching debug traces but keeps active tasks", async () => {
    const { context, config } = await setup();
    const finishedId = await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual");
    const screenshotPath = path.join(config.screenshotsPath, "groups", "test", `${finishedId}.png`);
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, Buffer.from("png"));
    await context.db.updateTable("runs").set({
      status: "cancelled",
      completed_at: new Date().toISOString(),
      screenshot_path: screenshotPath,
    }).where("id", "=", finishedId!).execute();
    const activeId = await queueRun(context, "11111111-1111-4111-8111-111111111111", "manual");
    const aiDebugStore = new AiDebugStore();
    aiDebugStore.start({
      runId: finishedId!,
      endpoint: "https://api.example/v1/chat/completions",
      model: "vision",
      company: "示例公司",
      applications: [],
      pageTitle: null,
      finalUrl: null,
      systemPrompt: "规则",
      userPrompt: "输入",
      screenshotBytes: 3,
      screenshotTruncated: false,
    });
    const app = Fastify();
    await registerRoutes(app, { context, config, aiDebugStore, runnerHeartbeat: { at: Date.now() } });
    const cleared = await app.inject({ method: "POST", url: "/runs/history/delete-all" });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ deleted: 1, screenshotsDeleted: 1, screenshotsFailed: 0 });
    expect(await stat(screenshotPath).catch(() => null)).toBeNull();
    expect(await context.db.selectFrom("runs").select("id").where("id", "=", finishedId!).executeTakeFirst()).toBeUndefined();
    expect(await context.db.selectFrom("runs").select("id").where("id", "=", activeId!).executeTakeFirst()).toEqual({ id: activeId });
    expect(aiDebugStore.list()).toEqual([]);
    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("only exposes in-memory AI traces when debug tools are enabled", async () => {
    const disabled = await setup();
    const disabledApp = Fastify();
    await registerRoutes(disabledApp, {
      context: disabled.context,
      config: disabled.config,
      recognitionPreviewStore: new RecognitionPreviewStore(),
      runnerHeartbeat: { at: Date.now() },
    });
    expect((await disabledApp.inject({ method: "GET", url: "/debug/status" })).json()).toEqual({ enabled: false });
    expect((await disabledApp.inject({ method: "GET", url: "/debug/ai-traces" })).statusCode).toBe(404);
    expect((await disabledApp.inject({ method: "GET", url: "/parser-rules" })).json()).toEqual([]);
    expect((await disabledApp.inject({
      method: "POST",
      url: "/recognition-previews",
      payload: { applicationId: "11111111-1111-4111-8111-111111111111" },
    })).statusCode).toBe(200);
    await disabledApp.close();
    await disabled.context.db.destroy();
    disabled.context.raw.close();

    const enabled = await setup();
    const store = new AiDebugStore();
    const traceId = store.start({
      runId: "run-debug",
      endpoint: "https://api.example/v1/chat/completions",
      model: "vision",
      company: "示例公司",
      applications: [],
      pageTitle: null,
      finalUrl: null,
      systemPrompt: "规则",
      userPrompt: "输入",
      screenshotBytes: 3,
      screenshotTruncated: false,
    });
    const enabledApp = Fastify();
    await registerRoutes(enabledApp, {
      context: enabled.context,
      config: { ...enabled.config, debugTools: true },
      aiDebugStore: store,
      recognitionPreviewStore: new RecognitionPreviewStore(),
      runnerHeartbeat: { at: Date.now() },
    });
    expect((await enabledApp.inject({ method: "GET", url: "/debug/status" })).json()).toEqual({ enabled: true });
    expect((await enabledApp.inject({ method: "GET", url: "/debug/ai-traces" })).json()[0]).toMatchObject({ id: traceId });
    const detail = await enabledApp.inject({ method: "GET", url: `/debug/ai-traces/${traceId}` });
    expect(detail.json().sanitizedRequest).toContain("[image omitted: 3 bytes]");
    expect((await enabledApp.inject({ method: "POST", url: "/debug/ai-traces/clear" })).json()).toEqual({ deleted: 1 });
    expect((await enabledApp.inject({ method: "GET", url: "/parser-rules" })).json()).toEqual([]);
    const ruleCandidate = await enabledApp.inject({
      method: "POST",
      url: "/applications",
      payload: {
        company: "汇川技术",
        jobTitle: "销售工程师",
        checkUrl: "https://recruit.inovance.com/",
      },
    });
    expect(ruleCandidate.statusCode, ruleCandidate.body).toBe(201);
    const checkGroups = await enabledApp.inject({
      method: "GET",
      url: "/parser-rules/check-groups?q=%E6%B1%87%E5%B7%9D&limit=10",
    });
    expect(checkGroups.statusCode, checkGroups.body).toBe(200);
    expect(checkGroups.json()).toMatchObject([
      { company: "汇川技术", jobTitle: "销售工程师", site: "inovance.com", memberCount: 1 },
    ]);
    const createdRule = await enabledApp.inject({
      method: "POST",
      url: "/parser-rules",
      payload: {
        name: "调试规则",
        enabled: true,
        priority: 100,
        definition: {
          schemaVersion: 2,
          kind: "selector",
          hostname: "careers.example.com",
          pathname: "/applications/*",
          container: null,
          title: {
            tag: "h3", role: null, classes: ["job-title"], dataStatus: null,
            ariaCurrent: null, ariaSelected: null, ancestorTags: [],
          },
          status: {
            tag: "span", role: null, classes: ["status"], dataStatus: null,
            ariaCurrent: null, ariaSelected: null, ancestorTags: [],
          },
        },
      },
    });
    expect(createdRule.statusCode, createdRule.body).toBe(200);
    expect(createdRule.json()).toMatchObject({ name: "调试规则", version: 1 });
    const singleExport = await enabledApp.inject({
      method: "GET",
      url: `/parser-rules/${createdRule.json().id as string}/export`,
    });
    expect(singleExport.statusCode, singleExport.body).toBe(200);
    expect(singleExport.json()).toMatchObject({
      schemaVersion: 2,
      rules: [{ id: createdRule.json().id, name: "调试规则" }],
    });
    await enabledApp.close();
    await enabled.context.db.destroy();
    enabled.context.raw.close();
  });

  it("cancels a stale login run when the check URL is removed and allows login refresh after adding a new URL", async () => {
    const { context, config } = await setup();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const created = await app.inject({
      method: "POST",
      url: "/applications",
      payload: {
        company: "登录状态公司",
        jobTitle: "后端工程师",
        checkUrl: "https://example.com/applications",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const applicationId = created.json().id as string;
    const queued = await app.inject({ method: "POST", url: `/applications/${applicationId}/runs` });
    expect(queued.statusCode, queued.body).toBe(202);
    const staleRunId = queued.json().runId as string;
    await context.db.updateTable("runs").set({ status: "needs_login" }).where("id", "=", staleRunId).execute();

    const removed = await app.inject({
      method: "POST",
      url: `/applications/${applicationId}/update`,
      payload: { checkUrl: null },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().lastRunStatus).toBe("cancelled");
    expect(await context.db.selectFrom("runs").select(["status", "error_code"]).where("id", "=", staleRunId)
      .executeTakeFirstOrThrow()).toEqual({
      status: "cancelled",
      error_code: "CHECK_GROUP_CHANGED",
    });
    expect((await app.inject({ method: "POST", url: `/applications/${applicationId}/login` })).statusCode).toBe(400);

    const restored = await app.inject({
      method: "POST",
      url: `/applications/${applicationId}/update`,
      payload: { checkUrl: "https://example.org/candidate/status" },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const refreshed = await app.inject({ method: "POST", url: `/applications/${applicationId}/login` });
    expect(refreshed.statusCode, refreshed.body).toBe(201);
    expect(await context.db.selectFrom("runs").select(["status", "application_id"])
      .where("id", "=", refreshed.json().runId as string).executeTakeFirstOrThrow()).toEqual({
      status: "needs_login",
      application_id: applicationId,
    });

    await app.close();
    await context.db.destroy();
    context.raw.close();
  });

  it("repairs a stale active login run left by an older check-group change", async () => {
    const { context, config } = await setup();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const first = await app.inject({
      method: "POST",
      url: "/applications",
      payload: {
        company: "历史数据公司",
        jobTitle: "前端工程师",
        checkUrl: "https://example.com/old-status",
      },
    });
    const applicationId = first.json().id as string;
    const queued = await app.inject({ method: "POST", url: `/applications/${applicationId}/runs` });
    const staleRunId = queued.json().runId as string;
    await context.db.updateTable("runs").set({ status: "needs_login" }).where("id", "=", staleRunId).execute();

    const second = await app.inject({
      method: "POST",
      url: "/applications",
      payload: {
        company: "历史数据公司",
        jobTitle: "测试工程师",
        checkUrl: "https://example.org/new-status",
      },
    });
    const currentGroupId = second.json().checkGroupId as string;
    await context.db.updateTable("applications").set({
      check_group_id: currentGroupId,
      check_url: "https://example.org/new-status",
    }).where("id", "=", applicationId).execute();

    const refreshed = await app.inject({ method: "POST", url: `/applications/${applicationId}/login` });
    expect(refreshed.statusCode, refreshed.body).toBe(201);
    expect(await context.db.selectFrom("runs").select(["status", "error_code"]).where("id", "=", staleRunId)
      .executeTakeFirstOrThrow()).toEqual({
      status: "cancelled",
      error_code: "CHECK_GROUP_CHANGED",
    });

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
