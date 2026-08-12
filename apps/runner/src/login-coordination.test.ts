import { describe, expect, it } from "vitest";
import type { LocalPageSnapshot } from "@application-checker/contracts";
import type { AttentionDetection } from "./detection.js";
import { effectiveLoginRequired, isSoftMokahrLoginDetection } from "./login-coordination.js";

const softDetection: AttentionDetection = {
  score: 65,
  requiresLogin: true,
  reason: "login_required",
  signals: ["password_field"],
};

function snapshot(url: string, title = "【2027秋招】销售工程师", status = "初筛"): LocalPageSnapshot {
  return {
    url,
    title: "投递记录",
    language: "zh-CN",
    visibleText: `${title}\n${status}`,
    truncated: false,
    nodeLimitReached: false,
    textLimitReached: false,
    nodes: [
      { id: 1, parentId: null, tag: "div", role: null, classes: ["application-card"], dataStatus: null, text: "", x: 10, y: 10, width: 800, height: 180 },
      { id: 2, parentId: 1, tag: "div", role: null, classes: [], dataStatus: null, text: title, x: 30, y: 40, width: 500, height: 30 },
      { id: 3, parentId: 1, tag: "div", role: null, classes: [], dataStatus: null, text: status, x: 700, y: 40, width: 60, height: 30 },
    ],
  };
}

describe("MokaHR login coordination", () => {
  const applications = [{ id: "job-1", jobTitle: "【2027秋招】销售工程师" }];

  it("lets reliable MokaHR status recognition override dormant login controls", () => {
    expect(effectiveLoginRequired(
      softDetection,
      snapshot("https://app.mokahr.com/candidate/applications/deliver-query/nuvoltatech"),
      applications,
    )).toBe(false);
  });

  it("keeps explicit login routes classified as requiring login", () => {
    const detection = { ...softDetection, signals: ["login_url", "password_field"] };
    const url = "https://app.mokahr.com/login";
    expect(isSoftMokahrLoginDetection(detection, url)).toBe(false);
    expect(effectiveLoginRequired(detection, snapshot(url), applications)).toBe(true);
  });

  it("keeps login classification when no target status can be recognized", () => {
    expect(effectiveLoginRequired(
      softDetection,
      snapshot("https://app.mokahr.com/candidate/applications/deliver-query/nuvoltatech", "其他岗位", "初筛"),
      applications,
    )).toBe(true);
  });

  it("does not relax login detection for other sites", () => {
    expect(effectiveLoginRequired(
      softDetection,
      snapshot("https://example.com/applications"),
      applications,
    )).toBe(true);
  });
});
