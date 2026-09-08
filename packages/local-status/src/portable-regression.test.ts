import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LocalPageSnapshot } from "@application-checker/contracts";
import { recognizeLocalPage, isLocalOnlyRoute, type LocalRecognitionCandidate } from "./index.js";
function fixture(name: string): { snapshot: LocalPageSnapshot; candidates: LocalRecognitionCandidate[] } {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}
describe("portable real DOM regressions", () => {
  it.each(["beisen-cities", "beisen-codes", "moka-wrappers"])("recognizes %s without AI", (name) => {
    const { snapshot, candidates } = fixture(name);
    const results = recognizeLocalPage(snapshot, candidates).results;
    expect(results).toHaveLength(candidates.length);
    for (const item of results) expect(item).toMatchObject({ matched: true, status: "screening" });
  });
  it("does not translate or guess an unrelated saved alias", () => {
    const { snapshot, candidates } = fixture("moka-unmatched-alias");
    expect(recognizeLocalPage(snapshot, candidates).results[0]).toMatchObject({ matched: false, evidence: "未在页面中找到岗位标题" });
  });
  it("keeps different job codes and their statuses isolated", () => {
    const { snapshot, candidates } = fixture("beisen-codes");
    const statusNodes = snapshot.nodes.filter((node) => node.text.startsWith("当前进度："));
    statusNodes[0]!.text = "当前进度：已淘汰";
    statusNodes[1]!.text = "当前进度：待面试";
    expect(recognizeLocalPage(snapshot, candidates).results.map((item) => item.status)).toEqual(["rejected", "interview_pending", "screening"]);
  });
  it("does not take another code with the same title", () => {
    const { snapshot, candidates } = fixture("beisen-codes");
    candidates[0]!.jobTitle = "销售专员（深圳）(J99999)";
    expect(recognizeLocalPage(snapshot, candidates).results[0]!.matched).toBe(false);
  });
  it.each(["https://app.mokahr.com/campus-recruitment/x/1", "https://x.zhiye.com/personal/deliveryRecord"])("guards route %s without DOM", (url) => expect(isLocalOnlyRoute(url)).toBe(true));
  it("does not classify unrelated domains as supported routes", () => expect(isLocalOnlyRoute("https://mokahr.com.example.org/a")).toBe(false));
});
