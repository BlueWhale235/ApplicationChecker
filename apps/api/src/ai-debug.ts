import { randomUUID } from "node:crypto";
import type {
  AiDebugCompletion, AiDebugObserver, AiDebugStart, AiDebugAttempt as ObserverAttempt,
} from "@application-checker/ai-status";
import type {
  AiDebugTraceAttempt, AiDebugTraceDetail, AiDebugTraceSummary, LocalPageSnapshot, LocalRecognitionResult,
} from "@application-checker/contracts";

const MAX_RESPONSE_LENGTH = 100 * 1024;

function elapsed(start: string, end: string | null): number | null {
  if (!end) return null;
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

function summary(trace: AiDebugTraceDetail): AiDebugTraceSummary {
  return {
    id: trace.id,
    runId: trace.runId,
    createdAt: trace.createdAt,
    completedAt: trace.completedAt,
    company: trace.company,
    applicationCount: trace.applicationCount,
    model: trace.model,
    status: trace.status,
    durationMs: elapsed(trace.createdAt, trace.completedAt),
      httpStatus: trace.attempts.at(-1)?.httpStatus ?? null,
      ...(trace.recognitionSource ? { recognitionSource: trace.recognitionSource } : {}),
      ...(trace.adapterId !== undefined ? { adapterId: trace.adapterId } : {}),
  };
}

function sanitizedRequest(input: AiDebugStart): string {
  return JSON.stringify({
    model: input.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: input.systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: input.userPrompt },
          { type: "image_url", image_url: { url: `[image omitted: ${input.screenshotBytes} bytes]` } },
        ],
      },
    ],
  }, null, 2);
}

export class AiDebugStore implements AiDebugObserver {
  private readonly traces: AiDebugTraceDetail[] = [];

  constructor(private readonly capacity = 50) {}

  start(input: AiDebugStart): string {
    const id = randomUUID();
    this.traces.unshift({
      id,
      runId: input.runId,
      createdAt: new Date().toISOString(),
      completedAt: null,
      company: input.company,
      applicationCount: input.applications.length,
      model: input.model,
      status: "pending",
      durationMs: null,
      httpStatus: null,
      endpoint: input.endpoint,
      pageTitle: input.pageTitle,
      finalUrl: input.finalUrl,
      applications: input.applications.map((item) => ({ ...item })),
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      sanitizedRequest: sanitizedRequest(input),
      screenshotBytes: input.screenshotBytes,
      screenshotTruncated: input.screenshotTruncated,
      attempts: [],
      parsed: null,
      error: null,
      recognitionSource: "ai",
      adapterId: null,
      adapterVersion: null,
      route: null,
      localSnapshotSummary: null,
    });
    if (this.traces.length > this.capacity) this.traces.length = this.capacity;
    return id;
  }

  recordLocal(input: {
    runId: string;
    company: string;
    applications: Array<{ id: string; jobTitle: string; appliedAt: string | null; location: string | null }>;
    snapshot: LocalPageSnapshot;
    result: LocalRecognitionResult;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const snapshotSummary = {
      nodeCount: input.snapshot.nodes.length,
      textCharacters: input.snapshot.visibleText.length,
      truncated: input.snapshot.truncated,
      nodeLimitReached: input.snapshot.nodeLimitReached,
      textLimitReached: input.snapshot.textLimitReached,
    };
    const sanitized = {
      finalUrl: input.snapshot.url,
      pageTitle: input.snapshot.title,
      applications: input.applications,
      snapshot: snapshotSummary,
      route: input.result.route,
    };
    this.traces.unshift({
      id,
      runId: input.runId,
      createdAt: now,
      completedAt: now,
      company: input.company,
      applicationCount: input.applications.length,
      model: `local:${input.result.adapterId}`,
      status: "succeeded",
      durationMs: 0,
      httpStatus: null,
      endpoint: "local://recognition",
      pageTitle: input.snapshot.title,
      finalUrl: input.snapshot.url,
      applications: input.applications.map((item) => ({ ...item })),
      systemPrompt: "本地 DOM 状态解析器（不调用 AI）",
      userPrompt: JSON.stringify(sanitized, null, 2),
      sanitizedRequest: JSON.stringify(sanitized, null, 2),
      screenshotBytes: 0,
      screenshotTruncated: false,
      attempts: [],
      parsed: {
        pageType: input.result.pageType,
        pageEvidence: input.result.pageEvidence,
        results: input.result.results.map((item) => ({
          applicationId: item.applicationId,
          matched: item.matched,
          rawStatus: item.rawStatus,
          status: item.status,
          confidence: item.confidence,
          evidence: `${item.evidence}${item.statusRule ? `（规则：${item.statusRule}）` : ""}`,
        })),
      },
      error: null,
      recognitionSource: "local",
      adapterId: input.result.adapterId,
      adapterVersion: input.result.adapterVersion,
      route: input.result.route,
      localSnapshotSummary: snapshotSummary,
    });
    if (this.traces.length > this.capacity) this.traces.length = this.capacity;
    return id;
  }

  attempt(traceId: string, attempt: ObserverAttempt): void {
    const trace = this.traces.find((item) => item.id === traceId);
    if (!trace) return;
    const raw = attempt.responseBody;
    const mapped: AiDebugTraceAttempt = {
      deepThinking: attempt.deepThinking,
      startedAt: attempt.startedAt,
      durationMs: attempt.durationMs,
      httpStatus: attempt.httpStatus,
      responseBody: raw === null ? null : raw.slice(0, MAX_RESPONSE_LENGTH),
      responseTruncated: Boolean(raw && raw.length > MAX_RESPONSE_LENGTH),
      error: attempt.error,
    };
    trace.attempts.push(mapped);
    trace.httpStatus = mapped.httpStatus;
  }

  complete(traceId: string, result: AiDebugCompletion): void {
    const trace = this.traces.find((item) => item.id === traceId);
    if (!trace) return;
    trace.status = "succeeded";
    trace.completedAt = new Date().toISOString();
    trace.durationMs = elapsed(trace.createdAt, trace.completedAt);
    trace.parsed = {
      pageType: result.pageType,
      pageEvidence: result.pageEvidence,
      results: result.results.map((item) => ({ ...item })),
    };
  }

  fail(traceId: string, error: string): void {
    const trace = this.traces.find((item) => item.id === traceId);
    if (!trace) return;
    trace.status = "failed";
    trace.completedAt = new Date().toISOString();
    trace.durationMs = elapsed(trace.createdAt, trace.completedAt);
    trace.error = error.slice(0, 2_000);
  }

  markMixed(runId: string, aiProvider: string | null): void {
    const trace = this.traces.find((item) => item.runId === runId && item.recognitionSource === "local");
    if (!trace) return;
    trace.recognitionSource = "mixed";
    trace.model = `${trace.model} + ai:${aiProvider ?? "unknown"}`;
  }

  list(limit = 50): AiDebugTraceSummary[] {
    return this.traces.slice(0, Math.min(this.capacity, Math.max(1, limit))).map(summary);
  }

  get(id: string): AiDebugTraceDetail | null {
    return this.traces.find((item) => item.id === id) ?? null;
  }

  clear(): number {
    const deleted = this.traces.length;
    this.traces.length = 0;
    return deleted;
  }

  removeRuns(runIds: Iterable<string>): number {
    const ids = new Set(runIds);
    const before = this.traces.length;
    for (let index = this.traces.length - 1; index >= 0; index -= 1) {
      if (this.traces[index]?.runId && ids.has(this.traces[index]!.runId!)) this.traces.splice(index, 1);
    }
    return before - this.traces.length;
  }
}
