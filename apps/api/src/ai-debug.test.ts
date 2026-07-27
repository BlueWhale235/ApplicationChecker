import { describe, expect, it } from "vitest";
import { AiDebugStore } from "./ai-debug.js";

const input = (runId: string) => ({
  runId,
  endpoint: "https://api.example/v1/chat/completions",
  model: "vision",
  company: "示例公司",
  applications: [{ id: "a", jobTitle: "工程师", appliedAt: null, location: null }],
  pageTitle: "投递记录",
  finalUrl: "https://example.com/status",
  systemPrompt: "固定规则",
  userPrompt: "动态岗位",
  screenshotBytes: 123,
  screenshotTruncated: false,
});

describe("AI debug store", () => {
  it("keeps a bounded in-memory history and sanitizes image input", () => {
    const store = new AiDebugStore(2);
    const first = store.start(input("run-1"));
    store.start(input("run-2"));
    const third = store.start(input("run-3"));
    expect(store.list()).toHaveLength(2);
    expect(store.get(first)).toBeNull();
    const detail = store.get(third)!;
    expect(detail.sanitizedRequest).toContain("[image omitted: 123 bytes]");
    expect(detail.sanitizedRequest).not.toContain("base64");
  });

  it("caps raw output, records completion and removes traces by run", () => {
    const store = new AiDebugStore();
    const id = store.start(input("run-1"));
    store.attempt(id, {
      deepThinking: false,
      startedAt: new Date().toISOString(),
      durationMs: 25,
      httpStatus: 200,
      responseBody: "x".repeat(101 * 1024),
      error: null,
    });
    store.complete(id, { pageType: "application_status", pageEvidence: "记录", results: [] });
    expect(store.get(id)).toMatchObject({
      status: "succeeded",
      attempts: [{ responseTruncated: true, httpStatus: 200 }],
    });
    expect(store.get(id)!.attempts[0]!.responseBody).toHaveLength(100 * 1024);
    expect(store.removeRuns(["run-1"])).toBe(1);
    expect(store.list()).toEqual([]);
  });
});
