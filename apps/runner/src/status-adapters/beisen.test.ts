import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "puppeteer-core";
import type { ScriptRuleApplication } from "@application-checker/contracts";
import { beisenRuntimeStatusAdapter } from "./beisen.js";
import { executeRuntimeStatusAdapter, resolveRuntimeStatusAdapter } from "./index.js";

const applications: ScriptRuleApplication[] = [
  {
    id: "job-1", company: "示例公司", jobTitle: "项目专员（J11369）",
    checkUrl: "https://example.zhiye.com/personal/deliveryRecord", postingUrl: null,
    appliedAt: null, location: null, notes: null, site: "zhiye.com", progressStatus: "screening",
  },
  {
    id: "job-2", company: "示例公司", jobTitle: "销售管培生",
    checkUrl: "https://example.zhiye.com/personal/deliveryRecord", postingUrl: null,
    appliedAt: null, location: null, notes: null, site: "zhiye.com", progressStatus: "screening",
  },
];

function page(url = "https://example.zhiye.com/personal/deliveryRecord"): Page {
  return {
    exposeFunction: async (name: string, callback: (...args: unknown[]) => unknown) => {
      (globalThis as Record<string, unknown>)[name] = callback;
    },
    removeExposedFunction: async (name: string) => {
      delete (globalThis as Record<string, unknown>)[name];
    },
    evaluate: async (callback: (input: unknown) => unknown, input: unknown) => {
      Object.defineProperty(globalThis, "location", { value: new URL(url), configurable: true });
      return callback(input);
    },
    url: () => url,
    close: async () => {},
  } as unknown as Page;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).location;
});

describe("Beisen runtime status adapter", () => {
  it("is resolved only for zhiye.com", () => {
    expect(resolveRuntimeStatusAdapter("https://company.zhiye.com/personal/deliveryRecord")?.id).toBe("beisen-api");
    expect(resolveRuntimeStatusAdapter("https://zhiye.com/personal/deliveryRecord")?.id).toBe("beisen-api");
    expect(resolveRuntimeStatusAdapter("https://zhiye.com.example.org/")).toBeNull();
  });

  it("can be selected explicitly for a custom domain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      Code: 200,
      Data: {
        Finished: { Submissions: [{ Datas: [
          { ApplyId: "custom", JobAdTitle: "项目专员", DeliveryStatus: "筛选中" },
        ] }] },
        UnFinished: { Submissions: [] },
      },
    })));

    const result = await executeRuntimeStatusAdapter({
      page: page("https://career.example.com/applications"),
      primaryApplicationId: "job-1",
      applications,
      routeAdapterId: "beisen",
    });

    expect(result?.results[0]).toMatchObject({ applicationId: "job-1", rawStatus: "筛选中" });
  });

  it("loads records, deduplicates by ApplyId, strips job codes and prioritizes cancellation", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({
      Code: 200,
      Data: {
        Finished: { Submissions: [{ Datas: [
          { ApplyId: "same", JobAdTitle: "项目专员", JobCode: "J11369", DeliveryStatus: "筛选中", DeliveryDate: "2026-09-01" },
          { ApplyId: "same", JobAdTitle: "项目专员", JobCode: "J11369", DeliveryStatus: "筛选中", DeliveryDate: "2026-09-01", IsCancel: true },
        ] }] },
        UnFinished: { Submissions: [{ Datas: [
          { Id: "sales", JobAdTitle: "2027届销售管培生", JobCode: "J10001", DeliveryStatus: "业务筛选", DeliveryDate: "2026-09-02" },
        ] }] },
      },
    }));
    vi.stubGlobal("fetch", request);

    const result = await beisenRuntimeStatusAdapter.execute({
      page: page(), primaryApplicationId: "job-1", applications,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toBe("https://example.zhiye.com/api/Submission/GetAllDeliveryRecord");
    expect(result.results).toMatchObject([
      { applicationId: "job-1", rawStatus: "投递已撤销" },
      { applicationId: "job-2", rawStatus: "业务筛选" },
    ]);
    expect(result.logs.some((entry) => entry.message.includes("北森投递记录"))).toBe(true);
  });

  it("returns needs_login for a login ReturnUrl", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ Code: 302, ReturnUrl: "/login?returnUrl=%2Fpersonal" })));
    const result = await beisenRuntimeStatusAdapter.execute({
      page: page(), primaryApplicationId: "job-1", applications,
    });
    expect(result.results).toHaveLength(2);
    expect(result.results.every((item) => item.directStatus === "needs_login")).toBe(true);
  });

  it("returns needs_login for HTTP 401 without retrying", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ Message: "unauthorized" }, 401));
    vi.stubGlobal("fetch", request);
    const result = await beisenRuntimeStatusAdapter.execute({
      page: page(), primaryApplicationId: "job-1", applications,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.results.every((item) => item.directStatus === "needs_login")).toBe(true);
  });
});
