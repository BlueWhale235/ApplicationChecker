import { mkdir, rm } from "node:fs/promises";
import type { Browser, BrowserContext } from "puppeteer-core";

export interface BrowserLease {
  context: BrowserContext;
  release(): Promise<void>;
}

interface BrowserPoolOptions {
  name: string;
  profilePath: string;
  idleTimeoutMs: number;
  maxUses: number;
  launch(profilePath: string): Promise<Browser>;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;
  private retirePromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | undefined;
  private activeLeases = 0;
  private useCount = 0;
  private closed = false;

  constructor(private readonly options: BrowserPoolOptions) {}

  async prewarm(): Promise<void> {
    if (this.closed) return;
    this.clearIdleTimer();
    await this.ensureBrowser();
    this.scheduleIdleRetirement();
  }

  async acquire(proxyServer: string | null): Promise<BrowserLease> {
    if (this.closed) throw new Error(`${this.options.name} browser pool is closed`);
    this.clearIdleTimer();
    if (this.useCount >= this.options.maxUses && this.activeLeases === 0) {
      await this.retire();
    }

    let browser = await this.ensureBrowser();
    let context: BrowserContext;
    try {
      context = await browser.createBrowserContext(proxyServer ? { proxyServer } : {});
    } catch {
      await this.discardBrowser(browser);
      browser = await this.ensureBrowser();
      context = await browser.createBrowserContext(proxyServer ? { proxyServer } : {});
    }

    this.activeLeases += 1;
    this.useCount += 1;
    let released = false;
    return {
      context,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await context.close();
        } catch {
          // The browser may already have exited.
        } finally {
          this.activeLeases = Math.max(0, this.activeLeases - 1);
          if (this.activeLeases === 0 && this.useCount >= this.options.maxUses) {
            await this.retire();
          } else {
            this.scheduleIdleRetirement();
          }
        }
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    const starting = this.launchPromise;
    if (starting) await starting.catch(() => {});
    await this.retire(true);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.retirePromise) await this.retirePromise;
    if (this.browser) return this.browser;
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this.launchFreshBrowser().finally(() => {
      this.launchPromise = null;
    });
    return this.launchPromise;
  }

  private async launchFreshBrowser(): Promise<Browser> {
    await this.cleanupProfile();
    await mkdir(`${this.options.profilePath}/tmp`, { recursive: true });
    const browser = await this.options.launch(this.options.profilePath);
    if (this.closed) {
      await browser.close().catch(() => {});
      throw new Error(`${this.options.name} browser pool was closed during startup`);
    }
    this.browser = browser;
    this.useCount = 0;
    browser.once("disconnected", () => {
      if (this.browser === browser) this.browser = null;
    });
    return browser;
  }

  private async discardBrowser(browser: Browser): Promise<void> {
    if (this.browser === browser) this.browser = null;
    await browser.close().catch(() => {});
    if (this.activeLeases === 0) await this.cleanupProfile();
  }

  private scheduleIdleRetirement(): void {
    if (this.closed || this.activeLeases > 0 || !this.browser) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.retire();
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async retire(force = false): Promise<void> {
    if (!force && this.activeLeases > 0) return;
    if (this.retirePromise) return this.retirePromise;
    const retirement = this.performRetirement();
    this.retirePromise = retirement;
    try {
      await retirement;
    } finally {
      if (this.retirePromise === retirement) this.retirePromise = null;
    }
  }

  private async performRetirement(): Promise<void> {
    this.clearIdleTimer();
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => {});
    this.useCount = 0;
    await this.cleanupProfile();
  }

  private async cleanupProfile(): Promise<void> {
    await rm(this.options.profilePath, { recursive: true, force: true }).catch(() => {});
  }
}
