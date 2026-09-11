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
  LOCAL_PARSER_VERSION,
  MOKAHR_PARSER_VERSION,
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

  it("uses an independent MokaHR 1.0.2 adapter version", () => {
    expect(resolveParserAdapter(snapshot("https://app.mokahr.com/candidate/applications/deliver-query/sunnyoptical", [])).adapter?.version)
      .toBe(MOKAHR_PARSER_VERSION);
    expect(MOKAHR_PARSER_VERSION).toBe("1.0.2");
    expect(resolveParserAdapter(snapshot("https://app.zhiye.com/personal/delivery", [])).adapter?.version).toBe(LOCAL_PARSER_VERSION);
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

  it("scopes Mokahr preference cards and recognizes multiple applications independently", () => {
    const result = recognizeLocalPage(snapshot("https://app.mokahr.com/campus-recruitment/sungrow/94416", [
      node(1, "", 0, null, ["preference-card"]),
      node(2, "\u56fd\u5185\u5ba2\u6237\u7ecf\u7406", 10, 1, ["preference-top"]),
      node(3, "\u6295\u9012\u6210\u529f", 50, 1),
      node(4, "", 120, null, ["preference-card"]),
      node(5, "\u3010\u63d0\u524d\u6279\u3011\u6d77\u5916\u6218\u7565\u5927\u5ba2\u6237\u670d\u52a1\u4e13\u5458", 130, 4, ["preference-top"]),
      node(6, "\u6682\u4e0d\u5339\u914d", 170, 4),
    ]), [
      { id: "job-1", jobTitle: "\u56fd\u5185\u5ba2\u6237\u7ecf\u7406" },
      { id: "job-2", jobTitle: "\u3010\u63d0\u524d\u6279\u3011\u6d77\u5916\u6218\u7565\u5927\u5ba2\u6237\u670d\u52a1\u4e13\u5458" },
    ], {
      screening: [],
      screening_passed: [],
      interview_pending: [],
      interviewed: [],
      signing_pending: [],
      offer: [],
      rejected: ["\u4e0d\u5339\u914d"],
    });

    expect(result.results).toMatchObject([
      { applicationId: "job-1", matched: true, rawStatus: "\u6295\u9012\u6210\u529f", status: "screening" },
      { applicationId: "job-2", matched: true, rawStatus: "\u4e0d\u5339\u914d", status: "rejected" },
    ]);
  });

  it("uses only the current MokaHR timeline step and ignores future OFFER steps", () => {
    const result = recognizeLocalPage(snapshot("https://app.mokahr.com/campus-recruitment/sunnyoptical/45602#/candidateHome/applications", [
      node(1, "", 0, null, ["application-card"]),
      node(2, "销售-国内客户", 20, 1),
      node(3, "", 80, 1, ["timeline-step", "active"]),
      node(4, "投递成功", 80, 3),
      node(5, "简历分配", 80, 1, ["timeline-step"]),
      node(6, "初筛", 80, 1, ["timeline-step"]),
      node(7, "OFFER", 80, 1, ["timeline-step"]),
      node(8, "拟录用", 80, 1, ["timeline-step"]),
      node(9, "", 220, null, ["application-card"]),
      node(10, "舜宇集团2027届校园大使", 240, 9),
      node(11, "状态", 280, 9),
      node(12, "暂不匹配", 280, 9),
    ]), [
      { id: "sales", jobTitle: "销售-国内客户" },
      { id: "ambassador", jobTitle: "舜宇集团2027届校园大使" },
    ]);
    expect(result).toMatchObject({ adapterId: "mokahr", adapterVersion: MOKAHR_PARSER_VERSION });
    expect(result.results).toMatchObject([
      { applicationId: "sales", matched: true, rawStatus: "投递成功", status: "screening" },
      { applicationId: "ambassador", matched: true, rawStatus: "不匹配", status: "rejected" },
    ]);
  });

  it("recognizes MokaHR target-view as the current timeline node", () => {
    const result = recognizeLocalPage(snapshot("https://app.mokahr.com/campus-recruitment/sunnyoptical/45602#/candidateHome/applications", [
      node(1, "", 0, null, ["application-card"]),
      node(2, "销售-国内客户", 20, 1),
      node(3, "1 投递成功", 80, 1, ["flow-container", "target-view"]),
      node(4, "投递成功", 100, 3, ["flow-box-name"]),
      node(5, "3 初筛", 80, 1, ["flow-container"]),
      node(6, "初筛", 100, 5, ["flow-box-name"]),
      node(7, "8 OFFER", 80, 1, ["flow-container"]),
      node(8, "OFFER", 100, 7, ["flow-box-name"]),
    ]), [{ id: "sales", jobTitle: "销售-国内客户" }]);
    expect(result.results[0]).toMatchObject({ matched: true, rawStatus: "投递成功", status: "screening" });
  });

  it("recognizes the compact MokaHR deliver-query card", () => {
    const result = recognizeLocalPage(snapshot("https://app.mokahr.com/candidate/applications/deliver-query/nuvoltatech", [
      node(1, "", 100, null, ["application-card"]),
      node(2, "【2027秋招】销售工程师", 120, 1),
      node(3, "初筛", 120, 1),
      node(4, "投递时间：2026-08-07", 160, 1),
    ]), [{ id: "job-1", jobTitle: "【2027秋招】销售工程师" }]);
    expect(result).toMatchObject({ adapterId: "mokahr", adapterVersion: MOKAHR_PARSER_VERSION });
    expect(result.results[0]).toMatchObject({ matched: true, rawStatus: "初筛", status: "screening" });
  });

  it("does not guess from an unmarked MokaHR future timeline", () => {
    const result = recognizeLocalPage(snapshot("https://app.mokahr.com/campus-recruitment/example/1#/candidateHome/applications", [
      node(1, "", 0, null, ["application-card"]),
      node(2, "产品经理", 20, 1),
      node(3, "初筛", 80, 1, ["timeline-step"]),
      node(4, "OFFER", 80, 1, ["timeline-step"]),
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
      logs: [],
      logsTruncated: false,
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

  it("prefers a terminal status category over a longer earlier-stage term", () => {
    const result = recognizeScriptExecution({
      ruleId: "script-beisen",
      ruleVersion: 1,
      durationMs: 10,
      results: [{
        applicationId: "job-1",
        rawStatus: "简历初筛-本轮淘汰",
        evidence: "北森接口返回复合状态",
      }],
      logs: [],
      logsTruncated: false,
    }, [{ id: "job-1", jobTitle: "销售工程师" }]);

    expect(result.results[0]).toMatchObject({
      matched: true,
      rawStatus: "简历初筛-本轮淘汰",
      status: "rejected",
      statusRule: "rejected",
      confidence: 0.99,
    });
  });

  it("accepts direct progress and login statuses without text mapping", () => {
    const direct = recognizeScriptExecution({
      ruleId: "script-direct", ruleVersion: 1, durationMs: 5,
      results: [{ applicationId: "job-1", rawStatus: "未设置", directStatus: "unset" }],
      logs: [], logsTruncated: false,
    }, [{ id: "job-1", jobTitle: "工程师" }]);
    expect(direct.results[0]).toMatchObject({
      matched: true, status: "unset", confidence: 1, statusRule: "script_direct:unset",
    });

    const login = recognizeScriptExecution({
      ruleId: "script-login", ruleVersion: 1, durationMs: 5,
      results: [{ applicationId: "job-1", rawStatus: "login_required", directStatus: "needs_login" }],
      logs: [], logsTruncated: false,
    }, [{ id: "job-1", jobTitle: "工程师" }]);
    expect(login.results[0]).toMatchObject({
      matched: false, rawStatus: "login_required", status: null, statusRule: "script_direct:needs_login",
    });
  });

  it("preserves controlled script errors as final unmatched results", () => {
    const result = recognizeScriptExecution({
      ruleId: "script-error", ruleVersion: 1, durationMs: 5,
      results: [{ applicationId: "job-1", rawStatus: "script_error", error: "脚本运行时错误", errorLine: 4 }],
      logs: [], logsTruncated: false,
    }, [{ id: "job-1", jobTitle: "工程师" }]);
    expect(result.results[0]).toMatchObject({
      matched: false, rawStatus: "script_error", status: null,
      evidence: "Line:4，脚本运行时错误", statusRule: "script_error",
    });
  });
});
