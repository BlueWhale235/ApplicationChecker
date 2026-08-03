import {
  progressLabels,
  type ProgressStatus,
  type StatusMappings,
} from "@application-checker/contracts";
import {
  formatStatusMappingPrompt,
  matchStatusMapping,
  normalizeCustomStatusMappings,
} from "@application-checker/status-mapping";

export interface RecognitionInput {
  screenshot: Buffer;
  company: string;
  jobTitle: string;
  pageTitle: string | null;
  finalUrl: string | null;
}

export interface RecognitionResult {
  status: ProgressStatus | null;
  confidence: number;
  evidence: string;
  provider: string;
}

export interface RecognitionCandidate {
  id: string;
  jobTitle: string;
  appliedAt: string | null;
  location: string | null;
}

export interface GroupRecognitionInput {
  screenshot: Buffer;
  company: string;
  applications: RecognitionCandidate[];
  pageTitle: string | null;
  finalUrl: string | null;
  debugContext?: {
    runId: string;
    screenshotTruncated?: boolean;
  };
}

export interface GroupRecognitionResultItem {
  applicationId: string;
  matched: boolean;
  rawStatus: string | null;
  status: ProgressStatus | null;
  confidence: number;
  evidence: string;
}

export interface GroupRecognitionResult {
  results: GroupRecognitionResultItem[];
  provider: string;
}

export interface AiDebugStart {
  runId: string | null;
  endpoint: string;
  model: string;
  company: string;
  applications: RecognitionCandidate[];
  pageTitle: string | null;
  finalUrl: string | null;
  systemPrompt: string;
  userPrompt: string;
  screenshotBytes: number;
  screenshotTruncated: boolean;
}

export interface AiDebugAttempt {
  deepThinking: boolean;
  startedAt: string;
  durationMs: number;
  httpStatus: number | null;
  responseBody: string | null;
  error: string | null;
}

export interface AiDebugCompletion {
  pageType: string | null;
  pageEvidence: string | null;
  results: GroupRecognitionResultItem[];
}

export interface AiDebugObserver {
  start(input: AiDebugStart): string;
  attempt(traceId: string, attempt: AiDebugAttempt): void;
  complete(traceId: string, result: AiDebugCompletion): void;
  fail(traceId: string, error: string): void;
}

export interface StatusRecognizer {
  readonly configured: boolean;
  readonly model: string | null;
  recognize(input: RecognitionInput): Promise<RecognitionResult>;
  recognizeGroup?(input: GroupRecognitionInput): Promise<GroupRecognitionResult>;
}

const allowed = new Set<ProgressStatus>(Object.keys(progressLabels) as ProgressStatus[]);
const nonApplicationPageTypes = new Set(["official_homepage", "login", "blank"]);
const nonApplicationPageLabels: Record<string, string> = {
  official_homepage: "官网首页或非个人投递状态页",
  login: "需要登录或验证",
  blank: "空白页或无有效内容",
};
const deepThinkingUnsupported = new Set<string>();

function createSystemPrompt(statusMappings?: StatusMappings | null): string {
  return [
  "你是招聘网站投递状态识别器。请根据截图，为每个候选岗位识别当前投递状态。",
  "先判断整个页面类型：application_status=个人投递状态页；official_homepage=公司官网首页、招聘首页或职位列表且没有个人投递记录；login=登录、注册或验证页面；blank=空白、持续加载、错误页或没有有效内容；other=其他页面。",
  "页面类型规则优先级最高：若为 official_homepage、login 或 blank，所有候选岗位必须返回 matched=false、status=null，不能修改现有岗位状态，也不能因为缺少岗位状态而推测为淘汰或其他进度。",
  `状态映射：${formatStatusMappingPrompt(statusMappings)}。`,
  "只返回 JSON 对象，格式为：",
  '{"pageType":"application_status|official_homepage|login|blank|other","pageEvidence":"不超过20字的页面类型证据","results":[{"applicationId":"候选岗位UUID","matched":true,"rawStatus":"页面原文","status":"unset|screening|screening_passed|interview_pending|interviewed|signing_pending|offer|rejected|null","confidence":0到1,"evidence":"不超过20字的截图证据"}]}。',
  "必须为每个候选岗位返回一项；无法可靠区分或没有找到时 matched=false、status=null。",
  ].join("\n");
}

function jsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI response did not contain JSON");
  return JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
}

function safeObserve(work: (() => void) | undefined): void {
  try {
    work?.();
  } catch {
    // Debug instrumentation must never affect recognition.
  }
}

function redactDebugText(value: string, apiKey: string): string {
  let output = value
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[image data omitted]")
    .replace(/(authorization["']?\s*[:=]\s*["']?bearer\s+)[^"',\s}]+/gi, "$1[REDACTED]");
  if (apiKey) output = output.split(apiKey).join("[REDACTED]");
  return output;
}

export class OpenAiCompatibleRecognizer implements StatusRecognizer {
  readonly configured: boolean;
  readonly model: string | null;

  constructor(
    private readonly options: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      deepThinking?: boolean;
      debugObserver?: AiDebugObserver;
      statusMappings?: StatusMappings;
    },
  ) {
    this.configured = Boolean(options.baseUrl && options.apiKey && options.model);
    this.model = options.model ?? null;
  }

  async recognize(input: RecognitionInput): Promise<RecognitionResult> {
    const applicationId = "single";
    const grouped = await this.recognizeGroup({
      screenshot: input.screenshot,
      company: input.company,
      applications: [{ id: applicationId, jobTitle: input.jobTitle, appliedAt: null, location: null }],
      pageTitle: input.pageTitle,
      finalUrl: input.finalUrl,
    });
    const item = grouped.results.find((result) => result.applicationId === applicationId);
    return {
      status: item?.status ?? null,
      confidence: item?.confidence ?? 0,
      evidence: item?.evidence ?? "未匹配到岗位",
      provider: grouped.provider,
    };
  }

  async recognizeGroup(input: GroupRecognitionInput): Promise<GroupRecognitionResult> {
    if (!this.configured || !this.options.baseUrl || !this.options.apiKey || !this.options.model) {
      throw new Error("AI recognizer is not configured");
    }
    const endpoint = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const statusMappings = this.options.statusMappings
      ? normalizeCustomStatusMappings(this.options.statusMappings)
      : undefined;
    const systemPrompt = createSystemPrompt(statusMappings);
    const userPrompt = [
      `公司：${input.company}`,
      `页面标题：${input.pageTitle ?? "未知"}`,
      `最终地址：${input.finalUrl ?? "未知"}`,
      `候选岗位 JSON：${JSON.stringify(input.applications)}`,
      "请结合下面的页面截图进行识别。",
    ].join("\n");
    const imageDataUrl = `data:image/png;base64,${input.screenshot.toString("base64")}`;
    const requestBody = {
      model: this.options.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    };
    const observer = this.options.debugObserver;
    let traceId: string | null = null;
    if (observer) {
      try {
        traceId = observer.start({
          runId: input.debugContext?.runId ?? null,
          endpoint,
          model: this.options.model,
          company: input.company,
          applications: input.applications,
          pageTitle: input.pageTitle,
          finalUrl: input.finalUrl,
          systemPrompt,
          userPrompt,
          screenshotBytes: input.screenshot.byteLength,
          screenshotTruncated: Boolean(input.debugContext?.screenshotTruncated),
        });
      } catch {
        traceId = null;
      }
    }

    const send = async (deepThinking: boolean): Promise<{ response: Response; raw: string }> => {
      const startedAt = new Date().toISOString();
      const started = Date.now();
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...requestBody,
            ...(deepThinking ? { reasoning_effort: "high" } : { temperature: 0 }),
          }),
          signal: AbortSignal.timeout(deepThinking ? 180_000 : 90_000),
        });
        const raw = await response.text();
        if (traceId) safeObserve(() => observer?.attempt(traceId!, {
          deepThinking,
          startedAt,
          durationMs: Date.now() - started,
          httpStatus: response.status,
          responseBody: redactDebugText(raw, this.options.apiKey!),
          error: null,
        }));
        return { response, raw };
      } catch (error) {
        const message = error instanceof Error ? error.message : "AI request failed";
        if (traceId) safeObserve(() => observer?.attempt(traceId!, {
          deepThinking,
          startedAt,
          durationMs: Date.now() - started,
          httpStatus: null,
          responseBody: null,
          error: message,
        }));
        throw error;
      }
    };

    try {
      const supportKey = `${this.options.baseUrl}\n${this.options.model}`;
      const tryDeepThinking = Boolean(this.options.deepThinking && !deepThinkingUnsupported.has(supportKey));
      let attempt = await send(tryDeepThinking);
      if (tryDeepThinking && !attempt.response.ok && [400, 422].includes(attempt.response.status)) {
        const fallback = await send(false);
        if (fallback.response.ok) deepThinkingUnsupported.add(supportKey);
        attempt = fallback;
      }
      if (!attempt.response.ok) {
        const detail = attempt.raw.trim().slice(0, 500);
        throw new Error(`AI request failed with ${attempt.response.status}${detail ? `: ${detail}` : ""}`);
      }
      const body = JSON.parse(attempt.raw) as { choices?: Array<{ message?: { content?: string } }> };
      const value = jsonObject(body.choices?.[0]?.message?.content ?? "");
      const pageType = typeof value.pageType === "string" ? value.pageType : "";
      const pageEvidence = typeof value.pageEvidence === "string" ? value.pageEvidence.trim().slice(0, 500) : null;
      let results: GroupRecognitionResultItem[];
      if (nonApplicationPageTypes.has(pageType)) {
        const evidence = pageEvidence || nonApplicationPageLabels[pageType] || "非投递状态页";
        results = input.applications.map((application) => ({
          applicationId: application.id,
          matched: false,
          rawStatus: pageType === "login" ? "login_required" : nonApplicationPageLabels[pageType] ?? pageType,
          status: null,
          confidence: 1,
          evidence,
        }));
      } else {
        const rawResults = Array.isArray(value.results) ? value.results : [];
        results = rawResults.map((item): GroupRecognitionResultItem | null => {
          if (!item || typeof item !== "object") return null;
          const result = item as Record<string, unknown>;
          const applicationId = typeof result.applicationId === "string" ? result.applicationId : "";
          if (!applicationId) return null;
          const rawStatus = typeof result.rawStatus === "string" ? result.rawStatus.slice(0, 500) : null;
          const mappedStatus = rawStatus ? matchStatusMapping(rawStatus, statusMappings)?.rule.status ?? null : null;
          const returnedStatus = result.status;
          const status = mappedStatus ?? (
            typeof returnedStatus === "string" && allowed.has(returnedStatus as ProgressStatus)
              ? returnedStatus as ProgressStatus
              : null
          );
          return {
            applicationId,
            matched: result.matched === true,
            rawStatus,
            status,
            confidence: Math.min(1, Math.max(0, Number(result.confidence ?? 0))),
            evidence: String(result.evidence ?? "").trim().slice(0, 500),
          };
        }).filter((item): item is GroupRecognitionResultItem => Boolean(item));
      }
      if (traceId) safeObserve(() => observer?.complete(traceId!, {
        pageType: pageType || null,
        pageEvidence,
        results,
      }));
      return { results, provider: this.options.model };
    } catch (error) {
      const message = redactDebugText(error instanceof Error ? error.message : "AI recognition failed", this.options.apiKey);
      if (traceId) safeObserve(() => observer?.fail(traceId!, message));
      throw error;
    }
  }
}

export class DisabledRecognizer implements StatusRecognizer {
  readonly configured = false;
  readonly model = null;
  async recognize(): Promise<RecognitionResult> {
    throw new Error("AI recognizer is not configured");
  }
}
