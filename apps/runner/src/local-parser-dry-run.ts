import puppeteer from "puppeteer-core";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptBrowserState, type EncryptedPayload } from "@application-checker/cookie-state";
import type { BrowserStateEnvelope } from "@application-checker/contracts";
import { recognizeLocalPage } from "@application-checker/local-status";
import { installBrowserState } from "./browser-state.js";
import { classifyPage } from "./detection.js";
import { captureLocalPageSnapshot } from "./dom-snapshot.js";
import { captureFullPage } from "./full-page-capture.js";

interface CandidateRow {
  group_id: string;
  application_id: string;
  company: string;
  site: string;
  url: string;
  history_count: number;
}

interface MemberRow {
  id: string;
  job_title: string;
  applied_at: string | null;
  location: string | null;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function browserBinary(): string {
  if (process.env.BROWSER_BIN) return process.env.BROWSER_BIN;
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
    .filter((value): value is string => Boolean(value));
  const found = roots.flatMap((root) => [
    path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
  ]).find(existsSync);
  if (!found) throw new Error("Microsoft Edge or Google Chrome was not found");
  return found;
}

function businessCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(["applications", "runs", "status_events", "notifications"].map((table) => [
    table,
    Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count),
  ]));
}

async function main(): Promise<void> {
  const databasePath = required("DATABASE_PATH");
  const settingsPath = required("DESKTOP_SETTINGS_PATH");
  const outputPath = required("OUTPUT_PATH");
  const outputDirectory = path.dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const desktopSettings = JSON.parse(await readFile(settingsPath, "utf8")) as { StateEncryptionKey: string };
  const stateKey = Buffer.from(desktopSettings.StateEncryptionKey, "base64");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const before = businessCounts(db);
  const profileRows = db.prepare("SELECT site, payload_json FROM browser_profiles").all() as Array<{
    site: string;
    payload_json: string;
  }>;
  const profiles = new Map<string, BrowserStateEnvelope>(profileRows.map((row) => [
    row.site,
    decryptBrowserState(JSON.parse(row.payload_json) as EncryptedPayload, stateKey),
  ]));
  const candidates = db.prepare(`
    SELECT
      check_groups.id AS group_id,
      applications.id AS application_id,
      check_groups.company,
      applications.site,
      COALESCE(check_groups.resolved_url, applications.resolved_url, check_groups.check_url, applications.check_url) AS url,
      (
        SELECT COUNT(*) FROM run_application_results
        WHERE run_application_results.application_id = applications.id
          AND run_application_results.raw_status IS NOT NULL
      ) AS history_count
    FROM check_groups
    JOIN applications ON applications.check_group_id = check_groups.id
    WHERE applications.site IN ('zhiye.com','mokahr.com','feishu.cn')
      AND COALESCE(check_groups.resolved_url, applications.resolved_url, check_groups.check_url, applications.check_url) <> ''
    GROUP BY check_groups.id
    ORDER BY applications.site, history_count DESC, check_groups.updated_at DESC
  `).all() as unknown as CandidateRow[];
  const historicalStatement = db.prepare(`
    SELECT raw_status, suggested_status, confidence, evidence
    FROM run_application_results
    WHERE application_id IN (SELECT id FROM applications WHERE check_group_id = ?)
      AND raw_status IS NOT NULL
    ORDER BY created_at DESC LIMIT 5
  `);
  const memberStatement = db.prepare(`
    SELECT id, job_title, applied_at, location
    FROM applications WHERE check_group_id = ? ORDER BY created_at
  `);
  const report: {
    createdAt: string;
    before: Record<string, number>;
    after?: Record<string, number>;
    databaseUnchanged?: boolean;
    sites: Record<string, unknown[]>;
  } = {
    createdAt: new Date().toISOString(),
    before,
    sites: { "zhiye.com": [], "mokahr.com": [], "feishu.cn": [] },
  };
  const executablePath = browserBinary();

  for (const site of ["zhiye.com", "mokahr.com", "feishu.cn"]) {
    const siteCandidates = candidates.filter((item) => item.site === site);
    let accepted = 0;
    let attempted = 0;
    for (const candidate of siteCandidates) {
      if (accepted >= 3 || attempted >= 5) break;
      attempted += 1;
      const members = memberStatement.all(candidate.group_id) as unknown as MemberRow[];
      const profile = profiles.get(site) ?? null;
      const userDataDir = path.join(outputDirectory, `browser-${site.replace(".", "-")}-${attempted}`);
      let browser;
      try {
        browser = await puppeteer.launch({
          executablePath,
          userDataDir,
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
        await installBrowserState(page, profile);
        const response = await page.goto(candidate.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 12_000 }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const signals = await page.evaluate(() => ({
          title: document.title,
          text: document.body?.innerText ?? "",
          passwordFields: document.querySelectorAll('input[type="password"]').length,
          otpFields: document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i]').length,
          captchaElements: document.querySelectorAll('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i], .cf-turnstile').length,
        }));
        const detection = classifyPage({ url: page.url(), status: response?.status() ?? null, ...signals });
        const snapshot = await captureLocalPageSnapshot(page);
        const image = await captureFullPage(page);
        const screenshotPath = path.join(outputDirectory, `${site.replace(".", "-")}-${accepted + 1}.png`);
        await writeFile(screenshotPath, image.data);
        if (detection.requiresLogin) {
          report.sites[site]!.push({
            groupId: candidate.group_id,
            applicationId: candidate.application_id,
            status: "needs_login",
            reason: detection.reason,
            finalUrl: snapshot.url,
          });
          continue;
        }
        const result = recognizeLocalPage(snapshot, members.map((member) => ({
          id: member.id,
          jobTitle: member.job_title,
          location: member.location,
        })));
        const sanitized = {
          groupId: candidate.group_id,
          applicationId: candidate.application_id,
          company: candidate.company,
          status: "succeeded",
          finalUrl: snapshot.url,
          pageTitle: snapshot.title,
          applicationCount: members.length,
          matchedCount: result.results.filter((item) => item.matched && item.confidence >= 0.9).length,
          coverage: members.length
            ? result.results.filter((item) => item.matched && item.confidence >= 0.9).length / members.length
            : 0,
          adapterId: result.adapterId,
          adapterVersion: result.adapterVersion,
          route: result.route,
          pageType: result.pageType,
          pageEvidence: result.pageEvidence,
          snapshotSummary: {
            nodeCount: snapshot.nodes.length,
            textCharacters: snapshot.visibleText.length,
            truncated: snapshot.truncated,
            nodeLimitReached: snapshot.nodeLimitReached,
            textLimitReached: snapshot.textLimitReached,
          },
          results: result.results,
          historicalResults: historicalStatement.all(candidate.group_id),
          screenshotPath,
        };
        const serialized = JSON.stringify(sanitized);
        if (/(cookie|authorization|bearer|api[_-]?key|inputValue|<html)/i.test(serialized)) {
          throw new Error("Sanitized preview contains a forbidden field");
        }
        report.sites[site]!.push(sanitized);
        accepted += 1;
      } catch (error) {
        report.sites[site]!.push({
          groupId: candidate.group_id,
          applicationId: candidate.application_id,
          status: "failed",
          reason: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        await browser?.close().catch(() => {});
        await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  const after = businessCounts(db);
  report.after = after;
  report.databaseUnchanged = JSON.stringify(before) === JSON.stringify(after);
  db.close();
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    outputPath,
    databaseUnchanged: report.databaseUnchanged,
    sites: Object.fromEntries(Object.entries(report.sites).map(([site, items]) => [
      site,
      items.map((item) => ({
        status: (item as { status?: string }).status,
        adapterId: (item as { adapterId?: string }).adapterId,
        coverage: (item as { coverage?: number }).coverage,
      })),
    ])),
  }, null, 2)}\n`);
}

await main();
