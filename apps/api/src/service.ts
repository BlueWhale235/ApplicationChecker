import { randomUUID } from "node:crypto";
import path from "node:path";
import { readdir, rm, stat } from "node:fs/promises";
import {
  normalizeCheckUrl, normalizeCompany,
  type BrowserStateEnvelope, type ScheduleMode,
} from "@application-checker/contracts";
import { decryptBrowserState, encryptBrowserState, type EncryptedPayload } from "@application-checker/cookie-state";
import type { Config } from "./config.js";
import {
  APP_SETTINGS_DEFAULTS,
  type AppSettingKey,
  type AppSettingsValues,
  type DbContext,
} from "./db.js";
import { effectiveCron, nextCronAt, validateCron } from "./cron.js";

function validatedSetting(key: AppSettingKey, value: unknown): AppSettingsValues[AppSettingKey] {
  if (["global_cron", "ai_base_url", "ai_model", "ai_api_key_encrypted", "state_key_fingerprint"].includes(key)) {
    if (value !== null && typeof value !== "string") throw new Error(`应用设置 ${key} 的值无效`);
    return value as AppSettingsValues[AppSettingKey];
  }
  if (["timezone", "default_user_agent", "status_mappings"].includes(key)) {
    if (typeof value !== "string") throw new Error(`应用设置 ${key} 的值无效`);
    return value as AppSettingsValues[AppSettingKey];
  }
  if (key === "check_concurrency") {
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3) throw new Error(`应用设置 ${key} 的值无效`);
    return value as AppSettingsValues[AppSettingKey];
  }
  if (key === "screenshot_retention_days") {
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3650) throw new Error(`应用设置 ${key} 的值无效`);
    return value as AppSettingsValues[AppSettingKey];
  }
  if (key === "ai_confidence_threshold") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`应用设置 ${key} 的值无效`);
    return value as AppSettingsValues[AppSettingKey];
  }
  if (key === "ai_deep_thinking") {
    if (value !== 0 && value !== 1) throw new Error(`应用设置 ${key} 的值无效`);
    return value as AppSettingsValues[AppSettingKey];
  }
  if (key === "recognition_mode") {
    if (!['local_first', 'local_only', 'ai_only'].includes(String(value))) throw new Error(`应用设置 ${key} 的值无效`);
    return value as AppSettingsValues[AppSettingKey];
  }
  throw new Error(`未知应用设置：${key}`);
}

export function decodeAppSettings(rows: Array<{ key: string; value_json: string; updated_at: string }>): AppSettingsValues {
  const knownKeys = new Set(Object.keys(APP_SETTINGS_DEFAULTS));
  const values = { ...APP_SETTINGS_DEFAULTS } as Omit<AppSettingsValues, "updated_at">;
  let updatedAt = "";
  for (const row of rows) {
    if (!knownKeys.has(row.key)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.value_json); }
    catch { throw new Error(`应用设置 ${row.key} 不是有效的 JSON`); }
    const key = row.key as AppSettingKey;
    values[key] = validatedSetting(key, parsed) as never;
    if (row.updated_at > updatedAt) updatedAt = row.updated_at;
  }
  return { ...values, updated_at: updatedAt || new Date(0).toISOString() };
}

export async function appSettings(context: DbContext): Promise<AppSettingsValues> {
  return decodeAppSettings(await context.db.selectFrom("app_settings").selectAll().execute());
}

export async function updateAppSettings(
  context: DbContext,
  values: Partial<Omit<AppSettingsValues, "updated_at">>,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  const entries = Object.entries(values) as Array<[AppSettingKey, AppSettingsValues[AppSettingKey]]>;
  const upsert = context.raw.prepare(`
    INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
  `);
  context.raw.transaction(() => {
    for (const [key, value] of entries) {
      validatedSetting(key, value);
      upsert.run(key, JSON.stringify(value ?? null), updatedAt);
    }
  })();
}

export async function calculateNextRun(
  context: DbContext,
  schedule: { schedule_mode: ScheduleMode; cron_expression: string | null },
  after = new Date(),
): Promise<string | null> {
  const settings = await appSettings(context);
  const expression = effectiveCron(schedule, settings.global_cron);
  if (!expression) return null;
  validateCron(expression, settings.timezone);
  return nextCronAt(expression, settings.timezone, after);
}

