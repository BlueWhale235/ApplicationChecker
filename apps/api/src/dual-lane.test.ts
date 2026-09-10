import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { createDb, type DbContext } from "./db.js";
import { registerRoutes } from "./routes.js";
import {
  loadBrowserStateWithVersion,
  queueRun,
  saveBrowserState,
  saveBrowserStateIfVersion,
  updateAppSettings,
} from "./service.js";
import { recoverInterruptedWork } from "./startup-recovery.js";

const folders: string[] = [];
afterEach(async () => Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))));

async function setup() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "application-checker-lanes-"));
  folders.push(folder);
  const context = createDb(path.join(folder, "test.sqlite"));
  const config = {
    nodeEnv: "test", host: "127.0.0.1", port: 0, dataPath: folder,
    databasePath: path.join(folder, "test.sqlite"), screenshotsPath: path.join(folder, "screenshots"),
    logsPath: path.join(folder, "logs"), browserCachePath: path.join(folder, "browser", "cache"),
    tempPath: path.join(folder, "tmp"), runtimeSettingsPath: path.join(folder, "runtime-settings.json"),
    appBaseUrl: "http://127.0.0.1", runnerUrl: "http://runner",
    runnerToken: "test-runner-token-with-at-least-32-bytes", stateKey: Buffer.alloc(32, 7),
    upstreamProxyUrl: null, aiConfidenceThreshold: 0.75, webDistPath: null,
    desktopMode: false, desktopSessionToken: null, debugTools: false,
  } satisfies Config;
  await insertApplication(context, "app-1", "甲公司", "产品经理", "https://one.example.com/status");
  await insertApplication(context, "app-2", "乙公司", "开发工程师", "https://two.example.net/status");
  return { context, config };
}

