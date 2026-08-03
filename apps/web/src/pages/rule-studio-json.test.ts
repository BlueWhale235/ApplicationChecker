import { describe, expect, it } from "vitest";
import { parseSelectorRuleJson } from "./rule-studio-json";

const validDefinition = {
  schemaVersion: 2,
  kind: "selector",
  hostname: "careers.example.com",
  pathname: "/applications/*",
  container: null,
  title: { tag: "h3", role: null, classes: [], dataStatus: null, ariaCurrent: null, ariaSelected: null, ancestorTags: [] },
  status: { tag: "span", role: null, classes: [], dataStatus: null, ariaCurrent: null, ariaSelected: null, ancestorTags: [] },
};

describe("selector rule JSON editing", () => {
  it("accepts a selector definition", () => {
    expect(parseSelectorRuleJson(JSON.stringify(validDefinition))).toEqual({ definition: validDefinition, error: null });
  });

  it("rejects malformed JSON and non-selector definitions", () => {
    expect(parseSelectorRuleJson("{").error).toBeTruthy();
    expect(parseSelectorRuleJson(JSON.stringify({ ...validDefinition, kind: "script" })).error).toMatch(/selector/);
  });
});
