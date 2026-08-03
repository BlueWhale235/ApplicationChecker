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
  it("keeps preview state in memory and exposes only sanitized results", () => {
    const store = new RecognitionPreviewStore();
    const created = store.enqueue({
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
    const created = store.enqueue({
      groupId: "group-1", applicationId: "job-1", url: snapshot.url, company: "示例公司",
      applications: [{
        id: "job-1", company: "示例公司", jobTitle: "后端工程师", checkUrl: snapshot.url,
        postingUrl: null, appliedAt: null, location: null, notes: null, site: "mokahr.com", progressStatus: "screening",
      }],
      site: "mokahr.com", browserState: null, proxyUrl: null, userAgent: "test",
      scriptRule: {
        id: "script-1", name: "脚本", enabled: true, priority: 100, version: 2,
        definition: { schemaVersion: 2, kind: "script", hostname: "*.mokahr.com", pathname: "/*", script: "return null", timeoutMs: 5000 },
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lastTestedAt: null,
      },
    });
    expect(store.claim()?.scriptRule?.id).toBe("script-1");
    const completed = store.complete(created.id, {
      snapshot, screenshotBase64: Buffer.from("png").toString("base64"), needsLogin: false, loginReason: null,
      scriptExecution: {
        ruleId: "script-1", ruleVersion: 2, durationMs: 88,
        results: [{ applicationId: "job-1", rawStatus: "待面试", evidence: "查询结果" }],
      },
    });
    expect(completed).toMatchObject({
      status: "succeeded", adapterId: "script:script-1", matchedCount: 1,
      scriptDurationMs: 88, scriptRuleId: "script-1",
      results: [{ applicationId: "job-1", status: "interview_pending" }],
    });
  });
});
