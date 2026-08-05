import { describe, expect, it } from "vitest";
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
});
