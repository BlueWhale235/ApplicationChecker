import type { Page } from "puppeteer-core";
import type { BrowserLease } from "./browser-pool.js";

export interface PreviewPageResource {
  lease: BrowserLease;
  page: Page;
  responseStatus: number | null;
}

interface StoredPreviewPage {
  previewId: string;
  resource: PreviewPageResource;
  timer: NodeJS.Timeout;
}

export class PreviewPageSessionManager {
  private active: StoredPreviewPage | null = null;
  private readonly releasedPreviewIds = new Set<string>();

  constructor(private readonly idleTimeoutMs = 180_000) {}

  take(previewId: string): PreviewPageResource | null {
    if (!this.active || this.active.previewId !== previewId) return null;
    clearTimeout(this.active.timer);
    const resource = this.active.resource;
    this.active = null;
    if (resource.page.isClosed()) {
      void resource.lease.release();
      return null;
    }
    return resource;
  }

  async retain(previewId: string, resource: PreviewPageResource): Promise<void> {
    await this.release();
    if (this.releasedPreviewIds.has(previewId)) {
      await resource.lease.release();
      return;
    }
    const timer = setTimeout(() => {
      if (this.active?.resource !== resource) return;
      this.active = null;
      void resource.lease.release();
    }, this.idleTimeoutMs);
    timer.unref();
    this.active = { previewId, resource, timer };
  }

  async release(previewId?: string): Promise<void> {
    if (previewId) {
      this.releasedPreviewIds.add(previewId);
      if (this.releasedPreviewIds.size > 100) {
        const oldest = this.releasedPreviewIds.values().next().value as string | undefined;
        if (oldest) this.releasedPreviewIds.delete(oldest);
      }
    }
    if (!this.active || (previewId && this.active.previewId !== previewId)) return;
    const current = this.active;
    this.active = null;
    clearTimeout(current.timer);
    await current.resource.lease.release();
  }

  async close(): Promise<void> {
    await this.release();
  }
}
