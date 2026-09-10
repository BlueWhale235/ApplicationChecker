import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserStateEnvelope } from "@application-checker/contracts";
import type { Config } from "./config.js";
import { createDb, type DbContext } from "./db.js";
import { DataTransferService, verifyStateEncryptionKey } from "./data-transfer.js";
import { decryptSecret, updateAiSettings } from "./runtime-settings.js";
import { appSettings, loadBrowserState, saveBrowserState } from "./service.js";

const folders: string[] = [];
const contexts: DbContext[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.db.destroy();
    context.raw.close();
  }
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function setup(keyByte: number): Promise<{ folder: string; context: DbContext; config: Config; service: DataTransferService }> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "application-checker-transfer-"));
  folders.push(folder);
  const context = createDb(path.join(folder, "test.sqlite"));
  contexts.push(context);
  const config = {
    nodeEnv: "test", host: "127.0.0.1", port: 0, dataPath: folder,
    databasePath: path.join(folder, "test.sqlite"), screenshotsPath: path.join(folder, "screenshots"),
    logsPath: path.join(folder, "logs"), browserCachePath: path.join(folder, "browser", "cache"),
    tempPath: path.join(folder, "tmp"), runtimeSettingsPath: path.join(folder, "runtime-settings.json"),
    appBaseUrl: "http://127.0.0.1", runnerUrl: "http://runner",
    runnerToken: "test-runner-token-with-at-least-32-bytes", stateKey: Buffer.alloc(32, keyByte),
    upstreamProxyUrl: null, aiConfidenceThreshold: 0.75, webDistPath: null,
    desktopMode: false, desktopSessionToken: null, debugTools: false,
  } satisfies Config;
  await verifyStateEncryptionKey(context, config);
  return { folder, context, config, service: new DataTransferService(context, config, { active: false }) };
}

