import { afterEach, describe, expect, it, vi } from "vitest";
import { startAppPolling } from "./app-polling";

afterEach(() => {
  vi.useRealTimers();
});

describe("application refresh scheduling", () => {
  it("polls applications every 30 seconds while keeping lightweight status polling at 5 seconds", async () => {
    vi.useFakeTimers();
    const refreshApplications = vi.fn(async () => {});
    const refreshHealth = vi.fn(async () => {});
    const refreshUnreadNotifications = vi.fn(async () => {});

    const stop = startAppPolling({ refreshApplications, refreshHealth, refreshUnreadNotifications });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refreshApplications).not.toHaveBeenCalled();
    expect(refreshHealth).toHaveBeenCalledTimes(5);
    expect(refreshUnreadNotifications).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(1);
    expect(refreshApplications).toHaveBeenCalledTimes(1);
    expect(refreshHealth).toHaveBeenCalledTimes(6);
    expect(refreshUnreadNotifications).toHaveBeenCalledTimes(6);

    stop();
  });

  it("does not overlap slow application refreshes", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const refreshApplications = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = startAppPolling({
      refreshApplications,
      refreshHealth: async () => {},
      refreshUnreadNotifications: async () => {},
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshApplications).toHaveBeenCalledTimes(1);
    release();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshApplications).toHaveBeenCalledTimes(2);

    stop();
  });
});