export async function queueRun(
  context: DbContext,
  applicationId: string,
  trigger: "manual" | "bulk" | "cron" | "login_resume",
  includePausedApplicationIds: string[] = [],
): Promise<string | null> {
  const application = await context.db.selectFrom("applications")
    .select([
      "id", "check_group_id", "company", "check_url", "resolved_url", "site",
      "schedule_mode", "cron_expression", "next_run_at",
    ]).where("id", "=", applicationId).executeTakeFirst();
  if (!application) return null;
  if (!application.check_url) return null;
  let groupId = application.check_group_id;
  if (!groupId) {
    const { group } = await findOrCreateCheckGroup(context, {
      company: application.company,
      checkUrl: application.check_url,
      resolvedUrl: application.resolved_url,
      site: application.site,
      scheduleMode: application.schedule_mode,
      cronExpression: application.cron_expression,
      nextRunAt: application.next_run_at,
    });
    groupId = group.id;
    await context.db.updateTable("applications").set({ check_group_id: groupId })
      .where("id", "=", applicationId).execute();
  }
  const includePaused = new Set(includePausedApplicationIds);
  const allMembers = await context.db.selectFrom("applications")
    .select(["id", "job_title", "automation_paused"]).where("check_group_id", "=", groupId).orderBy("created_at").execute();
  const members = allMembers.filter((member) => !member.automation_paused || includePaused.has(member.id));
  if (!members.length) return null;
  const now = new Date().toISOString();
  const id = randomUUID();
  try {
    await context.db.transaction().execute(async (trx) => {
      await trx.insertInto("runs").values({
        id,
        check_group_id: groupId,
        application_id: applicationId,
        trigger,
        status: "queued",
        final_url: null,
        page_title: null,
        screenshot_path: null,
        screenshot_truncated: 0,
        ai_status: "skipped",
        ai_suggested_status: null,
        ai_suggested_status_v2: null,
        ai_confidence: null,
        ai_evidence: null,
        ai_provider: null,
        error_code: null,
        error_message: null,
        created_at: now,
        started_at: null,
        completed_at: null,
      }).execute();
      await trx.insertInto("run_application_results").values(members.map((member) => ({
        id: randomUUID(),
        run_id: id,
        application_id: member.id,
        job_title_snapshot: member.job_title,
        matched: 0,
        raw_status: null,
        suggested_status: null,
        confidence: null,
        evidence: null,
        applied: 0,
        not_applied_reason: null,
        automation_paused: member.automation_paused ? 1 : 0,
        created_at: now,
      }))).execute();
      await trx.updateTable("applications").set({
        last_run_status: "queued",
        updated_at: now,
      }).where("check_group_id", "=", groupId).execute();
    });
    return id;
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) return null;
    throw error;
  }
}

export async function findOrCreateCheckGroup(
  context: DbContext,
  input: {
    company: string;
    checkUrl: string;
    resolvedUrl?: string | null;
    site: string;
    scheduleMode: ScheduleMode;
    cronExpression: string | null;
    nextRunAt: string | null;
    manualKey?: string;
  },
) {
  const companyKey = normalizeCompany(input.company);
  const normalizedUrl = input.checkUrl
    ? normalizeCheckUrl(input.checkUrl)
    : `manual:${input.manualKey ?? randomUUID()}`;
  const existing = await context.db.selectFrom("check_groups").selectAll()
    .where("company_key", "=", companyKey).where("normalized_url", "=", normalizedUrl).executeTakeFirst();
  if (existing) return { group: existing, joinedExisting: true };
  const now = new Date().toISOString();
  const id = randomUUID();
  await context.db.insertInto("check_groups").values({
    id,
    company: input.company.trim(),
    company_key: companyKey,
    normalized_url: normalizedUrl,
    check_url: input.checkUrl,
    resolved_url: input.resolvedUrl ?? null,
    site: input.site,
    schedule_mode: input.scheduleMode,
    cron_expression: input.cronExpression,
    next_run_at: input.nextRunAt,
    created_at: now,
    updated_at: now,
  }).execute();
  return {
    group: await context.db.selectFrom("check_groups").selectAll().where("id", "=", id).executeTakeFirstOrThrow(),
    joinedExisting: false,
  };
}

export async function loadBrowserState(
  context: DbContext,
  config: Config,
  site: string,
): Promise<BrowserStateEnvelope | null> {
  const row = await context.db.selectFrom("browser_profiles").select("payload_json").where("site", "=", site).executeTakeFirst();
  if (!row) return null;
  return decryptBrowserState(JSON.parse(row.payload_json) as EncryptedPayload, config.stateKey);
}

export async function loadBrowserStateWithVersion(
  context: DbContext,
  config: Config,
  site: string,
): Promise<{ state: BrowserStateEnvelope | null; version: number }> {
  const row = await context.db.selectFrom("browser_profiles").select(["payload_json", "version"])
    .where("site", "=", site).executeTakeFirst();
  if (!row) return { state: null, version: 0 };
  return {
    state: decryptBrowserState(JSON.parse(row.payload_json) as EncryptedPayload, config.stateKey),
    version: row.version,
  };
}

