import { describe, expect, it } from "vitest";
import type { LocalPageSnapshot } from "@application-checker/contracts";
import {
  normalizeRecognitionText,
  recognizeLocalPage,
  resolveParserAdapter,
  validateParserAdapters,
  type ParserAdapter,
} from "./index.js";

function snapshot(url: string, nodes: LocalPageSnapshot["nodes"], visibleText?: string): LocalPageSnapshot {
  return {
    url,
    title: "投递进度",
    language: "zh-CN",
    visibleText: visibleText ?? nodes.map((node) => node.text).join("\n"),
    nodes,
    truncated: false,
    nodeLimitReached: false,
    textLimitReached: false,
  };
}

function node(id: number, text: string, y: number, parentId: number | null = null, classes: string[] = []) {
  return { id, parentId, tag: "div", role: null, classes, dataStatus: null, text, x: 10, y, width: 500, height: 32 };
}

describe("path registry", () => {
  it.each([
    ["https://app.zhiye.com/personal/delivery?foo=1#x", "zhiye"],
    ["https://jobs.feishu.cn/campus/applications", "feishu"],
    ["https://candidate.mokahr.com/applications/123", "mokahr"],
    ["https://example.com/jobs", "generic"],
  ])("routes %s to %s without query/hash participation", (url, expected) => {
    expect(resolveParserAdapter(snapshot(url, [])).adapter.id).toBe(expected);
  });

  it("rejects exact conflicts at the same priority", () => {
    const conflicted: ParserAdapter[] = [
      { id: "a", version: "1", priority: 1, routes: [{ hostname: "a.test", pathname: "/*" }], containerHints: [] },
      { id: "b", version: "1", priority: 1, routes: [{ hostname: "a.test", pathname: "/*" }], containerHints: [] },
    ];
    expect(() => validateParserAdapters(conflicted)).toThrow(/Conflicting parser routes/);
  });
});

describe("local recognition", () => {
  it.each([
    ["https://app.zhiye.com/personal/delivery", "简历筛选-进行中", "screening"],
    ["https://jobs.feishu.cn/campus/applications", "业务筛选", "screening_passed"],
    ["https://candidate.mokahr.com/applications", "待评估", "screening"],
    ["https://candidate.mokahr.com/applications", "Under Review", "screening"],
    ["https://jobs.feishu.cn/campus/applications", "Shortlisted", "screening_passed"],
  ] as const)("recognizes %s fixture", (url, statusText, expected) => {
    const result = recognizeLocalPage(snapshot(url, [
      node(1, "后端开发工程师", 10),
      node(2, statusText, 50, null, ["current"]),
    ]), [{ id: "job-1", jobTitle: "后端开发工程师" }]);
    expect(result.results[0]).toMatchObject({ matched: true, status: expected });
    expect(result.results[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("uses user-defined mapping pills", () => {
    const result = recognizeLocalPage(snapshot("https://example.com/jobs", [
      node(1, "Backend Engineer", 10),
      node(2, "HR Approved", 50, null, ["current"]),
    ]), [{ id: "job-1", jobTitle: "Backend Engineer" }], {
      screening: [],
      screening_passed: ["HR Approved"],
      interview_pending: [],
      interviewed: [],
      signing_pending: [],
      offer: [],
      rejected: [],
    });
    expect(result.results[0]).toMatchObject({ matched: true, status: "screening_passed", rawStatus: "HR Approved" });
  });

  it("does not guess when duplicate titles are ambiguous", () => {
    const result = recognizeLocalPage(snapshot("https://example.com/jobs", [
      node(1, "产品经理", 10), node(2, "初筛", 40),
      node(3, "产品经理", 400), node(4, "待面试", 440),
    ]), [{ id: "job-1", jobTitle: "产品经理" }]);
    expect(result.results[0]).toMatchObject({ matched: false, status: null });
  });

  it("maps blank pages to unset", () => {
    const result = recognizeLocalPage(snapshot("https://app.zhiye.com/", [], " "), [{ id: "job-1", jobTitle: "产品经理" }]);
    expect(result).toMatchObject({ pageType: "blank" });
    expect(result.results[0]).toMatchObject({ matched: true, status: "unset" });
  });

  it("normalizes Unicode, case, whitespace and punctuation", () => {
    expect(normalizeRecognitionText(" ＡI - Engineer ")).toBe("aiengineer");
  });
});
