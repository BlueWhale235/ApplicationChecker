import type {
  ApplicationRecognitionResult, ApplicationSummary, BrowserProfileSummary, LoginSessionSummary, RunSummary, StatusEvent,
} from "@application-checker/contracts";
import type {
  ApplicationsTable, BrowserProfilesTable, LoginSessionsTable, RunApplicationResultsTable, RunsTable, StatusEventsTable,
} from "./db.js";

export const mapApplication = (
  row: ApplicationsTable & {
    browser_profile_updated_at?: string | null;
    group_member_count?: number | null;
    group_schedule_mode?: ApplicationsTable["schedule_mode"] | null;
    group_cron_expression?: string | null;
    group_next_run_at?: string | null;
    group_resolved_url?: string | null;
  },
): ApplicationSummary => ({
  id: row.id,
  company: row.company,
  jobTitle: row.job_title,
  checkUrl: row.check_url || null,
  resolvedUrl: row.group_resolved_url ?? row.resolved_url,
  postingUrl: row.posting_url,
  appliedAt: row.applied_at,
  location: row.location,
  notes: row.notes,
  site: row.site,
  checkGroupId: row.check_group_id ?? row.id,
  checkGroupMemberCount: Number(row.group_member_count ?? 1),
  progressStatus: row.progress_status_v2 ?? "unset",
  progressSource: row.progress_source,
  manualLocked: Boolean(row.manual_locked),
  automationPaused: Boolean(row.automation_paused),
  automationPauseReason: row.automation_pause_reason,
  automationPausedAt: row.automation_paused_at,
  scheduleMode: row.automation_paused ? "manual" : (row.group_schedule_mode ?? row.schedule_mode),
  cronExpression: row.automation_paused
    ? null
    : (row.group_cron_expression === undefined ? row.cron_expression : row.group_cron_expression),
  nextRunAt: row.automation_paused
    ? null
    : (row.group_next_run_at === undefined ? row.next_run_at : row.group_next_run_at),
  lastRunAt: row.last_run_at,
  lastRunStatus: row.last_run_status,
  lastStatusChangedAt: row.last_status_changed_at,
  browserProfileUpdatedAt: row.browser_profile_updated_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const mapRun = (
  row: RunsTable,
  recognitionResults: ApplicationRecognitionResult[] = [],
  groupMemberCount = recognitionResults.length || 1,
): RunSummary => ({
  id: row.id,
  applicationId: row.application_id,
  checkGroupId: row.check_group_id ?? row.application_id,
  groupMemberCount,
  trigger: row.trigger,
  status: row.status,
  finalUrl: row.final_url,
  pageTitle: row.page_title,
  screenshotAvailable: Boolean(row.screenshot_path),
  screenshotTruncated: Boolean(row.screenshot_truncated),
  aiStatus: row.ai_status,
  aiSuggestedStatus: row.ai_suggested_status_v2,
  aiConfidence: row.ai_confidence,
  aiEvidence: row.ai_evidence,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  recognitionResults,
});

export const mapRecognitionResult = (row: RunApplicationResultsTable): ApplicationRecognitionResult => ({
  applicationId: row.application_id,
  jobTitle: row.job_title_snapshot,
  matched: Boolean(row.matched),
  rawStatus: row.raw_status,
  suggestedStatus: row.suggested_status,
  confidence: row.confidence,
  evidence: row.evidence,
  applied: Boolean(row.applied),
  notAppliedReason: row.automation_paused ? "automation_paused" : row.not_applied_reason,
});

export const mapEvent = (row: StatusEventsTable): StatusEvent => ({
  id: row.id,
  applicationId: row.application_id,
  runId: row.run_id,
  fromStatus: row.from_status,
  toStatus: row.to_status,
  source: row.source,
  confidence: row.confidence,
  evidence: row.evidence,
  note: row.note,
  eventType: row.event_type,
  createdAt: row.created_at,
});

export const mapProfile = (row: BrowserProfilesTable): BrowserProfileSummary => ({
  site: row.site,
  cookieCount: row.cookie_count,
  version: row.version,
  updatedAt: row.updated_at,
});

export const mapLogin = (row: LoginSessionsTable): LoginSessionSummary => ({
  id: row.id,
  applicationId: row.application_id,
  runId: row.run_id,
  status: row.status,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  errorMessage: row.error_message,
});
