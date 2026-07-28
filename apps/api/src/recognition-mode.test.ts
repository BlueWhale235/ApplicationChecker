import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatusRecognizer } from "@application-checker/ai-status";
import type { LocalPageSnapshot, RecognitionMode } from "@application-checker/contracts";
import type { Config } from "./config.js";
import { createDb } from "./db.js";
import { registerRoutes } from "./routes.js";
import { queueRun } from "./service.js";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const pageSnapshot: LocalPageSnapshot = {
  url: "https://example.com/status",
  title: "申请进度",
  language: "zh-CN",
  visibleText: "产品经理\n业务筛选",
  nodes: [
    {
      id: 1, parentId: null, tag: "div", role: null, classes: [], dataStatus: null,
      text: "产品经理", x: 10, y: 10, width: 300, height: 30,
    },
    {
      id: 2, parentId: null, tag: "div", role: null, classes: ["current"], dataStatus: null,
      text: "业务筛选", x: 10, y: 50, width: 300, height: 30,
    },
  ],
  truncated: false,
  nodeLimitReached: false,
  textLimitReached: false,
};

async function setup(mode: RecognitionMode) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "recognition-mode-"));
  folders.push(folder);
  const context = createDb(path.join(folder, "test.sqlite"));
  const config = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataPath: folder,
    databasePath: path.join(folder, "test.sqlite"),
    screenshotsPath: path.join(folder, "screenshots"),
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
  await context.db.updateTable("app_settings").set({ recognition_mode: mode }).where("id", "=", 1).execute();
  await context.db.insertInto("applications").values({
    id: "11111111-1111-4111-8111-111111111111",
    company: "示例公司",
    job_title: "产品经理",
    check_url: pageSnapshot.url,
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
  return { context, config };
}

async function exercise(mode: RecognitionMode, snapshot = pageSnapshot) {
  const { context, config } = await setup(mode);
  const recognizeGroup = vi.fn().mockResolvedValue({
    provider: "vision-test",
    results: [{
      applicationId: "11111111-1111-4111-8111-111111111111",
      matched: true,
      rawStatus: "已面试",
      status: "interviewed",
      confidence: 0.98,
      evidence: "AI fixture",
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
      finalUrl: pageSnapshot.url,
      pageTitle: pageSnapshot.title,
      screenshotBase64: Buffer.from("png").toString("base64"),
      truncated: false,
      browserState: { version: 1, cookies: [], origins: [] },
      pageSnapshot: snapshot,
    },
  });
  expect(complete.statusCode, complete.body).toBe(200);
  const detail = (await app.inject({
    method: "GET", url: "/applications/11111111-1111-4111-8111-111111111111",
  })).json();
  await app.close();
  await context.db.destroy();
  context.raw.close();
  return { recognizeGroup, detail };
}

describe("recognition modes", () => {
  it.each(["local_only", "local_first"] as const)("%s accepts high-confidence local results without calling AI", async (mode) => {
    const { recognizeGroup, detail } = await exercise(mode);
    expect(recognizeGroup).not.toHaveBeenCalled();
    expect(detail.application).toMatchObject({ progressStatus: "screening_passed", progressSource: "local" });
    expect(detail.runs[0]).toMatchObject({
      recognitionMode: mode,
      recognitionSource: "local",
      recognitionSuggestedStatus: "screening_passed",
      aiStatus: "skipped",
    });
  });

  it("ai_only ignores the DOM result and preserves the screenshot recognition flow", async () => {
    const { recognizeGroup, detail } = await exercise("ai_only");
    expect(recognizeGroup).toHaveBeenCalledTimes(1);
    expect(detail.application).toMatchObject({ progressStatus: "interviewed", progressSource: "ai" });
    expect(detail.runs[0]).toMatchObject({
      recognitionMode: "ai_only",
      recognitionSource: "ai",
      recognitionSuggestedStatus: "interviewed",
    });
  });

  it("local_first sends only an unresolved local candidate to AI", async () => {
    const unresolved = {
      ...pageSnapshot,
      visibleText: "当前页面只显示其他岗位内容",
      nodes: [{ ...pageSnapshot.nodes[0]!, text: "其他岗位" }],
    };
    const { recognizeGroup, detail } = await exercise("local_first", unresolved);
    expect(recognizeGroup).toHaveBeenCalledTimes(1);
    expect(recognizeGroup.mock.calls[0]?.[0].applications).toHaveLength(1);
    expect(detail.application).toMatchObject({ progressStatus: "interviewed", progressSource: "ai" });
  });
});
