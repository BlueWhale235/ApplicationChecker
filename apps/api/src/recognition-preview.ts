import { randomUUID } from "node:crypto";
import type {
  LocalPageSnapshot,
  AssistedParserRule,
  RecognitionPreviewDetail,
  RecognitionPreviewSnapshot,
  RecognitionPreviewSummary,
  RunnerRecognitionPreviewJob,
  RunnerRecognitionPreviewReleaseJob,
  ScriptRuleExecution,
  StatusMappings,
} from "@application-checker/contracts";
import { recognizeLocalPage, recognizeScriptExecution } from "@application-checker/local-status";

interface PreviewRecord extends RecognitionPreviewDetail {
  job: RunnerRecognitionPreviewJob;
  screenshotBase64: string | null;
  snapshot: LocalPageSnapshot | null;
}

function publicDetail(record: PreviewRecord): RecognitionPreviewDetail {
  const { job: _job, screenshotBase64: _screenshot, snapshot: _snapshot, ...detail } = record;
  return detail;
}

function summary(record: PreviewRecord): RecognitionPreviewSummary {
  const detail = publicDetail(record);
  return {
    id: detail.id,
    applicationId: detail.applicationId,
    company: detail.company,
    site: detail.site,
    status: detail.status,
    createdAt: detail.createdAt,
    completedAt: detail.completedAt,
    adapterId: detail.adapterId,
    matchedCount: detail.matchedCount,
    applicationCount: detail.applicationCount,
    error: detail.error,
  };
}

export class RecognitionPreviewStore {
  private readonly records: PreviewRecord[] = [];
  private readonly pendingReleases = new Set<string>();

  constructor(private readonly capacity = 20) {}

  enqueue(input: Omit<RunnerRecognitionPreviewJob, "kind" | "previewId">): RecognitionPreviewDetail {
    const id = randomUUID();
    const record: PreviewRecord = {
      id,
      applicationId: input.applicationId,
      company: input.company,
      site: input.site,
      status: "queued",
      createdAt: new Date().toISOString(),
      completedAt: null,
      adapterId: null,
      matchedCount: 0,
      applicationCount: input.applications.length,
      error: null,
      finalUrl: null,
      pageTitle: null,
      route: null,
      adapterVersion: null,
      pageType: null,
      pageEvidence: null,
      snapshotSummary: null,
      results: [],
      screenshotAvailable: false,
      screenshotWidth: null,
      screenshotHeight: null,
      screenshotTruncated: false,
      scriptDurationMs: null,
      scriptRuleId: input.scriptRule?.id ?? null,
      scriptLogs: [],
      scriptLogsTruncated: false,
      screenshotBase64: null,
      snapshot: null,
      job: { ...input, kind: "recognition_preview", previewId: id },
    };
    this.records.unshift(record);
    if (this.records.length > this.capacity) this.records.length = this.capacity;
    return publicDetail(record);
  }

  enqueueScriptTest(sourceId: string, rule: AssistedParserRule): RecognitionPreviewDetail | null {
    const source = this.records.find((item) => item.id === sourceId);
    if (!source) return null;
    const {
      kind: _kind,
      previewId: _previewId,
      purpose: _purpose,
      sourcePreviewId: _sourcePreviewId,
      keepAlive: _keepAlive,
      scriptRule: _previousRule,
      ...input
    } = source.job;
    const detail = this.enqueue({
      ...input,
      purpose: "script_test",
      sourcePreviewId: source.job.sourcePreviewId ?? source.id,
      keepAlive: true,
      scriptRule: { ...rule, enabled: true },
    });
    const record = this.records.find((item) => item.id === detail.id);
    if (record) {
      record.screenshotBase64 = source.screenshotBase64;
      record.snapshot = source.snapshot;
      record.screenshotAvailable = source.screenshotAvailable;
      record.screenshotWidth = source.screenshotWidth;
      record.screenshotHeight = source.screenshotHeight;
      record.screenshotTruncated = source.screenshotTruncated;
      record.snapshotSummary = source.snapshotSummary;
    }
    return detail;
  }

  requestRelease(previewId: string): void {
    this.pendingReleases.add(previewId);
  }

  claim(): RunnerRecognitionPreviewJob | RunnerRecognitionPreviewReleaseJob | null {
    const releaseId = this.pendingReleases.values().next().value as string | undefined;
    if (releaseId) {
      this.pendingReleases.delete(releaseId);
      return { kind: "recognition_preview_release", previewId: releaseId };
    }
    const record = [...this.records].reverse().find((item) => item.status === "queued");
    if (!record) return null;
    record.status = "running";
    return record.job;
  }

