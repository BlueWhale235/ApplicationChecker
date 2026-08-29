import type { BrowserContext, Page } from "puppeteer-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserPool } from "./browser-pool.js";
import { isLoginPageAvailable, LoginWorkspace } from "./login-workspace.js";

function setupWorkspace(idleTimeoutMs = 30 * 60_000) {
  let closed = false;
  let connected = true;
  const session = {
    send: vi.fn(async (method: string) => method === "Browser.getWindowForTarget" ? { windowId: 1 } : {}),
    detach: vi.fn(async () => {}),
  };
  const context = {
    cookies: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  } as unknown as BrowserContext;
  const page = {
    isClosed: vi.fn(() => closed),
    browser: vi.fn(() => ({ connected })),
    setUserAgent: vi.fn(async () => {}),
    goto: vi.fn(async () => null),
    bringToFront: vi.fn(async () => {}),
    browserContext: vi.fn(() => context),
    createCDPSession: vi.fn(async () => session),
    deleteCookie: vi.fn(async () => {}),
  } as unknown as Page;
  const newPage = vi.fn(async () => page);
  Object.assign(context, { newPage });
  const release = vi.fn(async () => {});
  const pool = {
    acquire: vi.fn(async () => ({ context, release })),
    retireIfIdle: vi.fn(async () => {}),
  } as unknown as BrowserPool;
  return {
    workspace: new LoginWorkspace(pool, idleTimeoutMs),
    pool: pool as unknown as { acquire: ReturnType<typeof vi.fn>; retireIfIdle: ReturnType<typeof vi.fn> },
    page,
    session,
    newPage,
    release,
    closePage: () => { closed = true; },
    disconnectBrowser: () => { connected = false; },
  };
}

afterEach(() => vi.useRealTimers());

describe("LoginWorkspace", () => {
  it("reuses one context and retires it after thirty idle minutes", async () => {
    vi.useFakeTimers();
    const fixture = setupWorkspace();
    const input = {
      url: "https://jobs.example.com/status",
      site: "example.com",
      userAgent: "test",
      proxyUrl: null,
      browserState: null,
    };
    await fixture.workspace.open(input);
    await fixture.workspace.park();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    await fixture.workspace.open(input);
    await fixture.workspace.park();

    expect(fixture.pool.acquire).toHaveBeenCalledTimes(1);
    expect(fixture.newPage).toHaveBeenCalledTimes(1);
    expect(fixture.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.pool.retireIfIdle).toHaveBeenCalledTimes(1);
  });

  it("recreates a page closed by the user without launching another browser lease", async () => {
    const fixture = setupWorkspace();
    const input = {
      url: "https://jobs.example.com/status",
      site: "example.com",
      userAgent: "test",
      proxyUrl: null,
      browserState: null,
    };
    await fixture.workspace.open(input);
    fixture.closePage();
    await fixture.workspace.open(input);
    expect(fixture.pool.acquire).toHaveBeenCalledTimes(1);
    expect(fixture.newPage).toHaveBeenCalledTimes(2);
    await fixture.workspace.close();
  });

  it("restores a minimized window without forcing it to maximize", async () => {
    const fixture = setupWorkspace();
    await fixture.workspace.open({
      url: "https://jobs.example.com/status",
      site: "example.com",
      userAgent: "test",
      proxyUrl: null,
      browserState: null,
    });
    expect(fixture.session.send).toHaveBeenCalledWith("Browser.setWindowBounds", {
      windowId: 1,
      bounds: { windowState: "normal" },
    });
    expect(fixture.session.send).not.toHaveBeenCalledWith("Browser.setWindowBounds", {
      windowId: 1,
      bounds: { windowState: "maximized" },
    });
    await fixture.workspace.close();
  });

  it("reports a closed page or disconnected browser as unavailable", () => {
    const closed = setupWorkspace();
    expect(isLoginPageAvailable(closed.page)).toBe(true);
    closed.closePage();
    expect(isLoginPageAvailable(closed.page)).toBe(false);

    const disconnected = setupWorkspace();
    disconnected.disconnectBrowser();
    expect(isLoginPageAvailable(disconnected.page)).toBe(false);
  });
});
