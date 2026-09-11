import { describe, expect, it } from "vitest";
import { filterScriptApiSections, SCRIPT_API_SECTIONS } from "./script-api-docs";

describe("script API documentation", () => {
  it("documents every helper exposed by the runner", () => {
    const signatures = SCRIPT_API_SECTIONS.flatMap((section) => section.entries.map((entry) => entry.signature)).join("\n");
    for (const helper of [
      "currentUrl", "goto", "routeAdapter", "axios", "log", "status", "statusAll", "error", "errorAll", "runSelectorRule", "exists", "count", "text", "texts", "textsWithin", "value", "attr", "nextText", "closestText",
      "fill", "select", "click", "waitForSelector", "waitForText", "waitForTextChange", "scrollIntoView", "sleep",
    ]) expect(signatures).toContain(`helpers.${helper}`);
  });

  it("explains adapter routing without describing it as navigation", () => {
    const entry = SCRIPT_API_SECTIONS.flatMap((section) => section.entries)
      .find((candidate) => candidate.signature.includes("helpers.routeAdapter"));
    expect(entry).toMatchObject({ description: expect.stringContaining("内置适配器") });
    expect(`${entry?.detail} ${entry?.example}`).toContain("不会跳转页面");
    expect(entry?.example).toContain("domainAdapters");
  });

  it("filters entries by signature and Chinese description", () => {
    expect(filterScriptApiSections("waitForSelector")[0]?.entries).toHaveLength(1);
    expect(filterScriptApiSections("投递时间")[0]?.entries[0]?.signature).toContain("appliedAt");
    expect(filterScriptApiSections("不存在的 API")).toEqual([]);
  });
});
