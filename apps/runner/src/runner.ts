import "dotenv/config";
import puppeteer, { type Page } from "puppeteer-core";
import { existsSync } from "node:fs";
import path from "node:path";
import type { RunnerJob, RunnerLoginJob, RunnerRecognitionPreviewJob, ScriptRuleExecution } from "@application-checker/contracts";
import { BrowserPool, type BrowserLease } from "./browser-pool.js";
import { collectBrowserState, installBrowserState, restoreIndexedDbState } from "./browser-state.js";
import { classifyPage } from "./detection.js";
import { captureFullPage } from "./full-page-capture.js";
import { captureLocalPageSnapshot } from "./dom-snapshot.js";
import { withNavigationRetry } from "./page-stability.js";
import { executeScriptRule, selectScriptRule } from "./script-rule.js";

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
const browserCachePath = path.resolve(process.env.BROWSER_CACHE_PATH ?? path.join(browserDataPath, "cache"));
const browserCacheSize = 512 * 1024 * 1024;

function browserEnvironment(profilePath: string): NodeJS.ProcessEnv {
  const taskTempPath = path.join(profilePath, "tmp");
  return { ...process.env, TEMP: taskTempPath, TMP: taskTempPath, TMPDIR: taskTempPath };
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

function launchArgs(): string[] {
  return [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-save-password-bubble",
    "--disable-features=Translate,MediaRouter,AutofillServerCommunication,PasswordLeakDetection,PasswordManagerOnboarding",
    "--window-size=1440,900",
    `--disk-cache-dir=${browserCachePath}`,
    `--disk-cache-size=${browserCacheSize}`,
  ];
}

const automatedBrowserPool = new BrowserPool({
  name: "automated",
  profilePath: path.join(browserDataPath, "pool-automated"),
  idleTimeoutMs: 90_000,
  maxUses: 30,
  launch: (profilePath) => puppeteer.launch({
    executablePath: browserBin,
    userDataDir: profilePath,
    env: browserEnvironment(profilePath),
    headless: true,
    args: launchArgs(),
  }),
});

const loginBrowserPool = new BrowserPool({
  name: "login",
  profilePath: path.join(browserDataPath, "pool-login"),
  idleTimeoutMs: 180_000,
  maxUses: 30,
  launch: (profilePath) => puppeteer.launch({
    executablePath: browserBin,
    userDataDir: profilePath,
    env: browserEnvironment(profilePath),
    headless: false,
    defaultViewport: null,
    waitForInitialPage: false,
    args: [...launchArgs(), "--no-startup-window", "--start-maximized"],
  }),
});

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

async function captureStablePage(page: Page, status: number | null, includeSnapshot: boolean) {
  return withNavigationRetry(page, async () => {
    const startUrl = page.url();
    const observed = await signals(page, status);
    const detection = classifyPage(observed);
    const image = await captureFullPage(page);
    const snapshot = includeSnapshot ? await captureLocalPageSnapshot(page) : null;
    if (page.url() !== startUrl) {
      throw new Error("Page navigated during capture");
    }
    return { observed, detection, image, snapshot };
  });
}

async function capture(job: RunnerJob): Promise<void> {
  let lease: BrowserLease | null = null;
  let cancelled = false;
  let controlTimer: NodeJS.Timeout | undefined;
  try {
    lease = await automatedBrowserPool.acquire(job.proxyUrl);
    controlTimer = setInterval(() => {
      void api<{ status: string }>(`/internal/runs/${job.runId}/control`).then(async (control) => {
        if (control.status === "cancelled" && lease) {
          cancelled = true;
          await lease.release();
        }
      }).catch(() => {});
    }, 1000);
    controlTimer.unref();
    const page = await lease.context.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.setUserAgent(job.userAgent);
    await installBrowserState(page, job.browserState);
    let response = await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (await restoreIndexedDbState(page, job.browserState)) {
      response = await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await settle(page);
    const initialDetection = classifyPage(await signals(page, response?.status() ?? null));
    let scriptExecution: ScriptRuleExecution | null = null;
    if (!initialDetection.requiresLogin) {
      const scriptRule = selectScriptRule(job.scriptRules, page.url());
      if (scriptRule) {
        try {
          scriptExecution = await executeScriptRule(page, scriptRule, job.applicationId, job.applications);
          await settle(page);
        } catch (error) {
          if (page.isClosed()) throw error;
          console.error(`Page script ${scriptRule.id} failed; continuing with normal recognition`, error);
        }
      }
    }
    const { observed, detection, image, snapshot: pageSnapshot } = await captureStablePage(
      page,
      response?.status() ?? null,
      job.recognitionMode !== "ai_only",
    );
    if (detection.requiresLogin) {
      void loginBrowserPool.prewarm().catch((error) => {
        console.error("Unable to prewarm the login browser", error);
      });
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
    const state = await withNavigationRetry(page, () => collectBrowserState(page, job.site));
    const completion = await api<{ needsLogin?: boolean }>(`/internal/runs/${job.runId}/complete`, {
      method: "POST",
      body: JSON.stringify({
        finalUrl: observed.url,
        pageTitle: observed.title,
        screenshotBase64: image.data.toString("base64"),
        truncated: image.truncated,
        browserState: state,
        pageSnapshot,
        scriptExecution,
      }),
    });
    if (completion.needsLogin) {
      void loginBrowserPool.prewarm().catch((error) => {
        console.error("Unable to prewarm the login browser", error);
      });
    }
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
    await lease?.release();
  }
}

async function login(job: RunnerLoginJob): Promise<void> {
  let lease: BrowserLease | null = null;
  try {
    lease = await loginBrowserPool.acquire(job.proxyUrl);
    const page = await lease.context.newPage();
    await page.setUserAgent(job.userAgent);
    await installBrowserState(page, job.browserState);
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (await restoreIndexedDbState(page, job.browserState)) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await api(`/internal/login/${job.sessionId}/ready`, { method: "POST", body: "{}" });
    while (true) {
      const control = await api<{ status: string; expires_at: string }>(`/internal/login/${job.sessionId}/control`);
      if (control.status === "saving") {
        const state = await collectBrowserState(page, job.site);
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
    await lease?.release();
  }
}

async function recognitionPreview(job: RunnerRecognitionPreviewJob): Promise<void> {
  let lease: BrowserLease | null = null;
  try {
    lease = await automatedBrowserPool.acquire(job.proxyUrl);
    const page = await lease.context.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.setUserAgent(job.userAgent);
    await installBrowserState(page, job.browserState);
    let response = await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (await restoreIndexedDbState(page, job.browserState)) {
      response = await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await settle(page);
    let scriptExecution: ScriptRuleExecution | null = null;
    const initialDetection = classifyPage(await signals(page, response?.status() ?? null));
    if (job.scriptRule && !initialDetection.requiresLogin) {
      scriptExecution = await executeScriptRule(page, job.scriptRule, job.applicationId, job.applications);
      await settle(page);
    }
    const { detection, image, snapshot } = await captureStablePage(page, response?.status() ?? null, true);
    if (!snapshot) throw new Error("Recognition preview snapshot was not captured");
    await api(`/internal/recognition-previews/${job.previewId}/complete`, {
      method: "POST",
      body: JSON.stringify({
        snapshot,
        screenshotBase64: image.data.toString("base64"),
        screenshotWidth: image.width,
        screenshotHeight: image.height,
        screenshotTruncated: image.truncated,
        needsLogin: detection.requiresLogin,
        loginReason: detection.requiresLogin ? detection.reason : null,
        scriptExecution,
      }),
    });
  } catch (error) {
    await api(`/internal/recognition-previews/${job.previewId}/fail`, {
      method: "POST",
      body: JSON.stringify({ message: error instanceof Error ? error.message : "Unknown preview error" }),
    }).catch(() => {});
  } finally {
    await lease?.release();
  }
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

const heartbeat = setInterval(() => {
  void api("/internal/heartbeat", { method: "POST", body: "{}" }).catch(() => {});
}, 5000);
heartbeat.unref();

try {
  while (!stopping) {
    try {
      await api("/internal/heartbeat", { method: "POST", body: "{}" });
      const job = await api<RunnerJob | RunnerLoginJob | RunnerRecognitionPreviewJob | { kind: "idle" }>("/internal/claim", { method: "POST", body: "{}" });
      if (job.kind === "capture") await capture(job);
      else if (job.kind === "login") await login(job);
      else if (job.kind === "recognition_preview") await recognitionPreview(job);
      else await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (error) {
      console.error(error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
} finally {
  clearInterval(heartbeat);
  await Promise.all([automatedBrowserPool.close(), loginBrowserPool.close()]);
}
