import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AiSettingsUpdateSchema,
  BulkRunSchema,
  CheckPlanUpdateSchema,
  CreateApplicationSchema,
  RecognitionSettingsUpdateSchema,
  StatusMappingsUpdateSchema,
  SetProgressSchema,
  SettingsUpdateSchema,
  UpdateApplicationSchema,
  siteForUrl,
  type BrowserStateEnvelope,
  type ApplicationRecognitionResult,
  type ProgressStatus,
  type RunnerJob,
  type RunnerLoginJob,
} from "@application-checker/contracts";
import type { StatusRecognizer } from "@application-checker/ai-status";
import type { Config } from "../config.js";
import type { AiDebugStore } from "../ai-debug.js";
import type { RecognitionPreviewStore } from "../recognition-preview.js";
import type { DbContext, RunsTable } from "../db.js";
import { mapApplication, mapEvent, mapLogin, mapProfile, mapRecognitionResult, mapRun } from "../mappers.js";
import { assertPublicUrl } from "../security.js";
import {
  appSettings, calculateNextRun, cleanupExpiredScreenshots, clearGroupScheduleIfFullyPaused, loadBrowserState, queueRun,
  findOrCreateCheckGroup, recomputeInheritedSchedules, saveBrowserState,
} from "../service.js";
import {
  recognizerFromSettings, syncRuntimeSettingsFile, updateAiSettings,
} from "../runtime-settings.js";

export const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const nowIso = () => new Date().toISOString();
export const appliedAtIso = (value: string) => new Date(`${value}T00:00:00+08:00`).toISOString();
export const apiPath = (request: FastifyRequest) => request.url.replace(/^\/api(?=\/)/, "").split("?")[0] ?? "";
export const activeRunStatuses = ["queued", "running", "needs_login"] as const;

export function isActiveRunConstraint(error: unknown): boolean {
  return error instanceof Error
    && /UNIQUE constraint failed: runs\.(?:application_id|check_group_id)/i.test(error.message);
}

export async function cancelActiveRuns(
  context: DbContext,
  runIds: string[],
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  if (!runIds.length) return;
  const now = nowIso();
  await context.db.transaction().execute(async (trx) => {
    await trx.updateTable("runs").set({
      status: "cancelled",
      completed_at: now,
      error_code: errorCode,
      error_message: errorMessage,
    }).where("id", "in", runIds).where("status", "in", [...activeRunStatuses]).execute();
    await trx.updateTable("login_sessions").set({
      status: "cancelled",
      completed_at: now,
      updated_at: now,
    }).where("run_id", "in", runIds)
      .where("status", "in", ["queued", "starting", "ready", "active", "saving"]).execute();
  });
}

export async function syncAppliedEvent(context: DbContext, applicationId: string, appliedAt: string | null): Promise<void> {
  const existing = await context.db.selectFrom("status_events").select("id")
    .where("application_id", "=", applicationId).where("event_type", "=", "applied").executeTakeFirst();
  if (!appliedAt) {
    if (existing) await context.db.deleteFrom("status_events").where("id", "=", existing.id).execute();
    return;
  }
  const createdAt = appliedAtIso(appliedAt);
  if (existing) {
    await context.db.updateTable("status_events").set({ created_at: createdAt })
      .where("id", "=", existing.id).execute();
    return;
  }
  await context.db.insertInto("status_events").values({
    id: randomUUID(),
    application_id: applicationId,
    run_id: null,
    from_status: "unset",
    to_status: "unset",
    source: "manual",
    confidence: null,
    evidence: null,
    note: "投递",
    event_type: "applied",
    created_at: createdAt,
  }).execute();
}

export function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

export async function applicationRows(context: DbContext) {
  return context.db.selectFrom("applications")
    .leftJoin("browser_profiles", "browser_profiles.site", "applications.site")
    .leftJoin("check_groups", "check_groups.id", "applications.check_group_id")
    .selectAll("applications")
    .select([
      "browser_profiles.updated_at as browser_profile_updated_at",
      "check_groups.schedule_mode as group_schedule_mode",
      "check_groups.cron_expression as group_cron_expression",
      "check_groups.next_run_at as group_next_run_at",
      "check_groups.resolved_url as group_resolved_url",
    ])
    .select((eb) => eb.selectFrom("applications as group_members")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .whereRef("group_members.check_group_id", "=", "applications.check_group_id")
      .as("group_member_count"));
}

export function runnerAuthorized(request: FastifyRequest, config: Config): boolean {
  return request.headers.authorization === `Bearer ${config.runnerToken}`;
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function persistScreenshot(config: Config, groupId: string, runId: string, base64: string): Promise<string> {
  const folder = path.join(config.screenshotsPath, "groups", groupId);
  await mkdir(folder, { recursive: true });
  const filename = path.join(folder, `${runId}.png`);
  await writeFile(filename, Buffer.from(base64, "base64"));
  return filename;
}

export function legacyStatus(status: ProgressStatus): string {
  return ["screening_passed", "interviewed"].includes(status) ? "screening" : status;
}

export async function recognitionResults(context: DbContext, runIds: string[]): Promise<Map<string, ApplicationRecognitionResult[]>> {
  const mapped = new Map<string, ApplicationRecognitionResult[]>();
  if (!runIds.length) return mapped;
  const rows = await context.db.selectFrom("run_application_results").selectAll().where("run_id", "in", runIds).execute();
  for (const row of rows) mapped.set(row.run_id, [...(mapped.get(row.run_id) ?? []), mapRecognitionResult(row)]);
  return mapped;
}

export interface RouteDeps {
  context: DbContext;
  config: Config;
  recognizer?: StatusRecognizer;
  aiDebugStore?: AiDebugStore;
  recognitionPreviewStore?: RecognitionPreviewStore;
  runnerHeartbeat: { at: number };
}

export {
  AiSettingsUpdateSchema,
  BulkRunSchema,
  CheckPlanUpdateSchema,
  CreateApplicationSchema,
  RecognitionSettingsUpdateSchema,
  StatusMappingsUpdateSchema,
  SetProgressSchema,
  SettingsUpdateSchema,
  UpdateApplicationSchema,
  appSettings,
  assertPublicUrl,
  calculateNextRun,
  cleanupExpiredScreenshots,
  clearGroupScheduleIfFullyPaused,
  createReadStream,
  findOrCreateCheckGroup,
  loadBrowserState,
  mapApplication,
  mapEvent,
  mapLogin,
  mapProfile,
  mapRun,
  path,
  queueRun,
  randomBytes,
  randomUUID,
  recognizerFromSettings,
  recomputeInheritedSchedules,
  rm,
  saveBrowserState,
  siteForUrl,
  stat,
  syncRuntimeSettingsFile,
  updateAiSettings,
};

export type {
  ApplicationRecognitionResult,
  BrowserStateEnvelope,
  DbContext,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  ProgressStatus,
  RunnerJob,
  RunnerLoginJob,
  RunsTable,
};
