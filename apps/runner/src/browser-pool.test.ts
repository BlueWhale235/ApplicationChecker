import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, BrowserContext } from "puppeteer-core";
import { describe, expect, it, vi } from "vitest";
import { BrowserPool } from "./browser-pool.js";

function fakeBrowser() {
  const events = new EventEmitter();
  const contexts: Array<{ proxyServer: string | undefined; close: ReturnType<typeof vi.fn> }> = [];
  const close = vi.fn(async () => {
    events.emit("disconnected");
  });
  const browser = Object.assign(events, {
    createBrowserContext: vi.fn(async (options?: { proxyServer?: string }) => {
      const context = {
        proxyServer: options?.proxyServer,
        close: vi.fn(async () => {}),
      };
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
    close,
  }) as unknown as Browser;
  return { browser, contexts, close };
}

describe("BrowserPool", () => {
  it("reuses a process while isolating jobs in separate contexts", async () => {
    const instance = fakeBrowser();
    const launch = vi.fn(async () => instance.browser);
    const pool = new BrowserPool({
      name: "test",
      profilePath: path.join(tmpdir(), `application-checker-pool-${crypto.randomUUID()}`),
      idleTimeoutMs: 60_000,
      maxUses: 2,
      launch,
    });

    try {
      await pool.prewarm();
      const first = await pool.acquire("http://127.0.0.1:8001");
      await first.release();
      await first.release();
      const second = await pool.acquire(null);
      await second.release();

      expect(launch).toHaveBeenCalledTimes(1);
      expect(instance.contexts.map((context) => context.proxyServer)).toEqual([
        "http://127.0.0.1:8001",
        undefined,
      ]);
      expect(instance.contexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
      expect(instance.close).toHaveBeenCalledTimes(1);
    } finally {
      await pool.close();
    }
  });

  it("retires an unused prewarmed process after its idle timeout", async () => {
    vi.useFakeTimers();
    const instance = fakeBrowser();
    const pool = new BrowserPool({
      name: "idle-test",
      profilePath: path.join(tmpdir(), `application-checker-pool-${crypto.randomUUID()}`),
      idleTimeoutMs: 500,
      maxUses: 30,
      launch: async () => instance.browser,
    });

    try {
      await pool.prewarm();
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(instance.close).toHaveBeenCalledTimes(1));
    } finally {
      await pool.close();
      vi.useRealTimers();
    }
  });
});
