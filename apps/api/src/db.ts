import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { Generated, Kysely, SqliteDialect } from "kysely";
import {
  DEFAULT_USER_AGENT, normalizeCheckUrl, normalizeCompany,
  type ProgressStatus, type RunStatus, type ScheduleMode,
} from "@application-checker/contracts";

export interface ApplicationsTable {
  id: string;
  check_group_id: string | null;
  company: string;
  job_title: string;
  check_url: string;
  resolved_url: string | null;
  posting_url: string | null;
  applied_at: string | null;
  location: string | null;
  notes: string | null;
  site: string;
  progress_status: string;
  progress_status_v2: ProgressStatus | null;
  progress_source: "manual" | "ai" | null;
  manual_locked: number;
  automation_paused: number;
  automation_pause_reason: "rejected" | null;
  automation_paused_at: string | null;
  schedule_mode: ScheduleMode;
  cron_expression: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: RunStatus | null;
  last_status_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunsTable {
  id: string;
  check_group_id: string | null;
  application_id: string;
  trigger: "manual" | "bulk" | "cron" | "login_resume";
  status: RunStatus;
  final_url: string | null;
  page_title: string | null;
  screenshot_path: string | null;
  screenshot_truncated: number;
  ai_status: "skipped" | "pending" | "succeeded" | "failed";
  ai_suggested_status: string | null;
  ai_suggested_status_v2: ProgressStatus | null;
  ai_confidence: number | null;
  ai_evidence: string | null;
  ai_provider: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CheckGroupsTable {
  id: string;
  company: string;
  company_key: string;
  normalized_url: string;
  check_url: string;
  resolved_url: string | null;
  site: string;
  schedule_mode: ScheduleMode;
  cron_expression: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunApplicationResultsTable {
  id: string;
  run_id: string;
  application_id: string;
  job_title_snapshot: string;
  matched: number;
  raw_status: string | null;
  suggested_status: ProgressStatus | null;
  confidence: number | null;
  evidence: string | null;
  applied: number;
  not_applied_reason: "manual_locked" | "low_confidence" | "unmatched" | "ai_failed" | null;
  automation_paused: number;
  created_at: string;
}

export interface StatusEventsTable {
  id: string;
  application_id: string;
  run_id: string | null;
  from_status: ProgressStatus;
  to_status: ProgressStatus;
  source: "manual" | "ai";
  confidence: number | null;
  evidence: string | null;
  note: string | null;
  event_type: "progress" | "applied";
  created_at: string;
}

export interface NotificationsTable {
  id: string;
  application_id: string;
  run_id: string | null;
  status_event_id: string;
  company_snapshot: string;
  job_title_snapshot: string;
  from_status: ProgressStatus;
  to_status: ProgressStatus;
  confidence: number | null;
  evidence: string | null;
  read_at: string | null;
  created_at: string;
}

export interface BrowserProfilesTable {
  site: string;
  payload_json: string;
  cookie_count: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface LoginSessionsTable {
  id: string;
  application_id: string;
  run_id: string;
  status: "queued" | "starting" | "ready" | "active" | "saving" | "completed" | "cancelled" | "expired" | "failed";
  access_token_hash: string;
  token_used_at: string | null;
  expires_at: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AppSettingsTable {
  id: Generated<number>;
  global_cron: string | null;
  timezone: string;
  screenshot_retention_days: number;
  default_user_agent: string;
  ai_base_url: string | null;
  ai_model: string | null;
  ai_api_key_encrypted: string | null;
  ai_confidence_threshold: number;
  updated_at: string;
}

export interface Database {
  check_groups: CheckGroupsTable;
  applications: ApplicationsTable;
  runs: RunsTable;
  run_application_results: RunApplicationResultsTable;
  status_events: StatusEventsTable;
  notifications: NotificationsTable;
  browser_profiles: BrowserProfilesTable;
  login_sessions: LoginSessionsTable;
  app_settings: AppSettingsTable;
}

export interface DbContext {
  db: Kysely<Database>;
  raw: DatabaseDriver.Database;
}

const schema = `
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  check_group_id TEXT,
  company TEXT NOT NULL,
  job_title TEXT NOT NULL,
  check_url TEXT NOT NULL,
  resolved_url TEXT,
  posting_url TEXT,
  applied_at TEXT,
  location TEXT,
  notes TEXT,
  site TEXT NOT NULL,
  progress_status TEXT NOT NULL DEFAULT 'unset' CHECK(progress_status IN ('unset','screening','interview_pending','interview_result_pending','signing_pending','offer','rejected')),
  progress_status_v2 TEXT CHECK(progress_status_v2 IN ('unset','screening','screening_passed','interview_pending','interviewed','signing_pending','offer','rejected')),
  progress_source TEXT CHECK(progress_source IN ('manual','ai')),
  manual_locked INTEGER NOT NULL DEFAULT 0,
  automation_paused INTEGER NOT NULL DEFAULT 0,
  automation_pause_reason TEXT CHECK(automation_pause_reason IN ('rejected')),
  automation_paused_at TEXT,
  schedule_mode TEXT NOT NULL DEFAULT 'inherit' CHECK(schedule_mode IN ('inherit','custom','manual')),
  cron_expression TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_status TEXT CHECK(last_run_status IN ('queued','running','needs_login','succeeded','failed','cancelled')),
  last_status_changed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  check_group_id TEXT,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK(trigger IN ('manual','bulk','cron','login_resume')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','needs_login','succeeded','failed','cancelled')),
  final_url TEXT,
  page_title TEXT,
  screenshot_path TEXT,
  screenshot_truncated INTEGER NOT NULL DEFAULT 0,
  ai_status TEXT NOT NULL DEFAULT 'skipped' CHECK(ai_status IN ('skipped','pending','succeeded','failed')),
  ai_suggested_status TEXT CHECK(ai_suggested_status IN ('unset','screening','interview_pending','interview_result_pending','signing_pending','offer','rejected')),
  ai_suggested_status_v2 TEXT CHECK(ai_suggested_status_v2 IN ('unset','screening','screening_passed','interview_pending','interviewed','signing_pending','offer','rejected')),
  ai_confidence REAL,
  ai_evidence TEXT,
  ai_provider TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_application
  ON runs(application_id) WHERE status IN ('queued','running','needs_login');
CREATE INDEX IF NOT EXISTS runs_application_created ON runs(application_id, created_at DESC);
CREATE TABLE IF NOT EXISTS check_groups (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  company_key TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  check_url TEXT NOT NULL,
  resolved_url TEXT,
  site TEXT NOT NULL,
  schedule_mode TEXT NOT NULL CHECK(schedule_mode IN ('inherit','custom','manual')),
  cron_expression TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_key, normalized_url)
);
CREATE TABLE IF NOT EXISTS run_application_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  job_title_snapshot TEXT NOT NULL,
  matched INTEGER NOT NULL DEFAULT 0,
  raw_status TEXT,
  suggested_status TEXT CHECK(suggested_status IN ('unset','screening','screening_passed','interview_pending','interviewed','signing_pending','offer','rejected')),
  confidence REAL,
  evidence TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  not_applied_reason TEXT CHECK(not_applied_reason IN ('manual_locked','low_confidence','unmatched','ai_failed')),
  automation_paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, application_id)
);
CREATE INDEX IF NOT EXISTS run_results_application ON run_application_results(application_id, created_at DESC);
CREATE TABLE IF NOT EXISTS status_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','ai')),
  confidence REAL,
  evidence TEXT,
  note TEXT,
  event_type TEXT NOT NULL DEFAULT 'progress' CHECK(event_type IN ('progress','applied')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS status_events_application_created ON status_events(application_id, created_at DESC);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status_event_id TEXT NOT NULL UNIQUE REFERENCES status_events(id) ON DELETE CASCADE,
  company_snapshot TEXT NOT NULL,
  job_title_snapshot TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  confidence REAL,
  evidence TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(read_at, created_at DESC);
CREATE TABLE IF NOT EXISTS browser_profiles (
  site TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  cookie_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_sessions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','starting','ready','active','saving','completed','cancelled','expired','failed')),
  access_token_hash TEXT NOT NULL,
  token_used_at TEXT,
  expires_at TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS login_one_active
  ON login_sessions(id) WHERE status IN ('queued','starting','ready','active','saving');
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  global_cron TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  screenshot_retention_days INTEGER NOT NULL DEFAULT 30 CHECK(screenshot_retention_days BETWEEN 1 AND 3650),
  default_user_agent TEXT NOT NULL DEFAULT '${DEFAULT_USER_AGENT}',
  ai_base_url TEXT,
  ai_model TEXT,
  ai_api_key_encrypted TEXT,
  ai_confidence_threshold REAL NOT NULL DEFAULT 0.75 CHECK(ai_confidence_threshold BETWEEN 0 AND 1),
  updated_at TEXT NOT NULL
);
`;

export function createDb(filename: string): DbContext {
  mkdirSync(path.dirname(filename), { recursive: true });
  const raw = new DatabaseDriver(filename);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  raw.exec(schema);
  const settingsColumns = raw.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>;
  if (!settingsColumns.some((column) => column.name === "screenshot_retention_days")) {
    raw.exec("ALTER TABLE app_settings ADD COLUMN screenshot_retention_days INTEGER NOT NULL DEFAULT 30 CHECK(screenshot_retention_days BETWEEN 1 AND 3650)");
  }
  if (!settingsColumns.some((column) => column.name === "default_user_agent")) {
    raw.exec(`ALTER TABLE app_settings ADD COLUMN default_user_agent TEXT NOT NULL DEFAULT '${DEFAULT_USER_AGENT}'`);
  }
  if (!settingsColumns.some((column) => column.name === "ai_base_url")) {
    raw.exec("ALTER TABLE app_settings ADD COLUMN ai_base_url TEXT");
  }
  if (!settingsColumns.some((column) => column.name === "ai_model")) {
    raw.exec("ALTER TABLE app_settings ADD COLUMN ai_model TEXT");
  }
  if (!settingsColumns.some((column) => column.name === "ai_api_key_encrypted")) {
    raw.exec("ALTER TABLE app_settings ADD COLUMN ai_api_key_encrypted TEXT");
  }
  if (!settingsColumns.some((column) => column.name === "ai_confidence_threshold")) {
    raw.exec("ALTER TABLE app_settings ADD COLUMN ai_confidence_threshold REAL NOT NULL DEFAULT 0.75 CHECK(ai_confidence_threshold BETWEEN 0 AND 1)");
  }
  const applicationColumns = raw.prepare("PRAGMA table_info(applications)").all() as Array<{ name: string }>;
  if (!applicationColumns.some((column) => column.name === "check_group_id")) {
    raw.exec("ALTER TABLE applications ADD COLUMN check_group_id TEXT");
  }
  if (!applicationColumns.some((column) => column.name === "progress_status_v2")) {
    raw.exec("ALTER TABLE applications ADD COLUMN progress_status_v2 TEXT");
  }
  if (!applicationColumns.some((column) => column.name === "automation_paused")) {
    raw.exec("ALTER TABLE applications ADD COLUMN automation_paused INTEGER NOT NULL DEFAULT 0");
  }
  if (!applicationColumns.some((column) => column.name === "automation_pause_reason")) {
    raw.exec("ALTER TABLE applications ADD COLUMN automation_pause_reason TEXT CHECK(automation_pause_reason IN ('rejected'))");
  }
  if (!applicationColumns.some((column) => column.name === "automation_paused_at")) {
    raw.exec("ALTER TABLE applications ADD COLUMN automation_paused_at TEXT");
  }
  const runColumns = raw.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "check_group_id")) {
    raw.exec("ALTER TABLE runs ADD COLUMN check_group_id TEXT");
  }
  if (!runColumns.some((column) => column.name === "ai_suggested_status_v2")) {
    raw.exec("ALTER TABLE runs ADD COLUMN ai_suggested_status_v2 TEXT");
  }
  const runResultColumns = raw.prepare("PRAGMA table_info(run_application_results)").all() as Array<{ name: string }>;
  if (!runResultColumns.some((column) => column.name === "automation_paused")) {
    raw.exec("ALTER TABLE run_application_results ADD COLUMN automation_paused INTEGER NOT NULL DEFAULT 0");
  }
  const statusEventColumns = raw.prepare("PRAGMA table_info(status_events)").all() as Array<{ name: string }>;
  if (!statusEventColumns.some((column) => column.name === "event_type")) {
    raw.exec("ALTER TABLE status_events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'progress' CHECK(event_type IN ('progress','applied'))");
  }
  raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS status_events_one_applied ON status_events(application_id) WHERE event_type = 'applied'");
  raw.exec(`
    UPDATE applications
      SET progress_status_v2 = CASE
        WHEN progress_status = 'interview_result_pending' THEN 'interviewed'
        ELSE progress_status
      END
      WHERE progress_status_v2 IS NULL;
    UPDATE applications SET progress_status = 'screening'
      WHERE progress_status = 'interview_result_pending';
    UPDATE runs
      SET ai_suggested_status_v2 = CASE
        WHEN ai_suggested_status = 'interview_result_pending' THEN 'interviewed'
        ELSE ai_suggested_status
      END
      WHERE ai_suggested_status_v2 IS NULL AND ai_suggested_status IS NOT NULL;
    UPDATE runs SET ai_suggested_status = NULL
      WHERE ai_suggested_status = 'interview_result_pending';
    UPDATE status_events SET from_status = 'interviewed'
      WHERE from_status = 'interview_result_pending';
    UPDATE status_events SET to_status = 'interviewed'
      WHERE to_status = 'interview_result_pending';
  `);
  const appliedApplications = raw.prepare(`
    SELECT id, applied_at FROM applications
    WHERE applied_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM status_events
        WHERE status_events.application_id = applications.id
          AND status_events.event_type = 'applied'
      )
  `).all() as Array<{ id: string; applied_at: string }>;
  const insertAppliedEvent = raw.prepare(`
    INSERT INTO status_events(
      id, application_id, run_id, from_status, to_status, source,
      confidence, evidence, note, event_type, created_at
    ) VALUES(?, ?, NULL, 'unset', 'unset', 'manual', NULL, NULL, '投递', 'applied', ?)
  `);
  for (const application of appliedApplications) {
    const appliedAt = new Date(`${application.applied_at}T00:00:00+08:00`).toISOString();
    insertAppliedEvent.run(randomUUID(), application.id, appliedAt);
  }
  const migratedAt = new Date().toISOString();
  const existingApplications = raw.prepare(`
    SELECT id, company, check_url, resolved_url, site, schedule_mode, cron_expression, next_run_at, created_at
    FROM applications ORDER BY created_at
  `).all() as Array<{
    id: string; company: string; check_url: string; resolved_url: string | null; site: string;
    schedule_mode: ScheduleMode; cron_expression: string | null; next_run_at: string | null; created_at: string;
  }>;
  const findGroup = raw.prepare("SELECT * FROM check_groups WHERE company_key = ? AND normalized_url = ?");
  const insertGroup = raw.prepare(`
    INSERT INTO check_groups(
      id,company,company_key,normalized_url,check_url,resolved_url,site,
      schedule_mode,cron_expression,next_run_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const setGroup = raw.prepare("UPDATE applications SET check_group_id = ? WHERE id = ?");
  const makeManual = raw.prepare(`
    UPDATE check_groups SET schedule_mode = 'manual', cron_expression = NULL, next_run_at = NULL, updated_at = ?
    WHERE id = ?
  `);
  raw.transaction(() => {
    for (const application of existingApplications) {
      const companyKey = normalizeCompany(application.company);
      const normalizedUrl = application.check_url
        ? normalizeCheckUrl(application.check_url)
        : `manual:${application.id}`;
      let group = findGroup.get(companyKey, normalizedUrl) as CheckGroupsTable | undefined;
      if (!group) {
        const groupId = randomUUID();
        insertGroup.run(
          groupId, application.company, companyKey, normalizedUrl, application.check_url,
          application.resolved_url, application.site, application.schedule_mode, application.cron_expression,
          application.next_run_at, application.created_at, migratedAt,
        );
        group = findGroup.get(companyKey, normalizedUrl) as CheckGroupsTable;
      } else if (group.schedule_mode !== application.schedule_mode
        || group.cron_expression !== application.cron_expression) {
        makeManual.run(migratedAt, group.id);
        group = { ...group, schedule_mode: "manual", cron_expression: null, next_run_at: null };
      }
      setGroup.run(group.id, application.id);
    }
    raw.exec(`
      UPDATE runs SET check_group_id = (
        SELECT check_group_id FROM applications WHERE applications.id = runs.application_id
      ) WHERE check_group_id IS NULL;
    `);
    const runRows = raw.prepare(`
      SELECT runs.id AS run_id, runs.application_id, applications.job_title,
        runs.ai_suggested_status_v2, runs.ai_confidence, runs.ai_evidence, runs.ai_status, runs.created_at
      FROM runs JOIN applications ON applications.id = runs.application_id
    `).all() as Array<{
      run_id: string; application_id: string; job_title: string; ai_suggested_status_v2: ProgressStatus | null;
      ai_confidence: number | null; ai_evidence: string | null; ai_status: string; created_at: string;
    }>;
    const insertResult = raw.prepare(`
      INSERT OR IGNORE INTO run_application_results(
        id,run_id,application_id,job_title_snapshot,matched,raw_status,suggested_status,
        confidence,evidence,applied,not_applied_reason,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const run of runRows) {
      insertResult.run(
        randomUUID(), run.run_id, run.application_id, run.job_title,
        run.ai_suggested_status_v2 ? 1 : 0, null, run.ai_suggested_status_v2,
        run.ai_confidence, run.ai_evidence, run.ai_suggested_status_v2 ? 1 : 0,
        run.ai_status === "failed" ? "ai_failed" : run.ai_suggested_status_v2 ? null : "unmatched",
        run.created_at,
      );
    }
  })();
  raw.exec(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY check_group_id ORDER BY created_at) AS position
      FROM runs
      WHERE check_group_id IS NOT NULL AND status IN ('queued','running','needs_login')
    )
    UPDATE runs SET status = 'cancelled', completed_at = COALESCE(completed_at, '${migratedAt}'),
      error_code = 'MIGRATION_DEDUP', error_message = '升级为共享检查组时合并了重复任务'
    WHERE id IN (SELECT id FROM ranked WHERE position > 1);
    CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_group
      ON runs(check_group_id) WHERE check_group_id IS NOT NULL AND status IN ('queued','running','needs_login');
  `);
  raw.prepare(`
    INSERT OR IGNORE INTO app_settings(
      id,global_cron,timezone,screenshot_retention_days,default_user_agent,
      ai_base_url,ai_model,ai_api_key_encrypted,ai_confidence_threshold,updated_at
    ) VALUES(1,NULL,'Asia/Shanghai',30,?,NULL,NULL,NULL,0.75,?)
  `).run(DEFAULT_USER_AGENT, new Date().toISOString());
  return { db: new Kysely<Database>({ dialect: new SqliteDialect({ database: raw }) }), raw };
}