export async function saveBrowserState(
  context: DbContext,
  config: Config,
  site: string,
  state: BrowserStateEnvelope,
): Promise<void> {
  const now = new Date().toISOString();
  const payload = JSON.stringify(encryptBrowserState(state, config.stateKey));
  await context.db.insertInto("browser_profiles").values({
    site,
    payload_json: payload,
    cookie_count: state.cookies.length,
    version: 1,
    created_at: now,
    updated_at: now,
  }).onConflict((oc) => oc.column("site").doUpdateSet((eb) => ({
    payload_json: payload,
    cookie_count: state.cookies.length,
    version: eb("version", "+", 1),
    updated_at: now,
  }))).execute();
}

export async function saveBrowserStateIfVersion(
  context: DbContext,
  config: Config,
  site: string,
  state: BrowserStateEnvelope,
  expectedVersion: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const payload = JSON.stringify(encryptBrowserState(state, config.stateKey));
  return context.db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom("browser_profiles").select("version").where("site", "=", site).executeTakeFirst();
    if ((current?.version ?? 0) !== expectedVersion) return false;
    if (!current) {
      try {
        await trx.insertInto("browser_profiles").values({
          site,
          payload_json: payload,
          cookie_count: state.cookies.length,
          version: 1,
          created_at: now,
          updated_at: now,
        }).execute();
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) return false;
        throw error;
      }
      return true;
    }
    const updated = await trx.updateTable("browser_profiles").set({
      payload_json: payload,
      cookie_count: state.cookies.length,
      version: current.version + 1,
      updated_at: now,
    }).where("site", "=", site).where("version", "=", expectedVersion).executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  });
}

export async function recomputeInheritedSchedules(context: DbContext): Promise<void> {
  const rows = await context.db.selectFrom("check_groups").select(["id", "schedule_mode", "cron_expression"]).execute();
  for (const row of rows) {
    const active = await context.db.selectFrom("applications").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("check_group_id", "=", row.id).where("automation_paused", "=", 0).executeTakeFirstOrThrow();
    const next = Number(active.count) ? await calculateNextRun(context, row) : null;
    await context.db.transaction().execute(async (trx) => {
      await trx.updateTable("check_groups").set({ next_run_at: next }).where("id", "=", row.id).execute();
      await trx.updateTable("applications").set({ next_run_at: next })
        .where("check_group_id", "=", row.id).where("automation_paused", "=", 0).execute();
    });
  }
}

export async function clearGroupScheduleIfFullyPaused(context: DbContext, groupId: string): Promise<void> {
  const active = await context.db.selectFrom("applications").select(({ fn }) => fn.countAll<number>().as("count"))
    .where("check_group_id", "=", groupId).where("automation_paused", "=", 0).executeTakeFirstOrThrow();
  if (Number(active.count)) return;
  const now = new Date().toISOString();
  await context.db.transaction().execute(async (trx) => {
    await trx.updateTable("check_groups").set({ next_run_at: null, updated_at: now }).where("id", "=", groupId).execute();
    await trx.updateTable("applications").set({ next_run_at: null, updated_at: now }).where("check_group_id", "=", groupId).execute();
  });
}

export interface ScreenshotCleanupResult {
  deleted: number;
  missing: number;
  failed: number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function cleanupExpiredScreenshots(
  context: DbContext,
  config: Config,
  retentionDays?: number,
  now = new Date(),
): Promise<ScreenshotCleanupResult> {
  const days = retentionDays ?? (await appSettings(context)).screenshot_retention_days;
  const cutoff = now.getTime() - days * 86_400_000;
  const rows = await context.db.selectFrom("runs")
    .select(["id", "application_id", "screenshot_path", "completed_at", "created_at"])
    .where("screenshot_path", "is not", null)
    .execute();
  const result: ScreenshotCleanupResult = { deleted: 0, missing: 0, failed: 0 };
  const touchedFolders = new Set<string>();
  for (const row of rows) {
    const timestamp = new Date(row.completed_at ?? row.created_at).getTime();
    if (!Number.isFinite(timestamp) || timestamp >= cutoff || !row.screenshot_path) continue;
    if (!isInside(config.screenshotsPath, row.screenshot_path)) {
      result.failed += 1;
      continue;
    }
    try {
      const info = await stat(row.screenshot_path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (info) {
        await rm(row.screenshot_path, { force: true });
        result.deleted += 1;
      } else {
        result.missing += 1;
      }
      await context.db.updateTable("runs").set({ screenshot_path: null })
        .where("id", "=", row.id).where("screenshot_path", "=", row.screenshot_path).execute();
      touchedFolders.add(path.dirname(row.screenshot_path));
    } catch {
      result.failed += 1;
    }
  }
  for (const folder of touchedFolders) {
    try {
      if ((await readdir(folder)).length === 0) await rm(folder, { recursive: false });
    } catch {}
  }
  return result;
}
