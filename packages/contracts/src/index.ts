import { Type, type Static } from "@sinclair/typebox";
import { getDomain } from "tldts";

export const ProgressStatusSchema = Type.Union([
  Type.Literal("unset"),
  Type.Literal("screening"),
  Type.Literal("screening_passed"),
  Type.Literal("interview_pending"),
  Type.Literal("interviewed"),
  Type.Literal("signing_pending"),
  Type.Literal("offer"),
  Type.Literal("rejected"),
]);
export type ProgressStatus = Static<typeof ProgressStatusSchema>;

export const RunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("needs_login"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
export type RunStatus = Static<typeof RunStatusSchema>;

export const ScheduleModeSchema = Type.Union([
  Type.Literal("inherit"),
  Type.Literal("custom"),
  Type.Literal("manual"),
]);
export type ScheduleMode = Static<typeof ScheduleModeSchema>;

export const RecognitionModeSchema = Type.Union([
  Type.Literal("local_first"),
  Type.Literal("local_only"),
  Type.Literal("ai_only"),
]);
export type RecognitionMode = Static<typeof RecognitionModeSchema>;

export const StatusMappingKeySchema = Type.Union([
  Type.Literal("screening"),
  Type.Literal("screening_passed"),
  Type.Literal("interview_pending"),
  Type.Literal("interviewed"),
  Type.Literal("signing_pending"),
  Type.Literal("offer"),
  Type.Literal("rejected"),
]);
export type StatusMappingKey = Static<typeof StatusMappingKeySchema>;

const StatusMappingTermsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 120 }),
  { maxItems: 100 },
);
export const StatusMappingsSchema = Type.Object({
  screening: StatusMappingTermsSchema,
  screening_passed: StatusMappingTermsSchema,
  interview_pending: StatusMappingTermsSchema,
  interviewed: StatusMappingTermsSchema,
  signing_pending: StatusMappingTermsSchema,
  offer: StatusMappingTermsSchema,
  rejected: StatusMappingTermsSchema,
}, { additionalProperties: false });
export type StatusMappings = Static<typeof StatusMappingsSchema>;

export type RecognitionSource = "local" | "ai" | "mixed";

export interface LocalDomNode {
  id: number;
  parentId: number | null;
  tag: string;
  role: string | null;
  classes: string[];
  dataStatus: string | null;
  ariaCurrent?: string | null;
  ariaSelected?: string | null;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocalPageSnapshot {
  url: string;
  title: string;
  language: string | null;
  visibleText: string;
  nodes: LocalDomNode[];
  truncated: boolean;
  nodeLimitReached: boolean;
  textLimitReached: boolean;
}

export interface ParserRouteRule {
  adapterId: string;
  version: string;
  priority: number;
  hostname: string;
  pathname: string;
}

export type AssistedRuleLayout = "list" | "stepper";

export interface AssistedNodeLocator {
  tag: string | null;
  role: string | null;
  classes: string[];
  dataStatus: string | null;
  ariaCurrent: string | null;
  ariaSelected: string | null;
  ancestorTags: string[];
}

export interface AssistedParserRuleDefinition {
  schemaVersion: 1;
  layout: AssistedRuleLayout;
  hostname: string;
  pathname: string;
  container: AssistedNodeLocator | null;
  title: AssistedNodeLocator;
  status: AssistedNodeLocator;
  active: AssistedNodeLocator | null;
}

export interface AssistedParserRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  version: number;
  definition: AssistedParserRuleDefinition;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
}

export interface AssistedRuleSelection {
  layout: AssistedRuleLayout;
  titleNodeId: number;
  statusNodeId: number;
  hostname?: string;
  pathname?: string;
  name?: string;
}

export interface AssistedRuleTestResult {
  valid: boolean;
  errors: string[];
  result: LocalRecognitionResult;
  matchedNodeIds: number[];
}

export interface RuleStudioCheckGroupOption {
  applicationId: string;
  groupId: string;
  company: string;
  jobTitle: string;
  site: string;
  url: string;
  memberCount: number;
}

export interface LocalRecognitionResultItem {
  applicationId: string;
  matched: boolean;
  rawStatus: string | null;
  status: ProgressStatus | null;
  confidence: number;
  evidence: string;
  titleMatch: "exact" | "contains" | "none";
  statusRule: string | null;
}