async function seedSource(context: DbContext, config: Config): Promise<void> {
  const applicationId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  await context.db.insertInto("applications").values({
    id: applicationId, check_group_id: null, company: "迁移公司", job_title: "测试岗位",
    check_url: "https://example.com/status", resolved_url: null, posting_url: null, applied_at: "2026-09-01",
    location: "上海", notes: "保留备注", site: "example.com", progress_status: "screening",
    progress_source: "manual", manual_locked: 1,
    automation_paused: 0, automation_pause_reason: null, automation_paused_at: null,
    schedule_mode: "manual", cron_expression: null, next_run_at: null, last_run_at: "2026-09-09T00:00:00.000Z",
    last_run_status: "queued", last_status_changed_at: "2026-09-09T00:00:00.000Z",
    created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z",
  }).execute();
  const screenshot = path.join(config.screenshotsPath, "groups", applicationId, `${runId}.png`);
  await mkdir(path.dirname(screenshot), { recursive: true });
  await writeFile(screenshot, Buffer.from("fake-png"));
  await context.db.insertInto("runs").values({
    id: runId, check_group_id: null, application_id: applicationId, trigger: "manual", status: "queued",
    final_url: "https://example.com/status", page_title: "状态", screenshot_path: screenshot,
    screenshot_truncated: 0, ai_status: "skipped", ai_suggested_status: null,
    ai_suggested_status_v2: null, ai_confidence: null, ai_evidence: null, ai_provider: null,
    recognition_status: "pending", recognition_source: null, recognition_suggested_status_v2: null,
    recognition_confidence: null, recognition_evidence: null, recognition_provider: null,
    error_code: null, error_message: null, created_at: "2026-09-09T00:00:00.000Z",
    started_at: null, completed_at: null,
  }).execute();
  const browserState: BrowserStateEnvelope = {
    version: 1,
    cookies: [{ name: "session", value: "secret-cookie", domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
    origins: [],
  };
  await saveBrowserState(context, config, "example.com", browserState);
  await updateAiSettings(context, config, {
    baseUrl: "https://ai.example.com/v1", model: "test-model", apiKey: "secret-api-key",
    confidenceThreshold: 0.8, deepThinking: false,
  });
}

describe("full data transfer", () => {
  it("re-encrypts sensitive values with the target key and restores screenshots", async () => {
    const source = await setup(1);
    const target = await setup(2);
    await seedSource(source.context, source.config);
    const exported = await source.service.export("correct horse battery staple");
    const inspected = await target.service.inspect(exported.filename, "correct horse battery staple");

    expect(inspected.summary.keyChanged).toBe(true);
    expect(inspected.summary.screenshotCount).toBe(1);
    const result = await target.service.apply(inspected.id, true);
    expect(result.resumedQueued).toBe(1);
    const application = await target.context.db.selectFrom("applications").selectAll().executeTakeFirstOrThrow();
    expect(application.company).toBe("迁移公司");
    expect(application.last_run_status).toBe("queued");
    const run = await target.context.db.selectFrom("runs").selectAll().executeTakeFirstOrThrow();
    expect(run.status).toBe("queued");
    expect(await readFile(run.screenshot_path!)).toEqual(Buffer.from("fake-png"));
    expect((await loadBrowserState(target.context, target.config, "example.com"))?.cookies[0]?.value).toBe("secret-cookie");
    const settings = await appSettings(target.context);
    expect(decryptSecret(settings.ai_api_key_encrypted, target.config.stateKey)).toBe("secret-api-key");
    const sourceSettings = await appSettings(source.context);
    expect(settings.state_key_fingerprint).not.toBe(sourceSettings.state_key_fingerprint);
  });

  it("rejects an incorrect migration password without changing target data", async () => {
    const source = await setup(3);
    const target = await setup(4);
    await seedSource(source.context, source.config);
    const exported = await source.service.export("right-password");
    await expect(target.service.inspect(exported.filename, "wrong-password")).rejects.toThrow(/密码错误|损坏/);
    expect((await target.context.db.selectFrom("applications").selectAll().execute()).length).toBe(0);
  });

  it("detects a changed state encryption key when encrypted data exists", async () => {
    const source = await setup(5);
    await seedSource(source.context, source.config);
    await expect(verifyStateEncryptionKey(source.context, { ...source.config, stateKey: Buffer.alloc(32, 6) }))
      .rejects.toThrow(/STATE_ENCRYPTION_KEY/);
  });

  it("restores a chunked v1 backup", async () => {
    const source = await setup(7);
    const target = await setup(8);
    await seedSource(source.context, source.config);
    const run = await source.context.db.selectFrom("runs").select("screenshot_path").executeTakeFirstOrThrow();
    await writeFile(run.screenshot_path!, randomBytes(4 * 1024 * 1024 + 257));
    const exported = await source.service.export("chunked-password");
    const backup = await readFile(exported.filename);

    const upload = await target.service.startUpload({
      filename: "large.acbackup",
      size: backup.length,
      header: backup.subarray(0, 85),
    });
    expect(upload.formatVersion).toBe(1);
    let index = 0;
    for (let offset = 0; offset < backup.length; offset += upload.chunkSize) {
      const end = Math.min(offset + upload.chunkSize, backup.length);
      await target.service.appendUploadChunk(upload.id, index, offset, Readable.from(backup.subarray(offset, end)));
      index += 1;
    }
    const inspected = await target.service.completeUpload(upload.id, "chunked-password");
    await target.service.apply(inspected.id, true);
    expect((await target.context.db.selectFrom("applications").selectAll().executeTakeFirstOrThrow()).company).toBe("迁移公司");
  });

  it("ignores removed form AI settings from an older backup", async () => {
    const source = await setup(9);
    const target = await setup(10);
    await seedSource(source.context, source.config);
    source.context.raw.prepare("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)")
      .run("form_ai_base_url", JSON.stringify("https://removed.example.com/v1"), new Date().toISOString());

    const exported = await source.service.export("legacy-settings-password");
    const inspected = await target.service.inspect(exported.filename, "legacy-settings-password");
    await target.service.apply(inspected.id, true);

    expect(target.context.raw.prepare("SELECT 1 FROM app_settings WHERE key = ?").get("form_ai_base_url")).toBeUndefined();
    expect((await appSettings(target.context)).ai_model).toBe("test-model");
  });
});
