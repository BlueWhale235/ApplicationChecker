import type { Page } from "puppeteer-core";

const MAX_CAPTURE_WIDTH = 4_000;
const MAX_CAPTURE_HEIGHT = 20_000;

export interface FullPageCapture {
  data: Buffer;
  truncated: boolean;
}

interface PageDimensions {
  width: number;
  height: number;
}

async function prepareScrollableContent(page: Page): Promise<void> {
  await page.evaluate(async (maxCaptureHeight) => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const root = document.scrollingElement ?? document.documentElement;
    const isElement = (value: Element): value is HTMLElement => value instanceof HTMLElement;
    const isScrollable = (element: HTMLElement) => {
      if (element === document.body || element === document.documentElement) return false;
      const style = getComputedStyle(element);
      const overflowY = style.overflowY;
      return element.clientHeight >= 80
        && element.clientWidth >= 200
        && element.scrollHeight > element.clientHeight + 8
        && (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay");
    };

    async function scrollElement(element: HTMLElement | Element): Promise<void> {
      let steps = 0;
      let previousHeight = -1;
      while (steps < 500) {
        const scrollHeight = element === root ? root.scrollHeight : (element as HTMLElement).scrollHeight;
        const clientHeight = element === root ? innerHeight : (element as HTMLElement).clientHeight;
        const current = element === root ? scrollY : (element as HTMLElement).scrollTop;
        if (current + clientHeight >= scrollHeight - 2 && scrollHeight === previousHeight) break;
        previousHeight = scrollHeight;
        const next = Math.min(scrollHeight, current + Math.max(400, Math.floor(clientHeight * 0.8)));
        if (element === root) scrollTo(0, next);
        else (element as HTMLElement).scrollTop = next;
        await delay(60);
        steps += 1;
      }
      if (element === root) scrollTo(0, 0);
      else (element as HTMLElement).scrollTop = 0;
      await delay(100);
    }

    // Trigger document-level and container-level lazy rendering before changing
    // layout. Feishu recruitment pages use an inner application-list scroller.
    await scrollElement(root);
    const initialScrollers = Array.from(document.querySelectorAll("*")).filter(isElement).filter(isScrollable);
    for (const element of initialScrollers) await scrollElement(element);

    // Expand from the deepest container outwards so parent measurements include
    // their already-expanded children.
    const scrollable = Array.from(document.querySelectorAll("*")).filter(isElement).filter(isScrollable);
    const depth = (element: Element) => {
      let value = 0;
      for (let current = element.parentElement; current; current = current.parentElement) value += 1;
      return value;
    };
    scrollable.sort((left, right) => depth(right) - depth(left));
    for (const element of scrollable) {
      const expandedHeight = Math.min(maxCaptureHeight, Math.max(element.scrollHeight, element.clientHeight));
      element.dataset.applicationCheckerExpandedScroller = "true";
      element.style.setProperty("height", `${expandedHeight}px`, "important");
      element.style.setProperty("max-height", "none", "important");
      element.style.setProperty("overflow", "visible", "important");
      element.style.setProperty("overflow-y", "visible", "important");
      element.style.setProperty("contain", "none", "important");
      element.scrollTop = 0;
    }

    document.documentElement.style.setProperty("height", "auto", "important");
    document.documentElement.style.setProperty("max-height", "none", "important");
    document.documentElement.style.setProperty("overflow-y", "visible", "important");
    if (document.body) {
      document.body.style.setProperty("height", "auto", "important");
      document.body.style.setProperty("max-height", "none", "important");
      document.body.style.setProperty("overflow-y", "visible", "important");
    }

    // Fixed application shells do not always contribute to scrollHeight. Give
    // the document enough flow height to include expanded container bounds.
    const expandedBottom = scrollable.reduce((maximum, element) => {
      const rectangle = element.getBoundingClientRect();
      return Math.max(maximum, rectangle.bottom + scrollY);
    }, 0);
    if (document.body && expandedBottom > document.documentElement.scrollHeight) {
      document.body.style.setProperty("min-height", `${Math.ceil(expandedBottom)}px`, "important");
    }
    scrollTo(0, 0);
    await delay(350);
  }, MAX_CAPTURE_HEIGHT);
}

async function pageDimensions(page: Page): Promise<PageDimensions> {
  return page.evaluate(() => {
    const expandedBottom = Array.from(document.querySelectorAll<HTMLElement>("[data-application-checker-expanded-scroller='true']"))
      .reduce((maximum, element) => Math.max(maximum, element.getBoundingClientRect().bottom + scrollY), 0);
    return {
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, innerWidth),
      height: Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
        expandedBottom,
        innerHeight,
      ),
    };
  });
}

export async function captureFullPage(page: Page): Promise<FullPageCapture> {
  await prepareScrollableContent(page);
  const dimensions = await pageDimensions(page);
  const width = Math.min(MAX_CAPTURE_WIDTH, Math.max(1, Math.ceil(dimensions.width)));
  const height = Math.min(MAX_CAPTURE_HEIGHT, Math.max(1, Math.ceil(dimensions.height)));
  const truncated = dimensions.height > MAX_CAPTURE_HEIGHT || dimensions.width > MAX_CAPTURE_WIDTH;

  if (!truncated) {
    try {
      const data = await page.screenshot({
        type: "png",
        fullPage: true,
        captureBeyondViewport: true,
      });
      return { data: Buffer.from(data), truncated: false };
    } catch {
      // Fall through to a bounded capture for pathological Chromium layouts.
    }
  }

  const data = await page.screenshot({
    type: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height },
  });
  return { data: Buffer.from(data), truncated };
}