async function insertApplication(context: DbContext, id: string, company: string, jobTitle: string, checkUrl: string) {
  const site = new URL(checkUrl).hostname.split(".").slice(-2).join(".");
  await context.db.insertInto("applications").values({
    id, company, job_title: jobTitle, check_url: checkUrl, resolved_url: null, posting_url: null,
    applied_at: null, location: null, notes: null, site, progress_status: "screening",
    progress_source: null, manual_locked: 0, automation_paused: 0,
    automation_pause_reason: null, automation_paused_at: null, schedule_mode: "manual", cron_expression: null,
    next_run_at: null, last_run_at: null, last_run_status: null, last_status_changed_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).execute();
}

describe("dual runner lanes", () => {
  it("automatically replaces an existing login session but protects one being saved", async () => {
    const { context, config } = await setup();
    const firstRun = await queueRun(context, "app-1", "manual");
    const secondRun = await queueRun(context, "app-2", "manual");
    await context.db.updateTable("runs").set({ status: "needs_login" }).where("id", "in", [firstRun!, secondRun!]).execute();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });

    const first = await app.inject({ method: "POST", url: "/login-sessions", payload: { runId: firstRun } });
    expect(first.statusCode).toBe(201);
    expect(first.json().replacedExisting).toBe(false);
    await context.db.updateTable("login_sessions").set({ status: "ready" }).where("id", "=", first.json().session.id).execute();

    const second = await app.inject({ method: "POST", url: "/login-sessions", payload: { runId: secondRun } });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().replacedExisting).toBe(true);
    expect(await context.db.selectFrom("login_sessions").select("status").where("id", "=", first.json().session.id).executeTakeFirst())
      .toEqual({ status: "cancelled" });
    await context.db.updateTable("login_sessions").set({ status: "saving" }).where("id", "=", second.json().session.id).execute();

    const blocked = await app.inject({ method: "POST", url: "/login-sessions", payload: { runId: firstRun } });
    expect(blocked.statusCode).toBe(409);
    const now = new Date().toISOString();
    await expect(context.db.insertInto("login_sessions").values({
      id: "duplicate-active-login", application_id: "app-1", run_id: firstRun!, status: "queued",
      access_token_hash: "hash", token_used_at: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
      error_message: null, created_at: now, updated_at: now, completed_at: null,
    }).execute()).rejects.toThrow(/UNIQUE constraint failed/);
    await app.close(); await context.db.destroy(); context.raw.close();
  });

  it("cleans queued login sessions during startup recovery", async () => {
    const { context } = await setup();
    const runId = await queueRun(context, "app-1", "manual");
    await context.db.updateTable("runs").set({ status: "needs_login" }).where("id", "=", runId!).execute();
    const now = new Date().toISOString();
    await context.db.insertInto("login_sessions").values({
      id: "queued-login", application_id: "app-1", run_id: runId!, status: "queued",
      access_token_hash: "hash", token_used_at: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
      error_message: null, created_at: now, updated_at: now, completed_at: null,
    }).execute();
    expect((await recoverInterruptedWork(context)).loginSessionsFailed).toBe(1);
    expect(await context.db.selectFrom("login_sessions").select("status").where("id", "=", "queued-login").executeTakeFirst())
      .toEqual({ status: "failed" });
    await context.db.destroy(); context.raw.close();
  });

  it("repairs the legacy active-session index and cancels duplicate sessions", async () => {
    const { context, config } = await setup();
    const firstRun = await queueRun(context, "app-1", "manual");
    const secondRun = await queueRun(context, "app-2", "manual");
    await context.db.updateTable("runs").set({ status: "needs_login" }).where("id", "in", [firstRun!, secondRun!]).execute();
    context.raw.exec(`
      DROP INDEX login_one_active;
      CREATE UNIQUE INDEX login_one_active ON login_sessions(id)
        WHERE status IN ('queued','starting','ready','active','saving');
    `);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await context.db.insertInto("login_sessions").values([
      {
        id: "legacy-old", application_id: "app-1", run_id: firstRun!, status: "active",
        access_token_hash: "old", token_used_at: null, expires_at: expiresAt, error_message: null,
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", completed_at: null,
      },
      {
        id: "legacy-new", application_id: "app-2", run_id: secondRun!, status: "ready",
        access_token_hash: "new", token_used_at: null, expires_at: expiresAt, error_message: null,
        created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z", completed_at: null,
      },
    ]).execute();
    await context.db.destroy(); context.raw.close();

    const reopened = createDb(config.databasePath);
    const sessions = await reopened.db.selectFrom("login_sessions")
      .select(["id", "status"])
      .where("id", "in", ["legacy-old", "legacy-new"])
      .orderBy("id")
      .execute();
    expect(sessions).toEqual([
      { id: "legacy-new", status: "ready" },
      { id: "legacy-old", status: "cancelled" },
    ]);
    const now = new Date().toISOString();
    await expect(reopened.db.insertInto("login_sessions").values({
      id: "legacy-third", application_id: "app-1", run_id: firstRun!, status: "queued",
      access_token_hash: "third", token_used_at: null, expires_at: expiresAt, error_message: null,
      created_at: now, updated_at: now, completed_at: null,
    }).execute()).rejects.toThrow(/UNIQUE constraint failed/);
    await reopened.db.destroy(); reopened.raw.close();
  });

  it("claims login immediately while an automated capture is already running", async () => {
    const { context, config } = await setup();
    updateAppSettings(context, { check_concurrency: 3 });
    const firstRun = await queueRun(context, "app-1", "manual");
    const secondRun = await queueRun(context, "app-2", "manual");
    await context.db.updateTable("runs").set({ status: "needs_login" }).where("id", "=", secondRun!).execute();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const auth = { authorization: `Bearer ${config.runnerToken}` };

    expect((await app.inject({ method: "POST", url: "/internal/claim/background", headers: auth })).json())
      .toMatchObject({ kind: "capture", runId: firstRun, browserStateVersion: 0 });
    expect((await app.inject({ method: "POST", url: "/login-sessions", payload: { runId: secondRun } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/internal/claim/login", headers: auth })).json())
      .toMatchObject({ kind: "login", runId: secondRun, browserStateVersion: 0 });
    expect((await app.inject({ method: "POST", url: "/internal/claim/background", headers: auth })).json())
      .toEqual({ kind: "idle" });

    await context.db.updateTable("login_sessions").set({ status: "completed" }).execute();
    await insertApplication(context, "app-3", "丙公司", "测试工程师", "https://three.example.org/status");
    const thirdRun = await queueRun(context, "app-3", "manual");
    expect((await app.inject({ method: "POST", url: "/internal/claim/background", headers: auth })).json())
      .toMatchObject({ kind: "capture", runId: thirdRun });

    await app.close(); await context.db.destroy(); context.raw.close();
  });

  it("atomically enforces the live automated-check concurrency limit", async () => {
    const { context, config } = await setup();
    await insertApplication(context, "app-3", "丙公司", "测试工程师", "https://three.example.org/status");
    await insertApplication(context, "app-4", "丁公司", "运营经理", "https://four.example.dev/status");
    const runIds = await Promise.all([
      queueRun(context, "app-1", "cron"),
      queueRun(context, "app-2", "cron"),
      queueRun(context, "app-3", "cron"),
      queueRun(context, "app-4", "cron"),
    ]);
    updateAppSettings(context, { check_concurrency: 2 });
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const auth = { authorization: `Bearer ${config.runnerToken}` };

    const firstClaims = await Promise.all(Array.from({ length: 4 }, () =>
      app.inject({ method: "POST", url: "/internal/claim/background", headers: auth })));
    const captured = firstClaims.map((response) => response.json()).filter((job) => job.kind === "capture");
    expect(captured).toHaveLength(2);
    expect(new Set(captured.map((job) => job.runId)).size).toBe(2);
    expect(firstClaims.filter((response) => response.json().kind === "idle")).toHaveLength(2);

    updateAppSettings(context, { check_concurrency: 1 });
    expect((await app.inject({ method: "POST", url: "/internal/claim/background", headers: auth })).json())
      .toEqual({ kind: "idle" });
    updateAppSettings(context, { check_concurrency: 3 });
    const raised = await app.inject({ method: "POST", url: "/internal/claim/background", headers: auth });
    expect(raised.json()).toMatchObject({ kind: "capture" });
    expect(runIds).toContain(raised.json().runId);

    await app.close(); await context.db.destroy(); context.raw.close();
  });

  it("keeps the default at one automated check", async () => {
    const { context, config } = await setup();
    await queueRun(context, "app-1", "cron");
    await queueRun(context, "app-2", "cron");
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const auth = { authorization: `Bearer ${config.runnerToken}` };
    const claims = await Promise.all(Array.from({ length: 3 }, () =>
      app.inject({ method: "POST", url: "/internal/claim/background", headers: auth })));
    expect(claims.filter((response) => response.json().kind === "capture")).toHaveLength(1);
    expect(claims.filter((response) => response.json().kind === "idle")).toHaveLength(2);
    await app.close(); await context.db.destroy(); context.raw.close();
  });

  it("prioritizes login resume and user-triggered checks ahead of cron", async () => {
    const { context, config } = await setup();
    await insertApplication(context, "app-3", "丙公司", "测试工程师", "https://three.example.org/status");
    await insertApplication(context, "app-4", "丁公司", "运营经理", "https://four.example.dev/status");
    const cron = await queueRun(context, "app-1", "cron");
    const resumed = await queueRun(context, "app-2", "login_resume");
    const manual = await queueRun(context, "app-3", "manual");
    const bulk = await queueRun(context, "app-4", "bulk");
    await context.db.updateTable("runs").set({ created_at: "2026-01-01T00:00:01.000Z" }).where("id", "=", manual!).execute();
    await context.db.updateTable("runs").set({ created_at: "2026-01-01T00:00:02.000Z" }).where("id", "=", bulk!).execute();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const auth = { authorization: `Bearer ${config.runnerToken}` };
    const claimed: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await app.inject({ method: "POST", url: "/internal/claim/background", headers: auth });
      expect(response.json()).toMatchObject({ kind: "capture" });
      claimed.push(response.json().runId);
      await context.db.updateTable("runs").set({ status: "succeeded", completed_at: new Date().toISOString() })
        .where("id", "=", response.json().runId).execute();
    }
    expect(claimed).toEqual([resumed, manual, bulk, cron]);
    await app.close(); await context.db.destroy(); context.raw.close();
  });

  it("does not let stale automated state overwrite a newer login state", async () => {
    const { context, config } = await setup();
    const initial = { version: 1 as const, cookies: [], origins: [] };
    await saveBrowserState(context, config, "example.com", initial);
    const claimed = await loadBrowserStateWithVersion(context, config, "example.com");
    const loginState = { version: 1 as const, cookies: [{ name: "session", value: "new", domain: ".example.com", path: "/" }], origins: [] };
    await saveBrowserState(context, config, "example.com", loginState);

    expect(await saveBrowserStateIfVersion(context, config, "example.com", initial, claimed.version)).toBe(false);
    expect((await loadBrowserStateWithVersion(context, config, "example.com")).state).toEqual(loginState);
    await context.db.destroy(); context.raw.close();
  });

  it("uses the configured check URL after login instead of the page visited by the user", async () => {
    const { context, config } = await setup();
    const checkUrl = "https://one.example.com/application/status";
    const visitedUrl = "https://one.example.com/jobs";
    await context.db.updateTable("applications").set({ check_url: checkUrl, resolved_url: visitedUrl })
      .where("id", "=", "app-1").execute();
    const runId = await queueRun(context, "app-1", "manual");
    await context.db.updateTable("runs").set({ status: "needs_login" }).where("id", "=", runId!).execute();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const auth = { authorization: `Bearer ${config.runnerToken}` };

    const created = await app.inject({ method: "POST", url: "/login-sessions", payload: { runId } });
    const sessionId = created.json().session.id as string;
    expect((await app.inject({ method: "POST", url: "/internal/claim/login", headers: auth })).json())
      .toMatchObject({ kind: "login", url: checkUrl });
    const completed = await app.inject({
      method: "POST",
      url: `/internal/login/${sessionId}/complete`,
      headers: auth,
      payload: { finalUrl: visitedUrl, browserState: { version: 1, cookies: [], origins: [] } },
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect((await app.inject({ method: "POST", url: "/internal/claim/background", headers: auth })).json())
      .toMatchObject({ kind: "capture", runId, url: checkUrl });
    expect(await context.db.selectFrom("applications").select("resolved_url").where("id", "=", "app-1").executeTakeFirst())
      .toEqual({ resolved_url: visitedUrl });

    await app.close(); await context.db.destroy(); context.raw.close();
  });

  it("returns the next pending login only after excluding the completed run", async () => {
    const { context, config } = await setup();
    const firstRun = await queueRun(context, "app-1", "manual");
    const secondRun = await queueRun(context, "app-2", "manual");
    await context.db.updateTable("runs").set({ status: "needs_login" }).where("id", "in", [firstRun!, secondRun!]).execute();
    const app = Fastify();
    await registerRoutes(app, { context, config, runnerHeartbeat: { at: Date.now() } });
    const response = await app.inject({ method: "GET", url: `/login-sessions/next-needed?excludeRunId=${firstRun}` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ runId: secondRun, company: "乙公司", site: "example.net" });
    await app.close(); await context.db.destroy(); context.raw.close();
  });
});
