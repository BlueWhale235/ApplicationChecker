import type { Browser, Page } from "puppeteer-core";
import type { BrowserCookie, BrowserStateEnvelope } from "@application-checker/contracts";

function sameSite(value: string | undefined): BrowserCookie["sameSite"] {
  if (value === "Strict" || value === "Lax" || value === "None") return value;
  return undefined;
}

export async function installBrowserState(page: Page, state: BrowserStateEnvelope | null): Promise<void> {
  if (!state) return;
  if (state.cookies.length) {
    await page.setCookie(...state.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      ...(cookie.expires ? { expires: cookie.expires } : {}),
      ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
      ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    })));
  }
  await page.evaluateOnNewDocument((origins) => {
    const entry = origins.find((item) => item.origin === location.origin);
    if (!entry) return;
    for (const [key, value] of Object.entries(entry.localStorage)) localStorage.setItem(key, value);
  }, state.origins);
}

export async function collectBrowserState(browser: Browser, page: Page, site: string): Promise<BrowserStateEnvelope> {
  const rawCookies = await browser.cookies();
  const cookies: BrowserCookie[] = rawCookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    return domain === site || domain.endsWith(`.${site}`);
  }).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    ...(cookie.expires > 0 ? { expires: cookie.expires } : {}),
    ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
    ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
    ...(sameSite(cookie.sameSite) ? { sameSite: sameSite(cookie.sameSite)! } : {}),
  }));
  const origins = await page.evaluate(() => {
    try {
      const values: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key !== null) values[key] = localStorage.getItem(key) ?? "";
      }
      return [{ origin: location.origin, localStorage: values }];
    } catch {
      return [];
    }
  });
  return { version: 1, cookies, origins };
}
