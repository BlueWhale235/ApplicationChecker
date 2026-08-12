import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "puppeteer-core";
import type { AssistedParserRule, ScriptRuleApplication } from "@application-checker/contracts";
import { executeScriptRule, normalizeScriptOutput, ScriptRuleExecutionError, selectScriptRule } from "./script-rule.js";

const applications: ScriptRuleApplication[] = [{
  id: "job-1", company: "示例公司", jobTitle: "工程师", checkUrl: "https://careers.example.com/query",
  postingUrl: null, appliedAt: null, location: null, notes: null, site: "example.com", progressStatus: "screening",
}];

function rule(id: string, pathname: string, priority = 100): AssistedParserRule {
  const now = new Date().toISOString();
  return {
    id, name: id, enabled: true, priority, version: 1,
    definition: { schemaVersion: 2, kind: "script", hostname: "careers.example.com", pathname, script: "return null", timeoutMs: 5_000 },
    createdAt: now, updatedAt: now, lastTestedAt: null,
  };
}

function fakePage(): Page {
  return {
    exposeFunction: async (name: string, callback: (...args: unknown[]) => unknown) => {
      (globalThis as Record<string, unknown>)[name] = callback;
    },
    removeExposedFunction: async (name: string) => {
      delete (globalThis as Record<string, unknown>)[name];
    },
    evaluate: async (callback: (input: unknown) => unknown, input: unknown) => callback(input),
    close: async () => {},
  } as unknown as Page;
}

function navigablePage(initialUrl = "https://careers.example.com/query"): Page {
  let currentUrl = initialUrl;
  return {
    exposeFunction: async (name: string, callback: (...args: unknown[]) => unknown) => {
      (globalThis as Record<string, unknown>)[name] = callback;
    },
    removeExposedFunction: async (name: string) => {
      delete (globalThis as Record<string, unknown>)[name];
    },
    evaluate: async (callback: (input: unknown) => unknown, input: unknown) => {
      Object.defineProperty(globalThis, "location", { value: new URL(currentUrl), configurable: true });
      return callback(input);
    },
    goto: async (url: string) => {
      currentUrl = new URL(url, currentUrl).href;
      return null;
    },
    url: () => currentUrl,
    close: async () => {},
  } as unknown as Page;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).location;
});

