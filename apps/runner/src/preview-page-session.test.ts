import { describe, expect, it, vi } from "vitest";
import type { Page } from "puppeteer-core";
import type { BrowserLease } from "./browser-pool.js";
import { PreviewPageSessionManager, type PreviewPageResource } from "./preview-page-session.js";

function resource(closed = false): PreviewPageResource & { release: ReturnType<typeof vi.fn> } {
  const release = vi.fn(async () => {});
  return {
    lease: { context: {} as BrowserLease["context"], release },
    page: { isClosed: () => closed } as Page,
    responseStatus: 200,
    release,
  };
}

describe("PreviewPageSessionManager", () => {
  it("reuses one retained page and transfers ownership while it is checked out", async () => {
    const sessions = new PreviewPageSessionManager();
    const first = resource();
    await sessions.retain("preview-1", first);
    expect(sessions.take("preview-1")).toMatchObject({ responseStatus: 200 });
    expect(sessions.take("preview-1")).toBeNull();
    expect(first.release).not.toHaveBeenCalled();
  });

  it("releases the previous page when a new preview is retained", async () => {
    const sessions = new PreviewPageSessionManager();
    const first = resource();
    const second = resource();
    await sessions.retain("preview-1", first);
    await sessions.retain("preview-2", second);
    expect(first.release).toHaveBeenCalledOnce();
    await sessions.close();
    expect(second.release).toHaveBeenCalledOnce();
  });

  it("expires an idle page and ignores releases for another preview", async () => {
    vi.useFakeTimers();
    const sessions = new PreviewPageSessionManager(3_000);
    const retained = resource();
    await sessions.retain("preview-1", retained);
    await sessions.release("preview-2");
    expect(retained.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(retained.release).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("drops a page that was closed while idle", async () => {
    const sessions = new PreviewPageSessionManager();
    const retained = resource(true);
    await sessions.retain("preview-1", retained);
    expect(sessions.take("preview-1")).toBeNull();
    await vi.waitFor(() => expect(retained.release).toHaveBeenCalledOnce());
  });

  it("does not retain a page after the editor already requested release", async () => {
    const sessions = new PreviewPageSessionManager();
    await sessions.release("preview-1");
    const late = resource();
    await sessions.retain("preview-1", late);
    expect(late.release).toHaveBeenCalledOnce();
    expect(sessions.take("preview-1")).toBeNull();
  });
});
