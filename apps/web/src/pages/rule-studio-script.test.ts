import { describe, expect, it } from "vitest";
import {
  canSaveScriptRule,
  matchingCheckGroupApplicationId,
  scriptRuleDefinitionSignature,
  scriptRuleDialogSignature,
  type ScriptRuleDraft,
} from "./rule-studio-script";

const draft: ScriptRuleDraft = {
  name: "招聘状态脚本",
  hostname: "careers.example.com",
  pathname: "/applications/*",
  script: "return { applicationId: application.id, rawStatus: helpers.text('.status') };",
  timeoutMs: 30_000,
};

describe("script rule editing", () => {
  it("selects the matching check group instead of retaining a previous rule selection", () => {
    const scriptRule = {
      id: "rule-1", name: "乙公司 后端工程师", enabled: true, priority: 100, version: 1,
      definition: {
        schemaVersion: 2 as const, kind: "script" as const, hostname: "careers.example.com",
        pathname: "/applications/*", script: "return null", timeoutMs: 10_000,
      },
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lastTestedAt: null,
    };
    expect(matchingCheckGroupApplicationId(scriptRule, [
      {
        applicationId: "job-a", groupId: "group-a", company: "甲公司", jobTitle: "前端工程师",
        site: "example.com", url: "https://careers.example.com/applications/a", memberCount: 1,
      },
      {
        applicationId: "job-b", groupId: "group-b", company: "乙公司", jobTitle: "后端工程师",
        site: "example.com", url: "https://careers.example.com/applications/b", memberCount: 1,
      },
      {
        applicationId: "job-old", groupId: "group-old", company: "旧公司", jobTitle: "测试工程师",
        site: "other.example", url: "https://other.example/applications/old", memberCount: 1,
      },
    ])).toBe("job-b");
  });

  it("clears the selection when no check group matches the rule scope", () => {
    const scriptRule = {
      id: "rule-1", name: "规则", enabled: true, priority: 100, version: 1,
      definition: {
        schemaVersion: 2 as const, kind: "script" as const, hostname: "careers.example.com",
        pathname: "/applications/*", script: "return null", timeoutMs: 10_000,
      },
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lastTestedAt: null,
    };
    expect(matchingCheckGroupApplicationId(scriptRule, [{
      applicationId: "job-old", groupId: "group-old", company: "旧公司", jobTitle: "测试工程师",
      site: "other.example", url: "https://other.example/applications/old", memberCount: 1,
    }])).toBe("");
  });

  it("allows metadata-only edits to an existing rule without rerunning the script", () => {
    const initialDefinitionSignature = scriptRuleDefinitionSignature(draft);
    expect(canSaveScriptRule({
      draft: { ...draft, name: "新的规则名称" },
      editing: true,
      initialDefinitionSignature,
      lastTestedDefinitionSignature: "",
      testPassed: false,
    })).toBe(true);
  });

  it("requires a successful test after executable settings change", () => {
    const initialDefinitionSignature = scriptRuleDefinitionSignature(draft);
    const changedDraft = { ...draft, timeoutMs: 45_000 };
    expect(canSaveScriptRule({
      draft: changedDraft,
      editing: true,
      initialDefinitionSignature,
      lastTestedDefinitionSignature: "",
      testPassed: false,
    })).toBe(false);
    expect(canSaveScriptRule({
      draft: changedDraft,
      editing: true,
      initialDefinitionSignature,
      lastTestedDefinitionSignature: scriptRuleDefinitionSignature(changedDraft),
      testPassed: true,
    })).toBe(true);
  });

  it("rejects empty names and invalid scopes", () => {
    for (const invalidDraft of [
      { ...draft, name: " " },
      { ...draft, hostname: "" },
      { ...draft, pathname: "" },
    ]) {
      expect(canSaveScriptRule({
        draft: invalidDraft,
        editing: true,
        initialDefinitionSignature: scriptRuleDefinitionSignature(invalidDraft),
        lastTestedDefinitionSignature: "",
        testPassed: false,
      })).toBe(false);
    }
  });

  it("tracks all full-screen dialog fields as unsaved changes", () => {
    const dialogDraft = { ...draft, priority: 100, enabled: true };
    const initial = scriptRuleDialogSignature(dialogDraft);
    for (const changed of [
      { ...dialogDraft, name: "renamed" },
      { ...dialogDraft, priority: 200 },
      { ...dialogDraft, enabled: false },
      { ...dialogDraft, script: `${dialogDraft.script}\nhelpers.log('changed');` },
    ]) {
      expect(scriptRuleDialogSignature(changed)).not.toBe(initial);
    }
  });
});