describe("script rules", () => {
  it("chooses the most specific matching rule", () => {
    expect(selectScriptRule([rule("wide", "/*", 200), rule("specific", "/query", 100)], "https://careers.example.com/query")?.id)
      .toBe("specific");
  });

  it("normalizes a single result and rejects unknown application ids", () => {
    expect(normalizeScriptOutput({ applicationId: "job-1", rawStatus: " 待面试 " }, applications))
      .toEqual([{ applicationId: "job-1", rawStatus: "待面试" }]);
    expect(() => normalizeScriptOutput({ applicationId: "unknown", rawStatus: "待面试" }, applications))
      .toThrow(/未知岗位/);
  });

  it("returns debug logs after a successful script", async () => {
    const scriptRule = rule("logged", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.script = `
      helpers.log("读取状态", { rawStatus: "待面试" });
      return { applicationId: application.id, rawStatus: "待面试" };
    `;
    const result = await executeScriptRule(fakePage(), scriptRule, "job-1", applications);
    expect(result.logs).toEqual([{ atMs: expect.any(Number), message: '读取状态 {"rawStatus":"待面试"}' }]);
    expect(result.logsTruncated).toBe(false);
  });

  it("creates direct status results through helpers.status", async () => {
    const scriptRule = rule("direct-status", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.script = `return helpers.status("screening", { evidence: "页面明确显示初筛" });`;
    const result = await executeScriptRule(fakePage(), scriptRule, "job-1", applications);
    expect(result.results).toEqual([{
      applicationId: "job-1",
      rawStatus: "初筛",
      directStatus: "screening",
      evidence: "页面明确显示初筛",
    }]);
  });

  it("rejects unsupported direct statuses", () => {
    expect(() => normalizeScriptOutput({
      applicationId: "job-1", rawStatus: "未知", directStatus: "unknown",
    }, applications)).toThrow(/不支持的直接状态/);
  });

  it("creates direct status results for every application through helpers.statusAll", async () => {
    const scriptRule = rule("direct-status-all", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.script = `return helpers.statusAll("needs_login", { evidence: "需要登录" });`;
    const result = await executeScriptRule(fakePage(), scriptRule, "job-1", applications);
    expect(result.results).toHaveLength(applications.length);
    expect(result.results.map((item) => item.applicationId)).toEqual(applications.map((item) => item.id));
    expect(result.results.every((item) => item.directStatus === "needs_login")).toBe(true);
  });

  it("exposes embedded selector JSON through helpers.runSelectorRule", async () => {
    const scriptRule = rule("selector-json", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.script = `
      return helpers.runSelectorRule({
        schemaVersion: 2,
        kind: "selector",
        hostname: "other.example.com",
        pathname: "/*",
        container: null,
        title: { tag: "div", role: null, classes: [], dataStatus: null, ariaCurrent: null, ariaSelected: null, ancestorTags: [] },
        status: { tag: "div", role: null, classes: [], dataStatus: null, ariaCurrent: null, ariaSelected: null, ancestorTags: [] }
      });
    `;
    const result = await executeScriptRule(navigablePage(), scriptRule, "job-1", applications);
    expect(result.results).toEqual([]);
  });

  it("uses and cleans up a unique log bridge for each execution on a reused page", async () => {
    const exposed = new Set<string>();
    const names: string[] = [];
    const page = {
      exposeFunction: async (name: string, callback: (...args: unknown[]) => unknown) => {
        if (exposed.has(name)) throw new Error(`duplicate binding: ${name}`);
        exposed.add(name);
        names.push(name);
        (globalThis as Record<string, unknown>)[name] = callback;
      },
      removeExposedFunction: async (name: string) => {
        exposed.delete(name);
        delete (globalThis as Record<string, unknown>)[name];
      },
      evaluate: async (callback: (input: unknown) => unknown, input: unknown) => callback(input),
      close: async () => {},
    } as unknown as Page;
    const scriptRule = rule("reused", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.script = `return { applicationId: application.id, rawStatus: "待面试" };`;

    await executeScriptRule(page, scriptRule, "job-1", applications);
    await executeScriptRule(page, scriptRule, "job-1", applications);

    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names.every((name) => name.startsWith("__applicationCheckerScriptLog_"))).toBe(true);
    expect(exposed.size).toBe(0);
  });

  it("keeps debug logs when the script throws", async () => {
    const scriptRule = rule("failed", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.script = `helpers.log("即将失败"); throw new Error("测试错误");`;
    await expect(executeScriptRule(fakePage(), scriptRule, "job-1", applications)).rejects.toMatchObject({
      name: "ScriptRuleExecutionError",
      message: "Error: 测试错误",
      logs: [{ atMs: expect.any(Number), message: "即将失败" }],
    });
  });

  it("keeps streamed debug logs when the script times out", async () => {
    const scriptRule = rule("timeout", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.timeoutMs = 25;
    scriptRule.definition.script = `helpers.log("等待前"); await new Promise(() => {});`;
    try {
      await executeScriptRule(fakePage(), scriptRule, "job-1", applications);
      throw new Error("expected timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(ScriptRuleExecutionError);
      expect(error).toMatchObject({
        message: "页面脚本执行超过 25ms",
        logs: [{ atMs: expect.any(Number), message: "等待前" }],
      });
    }
  });

  it("reads the current URL and reruns after a controlled navigation", async () => {
    const scriptRule = rule("navigate", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.script = `
      helpers.log("当前地址", helpers.currentUrl());
      if (!helpers.currentUrl().endsWith("/next")) await helpers.goto("/next");
      return { applicationId: application.id, rawStatus: helpers.currentUrl() };
    `;
    const result = await executeScriptRule(navigablePage(), scriptRule, "job-1", applications);
    expect(result.results[0]?.rawStatus).toBe("https://careers.example.com/next");
    expect(result.logs.map((entry) => entry.message)).toEqual([
      "当前地址 https://careers.example.com/query",
      "当前地址 https://careers.example.com/next",
    ]);
  });

  it("rejects navigation outside the rule hostname", async () => {
    const scriptRule = rule("cross-origin", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.script = `await helpers.goto("https://outside.example.net/result");`;
    await expect(executeScriptRule(navigablePage(), scriptRule, "job-1", applications))
      .rejects.toThrow(/规则范围外的域名/);
  });

  it("stops scripts that request navigation in a loop", async () => {
    const scriptRule = rule("navigation-loop", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.script = `await helpers.goto("/next");`;
    await expect(executeScriptRule(navigablePage(), scriptRule, "job-1", applications))
      .rejects.toThrow(/跳转超过 3 次限制/);
  });

  it("provides an Axios-style JSON request helper", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ status: "待面试" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", request);
    const scriptRule = rule("axios", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.script = `
      const response = await helpers.axios.get("https://api.example.net/status", { params: { id: application.id } });
      return { applicationId: application.id, rawStatus: response.data.status };
    `;
    const result = await executeScriptRule(navigablePage(), scriptRule, "job-1", applications);
    expect(result.results[0]?.rawStatus).toBe("待面试");
    expect(String(request.mock.calls[0]?.[0])).toContain("id=job-1");
  });

  it("blocks protected Axios request headers", async () => {
    const scriptRule = rule("axios-header", "/query");
    if (scriptRule.definition.kind !== "script") throw new Error("unexpected rule kind");
    scriptRule.definition.script = `await helpers.axios.get("https://api.example.net/status", { headers: { Cookie: "secret" } });`;
    await expect(executeScriptRule(navigablePage(), scriptRule, "job-1", applications))
      .rejects.toThrow(/不允许设置请求头：Cookie/);
  });
});
