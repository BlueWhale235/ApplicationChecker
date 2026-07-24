import { progressLabels, type ProgressStatus } from "@application-checker/contracts";

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

export interface StatusRecognizer {
  readonly configured: boolean;
  readonly model: string | null;
  recognize(input: RecognitionInput): Promise<RecognitionResult>;
  recognizeGroup?(input: GroupRecognitionInput): Promise<GroupRecognitionResult>;
}

const allowed = new Set<ProgressStatus>(Object.keys(progressLabels) as ProgressStatus[]);

function jsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI response did not contain JSON");
  return JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
}

export class OpenAiCompatibleRecognizer implements StatusRecognizer {
  readonly configured: boolean;
  readonly model: string | null;

  constructor(
    private readonly options: { baseUrl?: string; apiKey?: string; model?: string },
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
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `识别招聘官网截图中“${input.company}”以下岗位各自的投递状态。页面标题：${input.pageTitle ?? "未知"}。`,
                `候选岗位 JSON：${JSON.stringify(input.applications)}。`,
                "部分状态映射示例：简历筛选/简历初筛/简历投递=screening；业务筛选-进行中=screening_passed；待面试/面试邀约/已安排面试=interview_pending；到面/面试完成/已参加面试=interviewed；待签约=signing_pending；录用/OFFER=offer；不合适/不匹配/流程终止=rejected。",
                "只返回 JSON 对象，格式为：",
                '{"results":[{"applicationId":"候选岗位UUID","matched":true,"rawStatus":"页面原文","status":"unset|screening|screening_passed|interview_pending|interviewed|signing_pending|offer|rejected|null","confidence":0到1,"evidence":"不超过120字的截图证据"}]}。',
                "必须为每个候选岗位返回一项；无法可靠区分或没有找到时 matched=false、status=null。",
              ].join("\n"),
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${input.screenshot.toString("base64")}` },
            },
          ],
        }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`AI request failed with ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const value = jsonObject(body.choices?.[0]?.message?.content ?? "");
    const rawResults = Array.isArray(value.results) ? value.results : [];
    const results = rawResults.map((item): GroupRecognitionResultItem | null => {
      if (!item || typeof item !== "object") return null;
      const result = item as Record<string, unknown>;
      const applicationId = typeof result.applicationId === "string" ? result.applicationId : "";
      if (!applicationId) return null;
      const rawStatusValue = result.status;
      const status = typeof rawStatusValue === "string" && allowed.has(rawStatusValue as ProgressStatus)
        ? rawStatusValue as ProgressStatus
        : null;
      return {
        applicationId,
        matched: result.matched === true,
        rawStatus: typeof result.rawStatus === "string" ? result.rawStatus.slice(0, 500) : null,
        status,
        confidence: Math.min(1, Math.max(0, Number(result.confidence ?? 0))),
        evidence: String(result.evidence ?? "").trim().slice(0, 500),
      };
    }).filter((item): item is GroupRecognitionResultItem => Boolean(item));
    return { results, provider: this.options.model };
  }
}

export class DisabledRecognizer implements StatusRecognizer {
  readonly configured = false;
  readonly model = null;
  async recognize(): Promise<RecognitionResult> {
    throw new Error("AI recognizer is not configured");
  }
}
