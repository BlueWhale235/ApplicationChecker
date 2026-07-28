import { randomUUID } from "node:crypto";
import type {
  LocalPageSnapshot,
  AssistedParserRule,
  RecognitionPreviewDetail,
  RecognitionPreviewSnapshot,
  RecognitionPreviewSummary,
  RunnerRecognitionPreviewJob,
  StatusMappings,
} from "@application-checker/contracts";
import { recognizeLocalPage } from "@application-checker/local-status";

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
      screenshotBase64: null,
      snapshot: null,
      job: { ...input, kind: "recognition_preview", previewId: id },
    };
    this.records.unshift(record);
    if (this.records.length > this.capacity) this.records.length = this.capacity;
    return publicDetail(record);
  }

  claim(): RunnerRecognitionPreviewJob | null {
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
    const result = recognizeLocalPage(input.snapshot, record.job.applications, statusMappings, assistedRules);
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

  fail(id: string, error: string): void {
    const record = this.records.find((item) => item.id === id);
    if (!record || !["queued", "running"].includes(record.status)) return;
    record.status = "failed";
    record.error = error.slice(0, 1_000);
    record.completedAt = new Date().toISOString();
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
