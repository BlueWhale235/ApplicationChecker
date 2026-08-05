import { describe, expect, it } from "vitest";
import type { LocalPageSnapshot } from "@application-checker/contracts";
import { RecognitionPreviewStore } from "./recognition-preview.js";

const snapshot: LocalPageSnapshot = {
  url: "https://candidate.mokahr.com/applications/1",
  title: "申请进度",
  language: "zh-CN",
  visibleText: "后端工程师\n待评估",
  nodes: [
    {
      id: 1, parentId: null, tag: "div", role: null, classes: [], dataStatus: null,
      text: "后端工程师", x: 10, y: 10, width: 300, height: 30,
    },
    {
      id: 2, parentId: null, tag: "div", role: null, classes: ["current"], dataStatus: null,
      text: "待评估", x: 10, y: 50, width: 300, height: 30,
    },
  ],
  truncated: false,
  nodeLimitReached: false,
  textLimitReached: false,
};

describe("RecognitionPreviewStore", () => {
  it("prioritizes page-session release commands", () => {
    const store = new RecognitionPreviewStore();
    store.requestRelease("preview-1");
    store.requestRelease("preview-1");
    expect(store.claim()).toEqual({ kind: "recognition_preview_release", previewId: "preview-1" });
    expect(store.claim()).toBeNull();
  });

  it("keeps preview state in memory and exposes only sanitized results", () => {
    const store = new RecognitionPreviewStore();
    const created = store.enqueue({
      purpose: "capture", sourcePreviewId: null, keepAlive: false,
      groupId: "group-1",
      applicationId: "job-1",
      url: snapshot.url,
      company: "示例公司",
      applications: [{
        id: "job-1", company: "示例公司", jobTitle: "后端工程师", checkUrl: snapshot.url,
        postingUrl: null, appliedAt: null, location: null, notes: null, site: "mokahr.com", progressStatus: "screening",
      }],
      site: "mokahr.com",
      browserState: {
        version: 1,
        cookies: [{ name: "secret", value: "token", domain: ".mokahr.com", path: "/" }],
        origins: [],
      },
      proxyUrl: null,
      userAgent: "test",
    });
    expect(created.status).toBe("queued");
    const job = store.claim();
    expect(job).toMatchObject({ kind: "recognition_preview", previewId: created.id });
    const completed = store.complete(created.id, {
      snapshot,
      screenshotBase64: Buffer.from("png").toString("base64"),
      needsLogin: false,
      loginReason: null,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      adapterId: "mokahr",
      matchedCount: 1,
      results: [{ applicationId: "job-1", status: "screening" }],
    });
    const serialized = JSON.stringify(store.get(created.id));
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("screenshotBase64");
  });

  it("reports mapped page script test results without writing application state", () => {
    const store = new RecognitionPreviewStore();
    const source = store.enqueue({
      purpose: "capture", sourcePreviewId: null, keepAlive: true,
      groupId: "group-1", applicationId: "job-1", url: snapshot.url, company: "示例公司",
      applications: [{
        id: "job-1", company: "示例公司", jobTitle: "后端工程师", checkUrl: snapshot.url,
        postingUrl: null, appliedAt: null, location: null, notes: null, site: "mokahr.com", progressStatus: "screening",
      }],
      site: "mokahr.com", browserState: null, proxyUrl: null, userAgent: "test",
    });
    expect(store.claim()).toMatchObject({ previewId: source.id, purpose: "capture" });
    store.complete(source.id, {
      snapshot, screenshotBase64: Buffer.from("png").toString("base64"), needsLogin: false, loginReason: null,
    });
    const created = store.enqueueScriptTest(source.id, {
      id: "script-1", name: "脚本", enabled: true, priority: 100, version: 2,
      definition: { schemaVersion: 2, kind: "script", hostname: "*.mokahr.com", pathname: "/*", script: "return null", timeoutMs: 5000 },
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lastTestedAt: null,
    });
    expect(created).not.toBeNull();
    expect(store.claim()).toMatchObject({
      scriptRule: { id: "script-1" }, purpose: "script_test", sourcePreviewId: source.id, keepAlive: true,
    });
    const completed = store.completeScriptTest(created!.id, {
      finalUrl: snapshot.url, pageTitle: snapshot.title, needsLogin: false, loginReason: null,
      scriptExecution: {
        ruleId: "script-1", ruleVersion: 2, durationMs: 88,
        results: [{ applicationId: "job-1", rawStatus: "待面试", evidence: "查询结果" }],
        logs: [{ atMs: 12, message: "读取状态 待面试" }],
        logsTruncated: false,
      },
    });
    expect(completed).toMatchObject({
      status: "succeeded", adapterId: "script:script-1", matchedCount: 1,
      scriptDurationMs: 88, scriptRuleId: "script-1",
      scriptLogs: [{ atMs: 12, message: "读取状态 待面试" }], scriptLogsTruncated: false,
      results: [{ applicationId: "job-1", status: "interview_pending" }],
      screenshotAvailable: true,
    });
    expect(store.snapshot(created!.id)?.snapshot).toBe(snapshot);
  });

  it("preserves debug logs when a page script test fails", () => {
    const store = new RecognitionPreviewStore();
    const created = store.enqueue({
      purpose: "capture", sourcePreviewId: null, keepAlive: false,
      groupId: "group-1", applicationId: "job-1", url: snapshot.url, company: "示例公司",
      applications: [{
        id: "job-1", company: "示例公司", jobTitle: "后端工程师", checkUrl: snapshot.url,
        postingUrl: null, appliedAt: null, location: null, notes: null, site: "mokahr.com", progressStatus: "screening",
      }],
      site: "mokahr.com", browserState: null, proxyUrl: null, userAgent: "test",
    });
    store.claim();
    store.fail(created.id, "等待页面元素超时", {
      durationMs: 5_000,
      ruleId: "script-1",
      logs: [{ atMs: 2, message: "开始查询" }],
      logsTruncated: true,
    });
    expect(store.get(created.id)).toMatchObject({
      status: "failed",
      error: "等待页面元素超时",
      scriptDurationMs: 5_000,
      scriptRuleId: "script-1",
      scriptLogs: [{ atMs: 2, message: "开始查询" }],
      scriptLogsTruncated: true,
    });
  });
});
