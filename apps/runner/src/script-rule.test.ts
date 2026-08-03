import { describe, expect, it } from "vitest";
import type { AssistedParserRule, ScriptRuleApplication } from "@application-checker/contracts";
import { normalizeScriptOutput, selectScriptRule } from "./script-rule.js";

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
});
