import type { Page } from "puppeteer-core";

const TRANSIENT_NAVIGATION_ERROR =
  /(execution context was destroyed|cannot find context with specified id|context.*destroyed|frame was detached|page navigated during capture)/i;

export function isTransientNavigationError(error: unknown): boolean {
  return error instanceof Error && TRANSIENT_NAVIGATION_ERROR.test(error.message);
}

export async function waitForPageStability(page: Pick<Page, "waitForNetworkIdle">): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 750, timeout: 8_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 350));
}

export async function withNavigationRetry<T>(
  page: Pick<Page, "waitForNetworkIdle">,
  operation: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientNavigationError(error) || attempt === maxAttempts) throw error;
      await waitForPageStability(page);
    }
  }
  throw lastError;
}