export interface LocalRecognitionResult {
  adapterId: string;
  adapterVersion: string;
  route: ParserRouteRule | null;
  pageType: "status" | "official_homepage" | "login" | "blank" | "unknown";
  pageEvidence: string | null;
  results: LocalRecognitionResultItem[];
  fallbackReason: string | null;
}

export const CheckPlanUpdateSchema = Type.Object({
  scheduleMode: ScheduleModeSchema,
  cronExpression: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
});
export type CheckPlanUpdate = Static<typeof CheckPlanUpdateSchema>;

export const CreateApplicationSchema = Type.Object({
  company: Type.String({ minLength: 1, maxLength: 160 }),
  jobTitle: Type.String({ minLength: 1, maxLength: 240 }),
  checkUrl: Type.Optional(Type.Union([Type.String({ format: "uri", maxLength: 2048 }), Type.Null()])),
  postingUrl: Type.Optional(Type.Union([Type.String({ format: "uri", maxLength: 2048 }), Type.Null()])),
  appliedAt: Type.Optional(Type.Union([Type.String({ format: "date" }), Type.Null()])),
  location: Type.Optional(Type.Union([Type.String({ maxLength: 160 }), Type.Null()])),
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 4000 }), Type.Null()])),
  scheduleMode: Type.Optional(ScheduleModeSchema),
  cronExpression: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
});
export type CreateApplication = Static<typeof CreateApplicationSchema>;

export const UpdateApplicationSchema = Type.Partial(CreateApplicationSchema);
export type UpdateApplication = Static<typeof UpdateApplicationSchema>;

export const SetProgressSchema = Type.Object({
  status: ProgressStatusSchema,
  note: Type.Optional(Type.String({ maxLength: 1000 })),
});
export type SetProgress = Static<typeof SetProgressSchema>;

export const BulkRunSchema = Type.Object({
  applicationIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }), { maxItems: 500 })),
});
export type BulkRun = Static<typeof BulkRunSchema>;

export const SettingsUpdateSchema = Type.Object({
  globalCron: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
  timezone: Type.String({ minLength: 1, maxLength: 64 }),
  screenshotRetentionDays: Type.Integer({ minimum: 1, maximum: 3650 }),
  defaultUserAgent: Type.String({ minLength: 1, maxLength: 512 }),
});
export type SettingsUpdate = Static<typeof SettingsUpdateSchema>;

export const AiSettingsUpdateSchema = Type.Object({
  baseUrl: Type.Union([Type.String({ format: "uri", maxLength: 2048 }), Type.Null()]),
  model: Type.Union([Type.String({ maxLength: 240 }), Type.Null()]),
  apiKey: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()])),
  confidenceThreshold: Type.Number({ minimum: 0, maximum: 1 }),
  deepThinking: Type.Optional(Type.Boolean()),
});
export type AiSettingsUpdate = Static<typeof AiSettingsUpdateSchema>;

export const RecognitionSettingsUpdateSchema = Type.Object({
  recognitionMode: RecognitionModeSchema,
});
export type RecognitionSettingsUpdate = Static<typeof RecognitionSettingsUpdateSchema>;

export const StatusMappingsUpdateSchema = Type.Object({
  statusMappings: StatusMappingsSchema,
});
export type StatusMappingsUpdate = Static<typeof StatusMappingsUpdateSchema>;