  complete(id: string, input: {
    snapshot: LocalPageSnapshot;
    screenshotBase64: string;
    needsLogin: boolean;
    loginReason: string | null;
    screenshotWidth?: number;
    screenshotHeight?: number;
    screenshotTruncated?: boolean;
    scriptExecution?: ScriptRuleExecution | null;
  }, statusMappings?: StatusMappings, assistedRules: AssistedParserRule[] = []): RecognitionPreviewDetail | null {
    const record = this.records.find((item) => item.id === id);
    if (!record || record.status !== "running") return null;
    record.completedAt = new Date().toISOString();
    record.finalUrl = input.snapshot.url;
    record.pageTitle = input.snapshot.title;
    record.screenshotBase64 = input.screenshotBase64;
    record.snapshot = input.snapshot;
    record.screenshotAvailable = Boolean(input.screenshotBase64);
    record.screenshotWidth = input.screenshotWidth ?? 1440;
    record.screenshotHeight = input.screenshotHeight ?? 900;
    record.screenshotTruncated = Boolean(input.screenshotTruncated);
    record.snapshotSummary = {
      nodeCount: input.snapshot.nodes.length,
      textCharacters: input.snapshot.visibleText.length,
      truncated: input.snapshot.truncated,
      nodeLimitReached: input.snapshot.nodeLimitReached,
      textLimitReached: input.snapshot.textLimitReached,
    };
    if (input.needsLogin) {
      record.status = "needs_login";
      record.error = input.loginReason;
      return publicDetail(record);
    }
    const result = input.scriptExecution
      ? recognizeScriptExecution(input.scriptExecution, record.job.applications, statusMappings)
      : recognizeLocalPage(input.snapshot, record.job.applications, statusMappings, assistedRules);
    record.status = "succeeded";
    record.adapterId = result.adapterId;
    record.adapterVersion = result.adapterVersion;
    record.route = result.route;
    record.pageType = result.pageType;
    record.pageEvidence = result.pageEvidence;
    record.results = result.results;
    record.matchedCount = result.results.filter((item) => item.matched && item.confidence >= 0.9).length;
    record.scriptDurationMs = input.scriptExecution?.durationMs ?? null;
    record.scriptRuleId = input.scriptExecution?.ruleId ?? null;
    record.scriptLogs = input.scriptExecution?.logs ?? [];
    record.scriptLogsTruncated = input.scriptExecution?.logsTruncated ?? false;
    return publicDetail(record);
  }

  completeScriptTest(id: string, input: {
    finalUrl: string;
    pageTitle: string;
    needsLogin: boolean;
    loginReason: string | null;
    scriptExecution: ScriptRuleExecution | null;
  }, statusMappings?: StatusMappings): RecognitionPreviewDetail | null {
    const record = this.records.find((item) => item.id === id);
    if (!record || record.status !== "running" || record.job.purpose !== "script_test") return null;
    record.completedAt = new Date().toISOString();
    record.finalUrl = input.finalUrl;
    record.pageTitle = input.pageTitle;
    record.scriptDurationMs = input.scriptExecution?.durationMs ?? null;
    record.scriptRuleId = input.scriptExecution?.ruleId ?? record.scriptRuleId;
    record.scriptLogs = input.scriptExecution?.logs ?? [];
    record.scriptLogsTruncated = input.scriptExecution?.logsTruncated ?? false;
    if (input.needsLogin) {
      record.status = "needs_login";
      record.error = input.loginReason;
      return publicDetail(record);
    }
    if (!input.scriptExecution) return null;
    const result = recognizeScriptExecution(input.scriptExecution, record.job.applications, statusMappings);
    record.status = "succeeded";
    record.adapterId = result.adapterId;
    record.adapterVersion = result.adapterVersion;
    record.route = result.route;
    record.pageType = result.pageType;
    record.pageEvidence = result.pageEvidence;
    record.results = result.results;
    record.matchedCount = result.results.filter((item) => item.matched && item.confidence >= 0.9).length;
    return publicDetail(record);
  }

  fail(id: string, error: string, script?: {
    durationMs?: number | null;
    ruleId?: string | null;
    logs?: RecognitionPreviewDetail["scriptLogs"];
    logsTruncated?: boolean;
  }): void {
    const record = this.records.find((item) => item.id === id);
    if (!record || !["queued", "running"].includes(record.status)) return;
    record.status = "failed";
    record.error = error.slice(0, 1_000);
    record.completedAt = new Date().toISOString();
    record.scriptDurationMs = script?.durationMs ?? record.scriptDurationMs;
    record.scriptRuleId = script?.ruleId ?? record.scriptRuleId;
    record.scriptLogs = script?.logs ?? record.scriptLogs;
    record.scriptLogsTruncated = script?.logsTruncated ?? record.scriptLogsTruncated;
  }

  list(): RecognitionPreviewSummary[] {
    return this.records.map(summary);
  }

  get(id: string): RecognitionPreviewDetail | null {
    const record = this.records.find((item) => item.id === id);
    return record ? publicDetail(record) : null;
  }

  screenshot(id: string): Buffer | null {
    const encoded = this.records.find((item) => item.id === id)?.screenshotBase64;
    return encoded ? Buffer.from(encoded, "base64") : null;
  }

  snapshot(id: string): RecognitionPreviewSnapshot | null {
    const record = this.records.find((item) => item.id === id);
    if (!record?.snapshot || !record.screenshotWidth || !record.screenshotHeight) return null;
    return {
      snapshot: record.snapshot,
      applications: record.job.applications,
      screenshotWidth: record.screenshotWidth,
      screenshotHeight: record.screenshotHeight,
      screenshotTruncated: record.screenshotTruncated,
    };
  }
}
