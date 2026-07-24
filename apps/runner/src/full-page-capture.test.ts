import { describe, expect, it, vi } from "vitest";
import type { Page } from "puppeteer-core";
import { captureFullPage } from "./full-page-capture.js";

function pageWithDimensions(width: number, height: number) {
  const evaluate = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ width, height });
  const screenshot = vi.fn().mockResolvedValue(Buffer.from("png"));
  return {
    page: { evaluate, screenshot } as unknown as Page,
    evaluate,
    screenshot,
  };
}

describe("full page capture", () => {
  it("uses Chromium full-page capture after preparing inner scrollers", async () => {
    const { page, evaluate, screenshot } = pageWithDimensions(1440, 4200);
    const result = await captureFullPage(page);

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({
      fullPage: true,
      captureBeyondViewport: true,
    }));
    expect(result).toEqual({ data: Buffer.from("png"), truncated: false });
  });

  it("caps oversized pages at 20,000 pixels and marks them truncated", async () => {
    const { page, screenshot } = pageWithDimensions(1440, 25_000);
    const result = await captureFullPage(page);

    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({
      clip: { x: 0, y: 0, width: 1440, height: 20_000 },
    }));
    expect(result.truncated).toBe(true);
  });
});
