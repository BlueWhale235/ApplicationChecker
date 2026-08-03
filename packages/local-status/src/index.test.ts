import { describe, expect, it } from "vitest";
import type { AssistedParserRule, LocalPageSnapshot } from "@application-checker/contracts";
import {
  generateAssistedRule,
  normalizeRecognitionText,
  recognizeLocalPage,
  recognizeScriptExecution,
  resolveParserAdapter,
  testAssistedRule,
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
    ["https://app.zhiye.com/personal/delivery?foo=1#x", "beisen"],
    ["https://jobs.feishu.cn/campus/applications", "feishu"],
    ["https://candidate.mokahr.com/applications/123", "mokahr"],
  ])("routes %s to %s without query/hash participation", (url, expected) => {
    expect(resolveParserAdapter(snapshot(url, [])).adapter?.id).toBe(expected);
  });

  it("returns no adapter for unsupported websites", () => {
    expect(resolveParserAdapter(snapshot("https://example.com/jobs", []))).toEqual({
      adapter: null,
      route: null,
      matchedBy: null,
    });
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
    const result = recognizeLocalPage(snapshot("https://candidate.mokahr.com/applications", [
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
    const result = recognizeLocalPage(snapshot("https://candidate.mokahr.com/applications", [
      node(1, "产品经理", 10), node(2, "初筛", 40),
      node(3, "产品经理", 400), node(4, "待面试", 440),
    ]), [{ id: "job-1", jobTitle: "产品经理" }]);
    expect(result.results[0]).toMatchObject({ matched: false, status: null });
  });

  it("reports blank pages as unmatched without changing the application status", () => {
    const result = recognizeLocalPage(snapshot("https://app.zhiye.com/", [], " "), [{ id: "job-1", jobTitle: "产品经理" }]);
    expect(result).toMatchObject({ pageType: "blank" });
    expect(result.results[0]).toMatchObject({ matched: false, status: null });
  });

  it("emits the login_required rule for a login page", () => {
    const result = recognizeLocalPage(snapshot("https://app.zhiye.com/login", [], "账号登录\n请输入密码后登录"), [
      { id: "job-1", jobTitle: "产品经理" },
    ]);
    expect(result).toMatchObject({ pageType: "login" });
    expect(result.results[0]).toMatchObject({ matched: false, rawStatus: "login_required", status: null });
  });

  it("does not guess on an unsupported website", () => {
    const result = recognizeLocalPage(snapshot("https://example.com/jobs", [
      node(1, "产品经理", 10),
      node(2, "初筛", 40),
    ], "产品经理\n初筛\n投递记录"), [{ id: "job-1", jobTitle: "产品经理" }]);
    expect(result).toMatchObject({
      adapterId: null,
      adapterVersion: null,
      pageType: "unknown",
      fallbackReason: "未命中支持的本地适配器，需要 AI 回退",
    });
    expect(result.results[0]).toMatchObject({ matched: false, status: null });
  });

  it("normalizes Unicode, case, whitespace and punctuation", () => {
    expect(normalizeRecognitionText(" ＡI - Engineer ")).toBe("aiengineer");
  });
});

describe("assisted parser rules", () => {
  const assistedSnapshot = snapshot("https://careers.example.com/applications/12345678", [
    node(1, "", 0, null, ["application-card"]),
    node(2, "后端工程师", 10, 1, ["job-title"]),
    node(3, "业务筛选", 50, 1, ["job-status", "current"]),
    node(4, "", 200, null, ["application-card"]),
    node(5, "产品经理", 210, 4, ["job-title"]),
    node(6, "待面试", 250, 4, ["job-status", "current"]),
  ]);

  it("generates a reusable path rule and extracts repeated cards", () => {
    const generated = generateAssistedRule(assistedSnapshot, {
      titleNodeId: 2,
      statusNodeId: 3,
    });
    expect(generated.errors).toEqual([]);
    expect(generated.definition.pathname).toBe("/applications/*");
    const rule: AssistedParserRule = {
      id: "rule-1",
      name: "示例规则",
      enabled: true,
      priority: 100,
      version: 1,
      definition: generated.definition,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastTestedAt: null,
    };
    const tested = testAssistedRule(assistedSnapshot, [
      { id: "job-1", jobTitle: "后端工程师" },
      { id: "job-2", jobTitle: "产品经理" },
    ], rule);
    expect(tested.valid).toBe(true);
    expect(tested.result.adapterId).toBe("assisted:rule-1");
    expect(tested.result.results).toMatchObject([
      { matched: true, status: "screening_passed" },
      { matched: true, status: "interview_pending" },
    ]);
  });

  it("does not run page scripts against a static DOM snapshot", () => {
    const rule: AssistedParserRule = {
      id: "script-rule", name: "脚本规则", enabled: true, priority: 100, version: 1,
      definition: {
        schemaVersion: 2, kind: "script", hostname: "careers.example.com", pathname: "/*",
        script: "return null", timeoutMs: 5000,
      },
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lastTestedAt: null,
    };
    expect(testAssistedRule(assistedSnapshot, [{ id: "job-1", jobTitle: "后端工程师" }], rule))
      .toMatchObject({ valid: false, errors: ["页面脚本必须在真实浏览器页面中测试"] });
  });
});

describe("page script recognition", () => {
  it("maps raw script statuses and leaves missing applications unmatched", () => {
    const result = recognizeScriptExecution({
      ruleId: "script-1",
      ruleVersion: 3,
      durationMs: 125,
      results: [{ applicationId: "job-1", rawStatus: "当前状态：待面试", evidence: "查询结果区域" }],
    }, [
      { id: "job-1", jobTitle: "后端工程师" },
      { id: "job-2", jobTitle: "产品经理" },
    ]);
    expect(result).toMatchObject({
      adapterId: "script:script-1",
      adapterVersion: "3",
      results: [
        { applicationId: "job-1", matched: true, status: "interview_pending", confidence: 0.99 },
        { applicationId: "job-2", matched: false, status: null },
      ],
    });
  });
});
