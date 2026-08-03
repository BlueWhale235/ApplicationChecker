import { describe, expect, it } from "vitest";
import {
  assertUnambiguousStatusMappings,
  BUILTIN_STATUS_MAPPINGS,
  EMPTY_STATUS_MAPPINGS,
  formatStatusMappingPrompt,
  matchStatusMapping,
  normalizeCustomStatusMappings,
  parseStatusMappings,
} from "./index.js";

describe("status mapping", () => {
  it("maps the common pending-processing status to screening", () => {
    expect(matchStatusMapping("待处理")?.rule.status).toBe("screening");
  });

  it.each([
    ["业务筛选", "screening_passed"],
    ["待评估", "screening"],
    ["under review", "screening"],
    ["shortlisted", "screening_passed"],
    ["interview scheduled", "interview_pending"],
    ["no longer under consideration", "rejected"],
  ])("maps %s to %s", (raw, status) => {
    expect(matchStatusMapping(raw)?.rule.status).toBe(status);
  });

  it("lets custom pill terms drive local matching and the AI prompt", () => {
    const custom = normalizeCustomStatusMappings({
      ...EMPTY_STATUS_MAPPINGS,
      screening_passed: ["Technical Assessment"],
    });
    expect(matchStatusMapping("Technical Assessment in progress", custom)?.rule.status).toBe("screening_passed");
    expect(formatStatusMappingPrompt(custom)).toContain("Technical Assessment");
  });

  it("loads built-ins for an unconfigured database and preserves a complete configured dictionary", () => {
    expect(parseStatusMappings("{}").screening).toContain("简历筛选");
    const configured = parseStatusMappings(JSON.stringify({
      ...EMPTY_STATUS_MAPPINGS,
      screening: ["Only This Term"],
    }));
    expect(configured.screening).toEqual(["Only This Term"]);
    expect(matchStatusMapping("简历筛选", configured)).toBeNull();
  });

  it("rejects a custom term that conflicts with another built-in category", () => {
    const custom = normalizeCustomStatusMappings({
      ...BUILTIN_STATUS_MAPPINGS,
      screening: [...BUILTIN_STATUS_MAPPINGS.screening, "rejected"],
    });
    expect(() => assertUnambiguousStatusMappings(custom)).toThrow("同时属于");
  });
});
