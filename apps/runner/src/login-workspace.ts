import type { Page } from "puppeteer-core";
import type { BrowserStateEnvelope } from "@application-checker/contracts";
import { BrowserPool, type BrowserLease } from "./browser-pool.js";
import { installBrowserState, restoreIndexedDbState } from "./browser-state.js";

function belongsToSite(hostname: string, site: string): boolean {
  const normalized = hostname.replace(/^\./, "").toLowerCase();
  return normalized === site || normalized.endsWith(`.${site}`);
}

export function isLoginPageAvailable(page: Page): boolean {
  return !page.isClosed() && page.browser().connected;
}

export class LoginWorkspace {
  private lease: BrowserLease | null = null;
  private page: Page | null = null;
  private idleTimer: NodeJS.Timeout | undefined;
  private currentSite: string | null = null;
  private currentOrigins = new Set<string>();

  constructor(
    private readonly pool: BrowserPool,
    private readonly idleTimeoutMs = 30 * 60_000,
  ) {}

  async open(input: {
    url: string;
    site: string;
    userAgent: string;
    proxyUrl: string | null;
    browserState: BrowserStateEnvelope | null;
  }): Promise<Page> {
    this.clearIdleTimer();
    try {
      if (!this.lease) this.lease = await this.pool.acquire(input.proxyUrl);
      if (!this.page || this.page.isClosed()) this.page = await this.lease.context.newPage();
      await this.restoreWindow(this.page);
      await this.page.setUserAgent(input.userAgent);
      await this.clearSiteState(this.page, input.site, [
        new URL(input.url).origin,
        ...(input.browserState?.origins.map((origin) => origin.origin) ?? []),
      ]);
      await installBrowserState(this.page, input.browserState);
      await this.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      if (await restoreIndexedDbState(this.page, input.browserState)) {
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      }
      this.currentSite = input.site;
      this.currentOrigins = new Set([
        new URL(input.url).origin,
        ...(input.browserState?.origins.map((origin) => origin.origin) ?? []),
      ]);
      return this.page;
    } catch (error) {
      await this.invalidate();
      throw error;
    }
  }

  async park(): Promise<void> {
    if (this.page && !this.page.isClosed()) await this.minimizeWindow(this.page).catch(() => {});
    this.currentSite = null;
    this.currentOrigins.clear();
    this.scheduleIdleRetirement();
  }

  async cancel(): Promise<void> {
    if (this.page && !this.page.isClosed() && this.currentSite) {
      await this.clearSiteState(this.page, this.currentSite, [...this.currentOrigins]).catch(() => {});
    }
    await this.park();
  }

  async invalidate(): Promise<void> {
    this.clearIdleTimer();
    const lease = this.lease;
    this.lease = null;
    this.page = null;
    this.currentSite = null;
    this.currentOrigins.clear();
    await lease?.release().catch(() => {});
    await this.pool.retireIfIdle().catch(() => {});
  }

  async close(): Promise<void> {
    await this.invalidate();
  }

  private async clearSiteState(page: Page, site: string, origins: string[]): Promise<void> {
    const cookies = (await page.browserContext().cookies()).filter((cookie) => belongsToSite(cookie.domain, site));
    if (cookies.length) {
      await page.deleteCookie(...cookies.map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      })));
    }
    const session = await page.createCDPSession();
    try {
      for (const origin of new Set(origins)) {
        let hostname: string;
        try {
          hostname = new URL(origin).hostname;
        } catch {
          continue;
        }
        if (!belongsToSite(hostname, site)) continue;
        await session.send("Storage.clearDataForOrigin", {
          origin,
          storageTypes: "local_storage,indexeddb",
        }).catch(() => {});
      }
    } finally {
      await session.detach().catch(() => {});
    }
  }

  private async minimizeWindow(page: Page): Promise<void> {
    const session = await page.createCDPSession();
    try {
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    } finally {
      await session.detach().catch(() => {});
    }
  }

  private async restoreWindow(page: Page): Promise<void> {
    const session = await page.createCDPSession();
    try {
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    } finally {
      await session.detach().catch(() => {});
    }
    await page.bringToFront();
  }

  private scheduleIdleRetirement(): void {
    this.clearIdleTimer();
    if (!this.lease) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.invalidate();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
