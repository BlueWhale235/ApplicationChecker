import { describe, expect, it, vi } from "vitest";
import { isTransientNavigationError, withNavigationRetry } from "./page-stability.js";

describe("navigation-sensitive page operations", () => {
  it("retries when Puppeteer destroys the execution context during navigation", async () => {
    const page = { waitForNetworkIdle: vi.fn().mockResolvedValue(undefined) };
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("Execution context was destroyed, most likely because of a navigation."))
      .mockResolvedValue("captured");
    await expect(withNavigationRetry(page, operation)).resolves.toBe("captured");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(page.waitForNetworkIdle).toHaveBeenCalledTimes(1);
  });

  it("does not retry unrelated failures", async () => {
    const page = { waitForNetworkIdle: vi.fn().mockResolvedValue(undefined) };
    const operation = vi.fn().mockRejectedValue(new Error("Screenshot is too large"));
    await expect(withNavigationRetry(page, operation)).rejects.toThrow("Screenshot is too large");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(page.waitForNetworkIdle).not.toHaveBeenCalled();
  });

  it("recognizes the navigation race message", () => {
    expect(isTransientNavigationError(new Error("Page navigated during capture"))).toBe(true);
    expect(isTransientNavigationError(new Error("Target closed"))).toBe(false);
  });
});
