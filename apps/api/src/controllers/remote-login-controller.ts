import {
  AiSettingsUpdateSchema,
  BulkRunSchema,
  CheckPlanUpdateSchema,
  CreateApplicationSchema,
  SetProgressSchema,
  SettingsUpdateSchema,
  UpdateApplicationSchema,
  activeRunStatuses,
  apiPath,
  appSettings,
  applicationRows,
  assertPublicUrl,
  calculateNextRun,
  cancelActiveRuns,
  cleanupExpiredScreenshots,
  clearGroupScheduleIfFullyPaused,
  createReadStream,
  findOrCreateCheckGroup,
  httpError,
  isActiveRunConstraint,
  isInside,
  legacyStatus,
  loadBrowserState,
  mapApplication,
  mapEvent,
  mapLogin,
  mapProfile,
  mapRun,
  nowIso,
  path,
  persistScreenshot,
  queueRun,
  randomBytes,
  randomUUID,
  recognitionResults,
  recognizerFromSettings,
  recomputeInheritedSchedules,
  rm,
  runnerAuthorized,
  saveBrowserState,
  sha,
  siteForUrl,
  stat,
  syncAppliedEvent,
  syncRuntimeSettingsFile,
  updateAiSettings,
} from "./shared.js";
import type {
  BrowserStateEnvelope,
  DbContext,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  ProgressStatus,
  RouteDeps,
  RunnerJob,
  RunnerLoginJob,
  RunsTable,
} from "./shared.js";

export async function exchangeRemoteLogin(
  request: FastifyRequest,
  reply: FastifyReply,
  context: DbContext,
): Promise<void> {
  const id = (request.params as { id: string }).id;
  const token = (request.query as { token?: string }).token;
  if (!token) throw httpError(401, "缺少远程登录令牌");
  const row = await context.db.selectFrom("login_sessions").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row || row.token_used_at || sha(token) !== row.access_token_hash ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      !["starting", "ready", "active"].includes(row.status)) throw httpError(401, "远程登录链接已失效");
  await context.db.updateTable("login_sessions").set({
    token_used_at: nowIso(),
    status: row.status === "ready" ? "active" : row.status,
    updated_at: nowIso(),
  }).where("id", "=", id).execute();
  reply.setCookie("ac_remote", `${id}.${token}`, {
    httpOnly: true,
    sameSite: "strict",
    path: "/vnc",
    maxAge: Math.max(1, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
  });
  return reply.redirect("/vnc/vnc.html?autoconnect=1&resize=scale&path=vnc/websockify");
}

export async function authorizeVncRequest(request: FastifyRequest, context: DbContext): Promise<boolean> {
  const value = request.cookies.ac_remote;
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot < 0) return false;
  const id = value.slice(0, dot);
  const token = value.slice(dot + 1);
  const row = await context.db.selectFrom("login_sessions").select(["access_token_hash", "status", "expires_at"])
    .where("id", "=", id).executeTakeFirst();
  return Boolean(row && sha(token) === row.access_token_hash &&
    new Date(row.expires_at).getTime() > Date.now() &&
    ["starting", "ready", "active", "saving"].includes(row.status));
}