export interface ApplicationSummary {
  id: string;
  company: string;
  jobTitle: string;
  checkUrl: string | null;
  resolvedUrl: string | null;
  postingUrl: string | null;
  appliedAt: string | null;
  location: string | null;
  notes: string | null;
  checkGroupId: string;
  checkGroupMemberCount: number;
  site: string;
  progressStatus: ProgressStatus;
  progressSource: "manual" | "local" | "ai" | null;
  manualLocked: boolean;
  automationPaused: boolean;
  automationPauseReason: "rejected" | null;
  automationPausedAt: string | null;
  scheduleMode: ScheduleMode;
  cronExpression: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  lastStatusChangedAt: string | null;
  browserProfileUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunSummary {
  id: string;
  applicationId: string;
  checkGroupId: string;
  groupMemberCount: number;
  trigger: "manual" | "bulk" | "cron" | "login_resume";
  status: RunStatus;
  finalUrl: string | null;
  pageTitle: string | null;
  screenshotAvailable: boolean;
  screenshotTruncated: boolean;
  aiStatus: "skipped" | "pending" | "succeeded" | "failed";
  aiSuggestedStatus: ProgressStatus | null;
  aiConfidence: number | null;
  aiEvidence: string | null;
  recognitionMode: RecognitionMode;
  recognitionStatus: "skipped" | "pending" | "succeeded" | "partial" | "failed";
  recognitionSource: RecognitionSource | null;
  recognitionSuggestedStatus: ProgressStatus | null;
  recognitionConfidence: number | null;
  recognitionEvidence: string | null;
  recognitionProvider: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  recognitionResults: ApplicationRecognitionResult[];
}

export interface TaskRunSummary extends RunSummary {
  company: string;
  jobTitle: string;
  site: string;
  progressStatus: ProgressStatus;
}

export interface ApplicationRecognitionResult {
  applicationId: string;
  jobTitle: string;
  matched: boolean;
  rawStatus: string | null;
  suggestedStatus: ProgressStatus | null;
  confidence: number | null;
  evidence: string | null;
  applied: boolean;
  notAppliedReason: "manual_locked" | "low_confidence" | "unmatched" | "ai_failed" | "automation_paused" | null;
  source: Exclude<RecognitionSource, "mixed"> | null;
  adapterId: string | null;
  ruleVersion: string | null;
}

export interface CheckGroupMember {
  id: string;
  jobTitle: string;
  progressStatus: ProgressStatus;
  manualLocked: boolean;
  automationPaused: boolean;
}

export interface CheckGroupSummary {
  id: string;
  company: string;
  checkUrl: string | null;
  resolvedUrl: string | null;
  site: string;
  scheduleMode: ScheduleMode;
  cronExpression: string | null;
  nextRunAt: string | null;
  memberCount: number;
  members: CheckGroupMember[];
}

export type GroupRunSummary = RunSummary;

export interface TaskRunPage {
  items: TaskRunSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface NotificationSummary {
  id: string;
  applicationId: string;
  runId: string | null;
  statusEventId: string;
  company: string;
  jobTitle: string;
  fromStatus: ProgressStatus;
  toStatus: ProgressStatus;
  confidence: number | null;
  evidence: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationSummary[];
  total: number;
  unreadCount: number;
  limit: number;
  offset: number;
}

export interface AiDebugTraceSummary {
  id: string;
  runId: string | null;
  createdAt: string;
  completedAt: string | null;
  company: string;
  applicationCount: number;
  model: string;
  status: "pending" | "succeeded" | "failed";
  durationMs: number | null;
  httpStatus: number | null;
  recognitionSource?: RecognitionSource;
  adapterId?: string | null;
}

export interface AiDebugTraceAttempt {
  deepThinking: boolean;
  startedAt: string;
  durationMs: number;
  httpStatus: number | null;
  responseBody: string | null;
  responseTruncated: boolean;
  error: string | null;
}

export interface AiDebugTraceDetail extends AiDebugTraceSummary {
  endpoint: string;
  pageTitle: string | null;
  finalUrl: string | null;
  applications: Array<{
    id: string;
    jobTitle: string;
    appliedAt: string | null;
    location: string | null;
  }>;
  systemPrompt: string;
  userPrompt: string;
  sanitizedRequest: string;
  screenshotBytes: number;
  screenshotTruncated: boolean;
  attempts: AiDebugTraceAttempt[];
  parsed: {
    pageType: string | null;
    pageEvidence: string | null;
    results: Array<{
      applicationId: string;
      matched: boolean;
      rawStatus: string | null;
      status: ProgressStatus | null;
      confidence: number;
      evidence: string;
    }>;
  } | null;
  error: string | null;
  adapterVersion?: string | null;
  route?: ParserRouteRule | null;
  localSnapshotSummary?: {
    nodeCount: number;
    textCharacters: number;
    truncated: boolean;
    nodeLimitReached: boolean;
    textLimitReached: boolean;
  } | null;
}

export interface StatusEvent {
  id: string;
  applicationId: string;
  runId: string | null;
  fromStatus: ProgressStatus;
  toStatus: ProgressStatus;
  source: "manual" | "local" | "ai";
  confidence: number | null;
  evidence: string | null;
  note: string | null;
  eventType: "progress" | "applied";
  createdAt: string;
}

export interface ApplicationDetail {
  application: ApplicationSummary;
  checkGroup: CheckGroupSummary;
  runs: RunSummary[];
  statusEvents: StatusEvent[];
}

export interface BrowserProfileSummary {
  site: string;
  cookieCount: number;
  version: number;
  updatedAt: string;
}

export interface LoginSessionSummary {
  id: string;
  applicationId: string;
  runId: string;
  status: "queued" | "starting" | "ready" | "active" | "saving" | "completed" | "cancelled" | "expired" | "failed";
  expiresAt: string;
  createdAt: string;
  errorMessage: string | null;
}

export interface AppSettings {
  globalCron: string | null;
  timezone: string;
  screenshotRetentionDays: number;
  defaultUserAgent: string;
  aiConfigured: boolean;
  aiBaseUrl: string | null;
  aiModel: string | null;
  aiApiKeySet: boolean;
  aiConfidenceThreshold: number;
  aiDeepThinking: boolean;
  recognitionMode: RecognitionMode;
  statusMappings: StatusMappings;
  builtinStatusMappings: StatusMappings;
  runnerHealthy: boolean;
  loginPresentation: "vnc" | "external-window";
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface OriginStorage {
  origin: string;
  localStorage: Record<string, string>;
}

export interface BrowserStateEnvelope {
  version: 1;
  cookies: BrowserCookie[];
  origins: OriginStorage[];
}

export interface RunnerJob {
  kind: "capture";
  runId: string;
  groupId: string;
  applicationId: string;
  url: string;
  company: string;
  jobTitle: string;
  applications: Array<{
    id: string;
    jobTitle: string;
    appliedAt: string | null;
    location: string | null;
  }>;
  site: string;
  browserState: BrowserStateEnvelope | null;
  proxyUrl: string | null;
  userAgent: string;
  recognitionMode: RecognitionMode;
}

export interface RunnerLoginJob {
  kind: "login";
  sessionId: string;
  runId: string;
  groupId: string;
  applicationId: string;
  url: string;
  site: string;
  browserState: BrowserStateEnvelope | null;
  expiresAt: string;
  proxyUrl: string | null;
  userAgent: string;
}

export interface RunnerRecognitionPreviewJob {
  kind: "recognition_preview";
  previewId: string;
  groupId: string;
  applicationId: string;
  url: string;
  company: string;
  applications: Array<{
    id: string;
    jobTitle: string;
    appliedAt: string | null;
    location: string | null;
  }>;
  site: string;
  browserState: BrowserStateEnvelope | null;
  proxyUrl: string | null;
  userAgent: string;
}

export interface RecognitionPreviewSummary {
  id: string;
  applicationId: string;
  company: string;
  site: string;
  status: "queued" | "running" | "succeeded" | "needs_login" | "failed";
  createdAt: string;
  completedAt: string | null;
  adapterId: string | null;
  matchedCount: number;
  applicationCount: number;
  error: string | null;
}

export interface RecognitionPreviewDetail extends RecognitionPreviewSummary {
  finalUrl: string | null;
  pageTitle: string | null;
  route: ParserRouteRule | null;
  adapterVersion: string | null;
  pageType: LocalRecognitionResult["pageType"] | null;
  pageEvidence: string | null;
  snapshotSummary: {
    nodeCount: number;
    textCharacters: number;
    truncated: boolean;
    nodeLimitReached: boolean;
    textLimitReached: boolean;
  } | null;
  results: LocalRecognitionResultItem[];
  screenshotAvailable: boolean;
  screenshotWidth: number | null;
  screenshotHeight: number | null;
  screenshotTruncated: boolean;
}

export interface RecognitionPreviewSnapshot {
  snapshot: LocalPageSnapshot;
  applications: RunnerRecognitionPreviewJob["applications"];
  screenshotWidth: number;
  screenshotHeight: number;
  screenshotTruncated: boolean;
}

export const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function siteForUrl(input: string): string {
  const parsed = new URL(input);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported");
  const site = getDomain(parsed.hostname, { allowPrivateDomains: false });
  if (!site) throw new Error("A registrable public domain is required");
  return site.toLowerCase();
}

export function normalizeCompany(input: string): string {
  return input.normalize("NFKC").trim().toLocaleLowerCase("und");
}

export function normalizeCheckUrl(input: string): string {
  const url = new URL(input);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export const progressLabels: Record<ProgressStatus, string> = {
  unset: "未设置",
  screening: "初筛",
  screening_passed: "已过初筛",
  interview_pending: "待面试",
  interviewed: "已面试",
  signing_pending: "待签约",
  offer: "已收 OFFER",
  rejected: "淘汰",
};

export const runLabels: Record<RunStatus, string> = {
  queued: "排队中",
  running: "检查中",
  needs_login: "需要登录",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};
