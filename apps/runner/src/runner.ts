import "dotenv/config";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RunnerJob, RunnerLoginJob } from "@application-checker/contracts";
import { collectBrowserState, installBrowserState } from "./browser-state.js";
import { classifyPage } from "./detection.js";
import { captureFullPage } from "./full-page-capture.js";

const apiBase = (process.env.APP_INTERNAL_URL ?? "http://127.0.0.1:8080/api").replace(/\/$/, "");
const token = process.env.RUNNER_INTERNAL_TOKEN ?? "development-runner-token-change-me-123456";
function findBrowserBin(): string {
  if (process.env.BROWSER_BIN) return process.env.BROWSER_BIN;
  if (process.platform !== "win32") return "/usr/bin/chromium";
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value));
  const candidates = roots.flatMap((root) => [
    path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
  ]);
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Microsoft Edge or Google Chrome was not found");
  return found;
}

const browserBin = findBrowserBin();
const browserDataPath = path.resolve(process.env.BROWSER_DATA_PATH ?? "./data/browser");

async function freshBrowserProfile(kind: string, id: string): Promise<string> {
  const folder = path.join(browserDataPath, `${kind}-${id}`);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  return folder;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`API ${path} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

function launchArgs(proxyUrl: string | null): string[] {
  return [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-features=Translate,MediaRouter",
    "--window-size=1440,900",
    ...(proxyUrl ? [`--proxy-server=${proxyUrl}`] : []),
  ];
}

async function settle(page: Page): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 12_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

async function signals(page: Page, status: number | null) {
  const values = await page.evaluate(() => ({
    title: document.title,
    text: document.body?.innerText ?? "",
    passwordFields: document.querySelectorAll('input[type="password"]').length,
    otpFields: document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i]').length,
    captchaElements: document.querySelectorAll('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i], .cf-turnstile').length,
  }));
  return { url: page.url(), status, ...values };
}

async function capture(job: RunnerJob): Promise<void> {
  let browser: Browser | null = null;
  let profilePath: string | null = null;
  let cancelled = false;
  let controlTimer: NodeJS.Timeout | undefined;
  try {
    profilePath = await freshBrowserProfile("capture", job.runId);
    browser = await puppeteer.launch({
      executablePath: browserBin,
      userDataDir: profilePath,
      headless: true,
      args: launchArgs(job.proxyUrl),
    });
    controlTimer = setInterval(() => {
      void api<{ status: string }>(`/internal/runs/${job.runId}/control`).then(async (control) => {
        if (control.status === "cancelled" && browser) {
          cancelled = true;
          const current = browser;
          browser = null;
          await current.close().catch(() => {});
        }
      }).catch(() => {});
    }, 1000);
    controlTimer.unref();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.setUserAgent(job.userAgent);
    await installBrowserState(page, job.browserState);
    const response = await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settle(page);
    const observed = await signals(page, response?.status() ?? null);
    const detection = classifyPage(observed);
    const image = await captureFullPage(page);
    if (detection.requiresLogin) {
      await api(`/internal/runs/${job.runId}/needs-login`, {
        method: "POST",
        body: JSON.stringify({
          finalUrl: observed.url,
          pageTitle: observed.title,
          screenshotBase64: image.data.toString("base64"),
          reason: detection.reason,
        }),
      });
      return;
    }
    const state = await collectBrowserState(browser, page, job.site);
    await api(`/internal/runs/${job.runId}/complete`, {
      method: "POST",
      body: JSON.stringify({
        finalUrl: observed.url,
        pageTitle: observed.title,
        screenshotBase64: image.data.toString("base64"),
        truncated: image.truncated,
        browserState: state,
      }),
    });
  } catch (error) {
    if (!cancelled) await api(`/internal/runs/${job.runId}/fail`, {
      method: "POST",
      body: JSON.stringify({
        code: "CAPTURE_FAILED",
        message: error instanceof Error ? error.message : "Unknown capture error",
      }),
    }).catch(() => {});
  } finally {
    if (controlTimer) clearInterval(controlTimer);
    await browser?.close().catch(() => {});
    if (profilePath) await rm(profilePath, { recursive: true, force: true }).catch(() => {});
  }
}

async function login(job: RunnerLoginJob): Promise<void> {
  let browser: Browser | null = null;
  let profilePath: string | null = null;
  try {
    profilePath = await freshBrowserProfile("login", job.sessionId);
    browser = await puppeteer.launch({
      executablePath: browserBin,
      userDataDir: profilePath,
      headless: false,
      defaultViewport: null,
      args: [...launchArgs(job.proxyUrl), "--start-maximized"],
    });
    const pages = await browser.pages();
    const page = pages[0] ?? await browser.newPage();
    await page.setUserAgent(job.userAgent);
    await installBrowserState(page, job.browserState);
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await api(`/internal/login/${job.sessionId}/ready`, { method: "POST", body: "{}" });
    while (true) {
      const control = await api<{ status: string; expires_at: string }>(`/internal/login/${job.sessionId}/control`);
      if (control.status === "saving") {
        const state = await collectBrowserState(browser, page, job.site);
        await api(`/internal/login/${job.sessionId}/complete`, {
          method: "POST",
          body: JSON.stringify({ finalUrl: page.url(), browserState: state }),
        });
        return;
      }
      if (["cancelled", "expired", "failed"].includes(control.status) || new Date(control.expires_at).getTime() <= Date.now()) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    await api(`/internal/login/${job.sessionId}/fail`, {
      method: "POST",
      body: JSON.stringify({ message: error instanceof Error ? error.message : "Unknown login error" }),
    }).catch(() => {});
  } finally {
    await browser?.close().catch(() => {});
    if (profilePath) await rm(profilePath, { recursive: true, force: true }).catch(() => {});
  }
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

const heartbeat = setInterval(() => {
  void api("/internal/heartbeat", { method: "POST", body: "{}" }).catch(() => {});
}, 5000);
heartbeat.unref();

while (!stopping) {
  try {
    await api("/internal/heartbeat", { method: "POST", body: "{}" });
    const job = await api<RunnerJob | RunnerLoginJob | { kind: "idle" }>("/internal/claim", { method: "POST", body: "{}" });
    if (job.kind === "capture") await capture(job);
    else if (job.kind === "login") await login(job);
    else await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch (error) {
    console.error(error);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
clearInterval(heartbeat);
