import type {
  ProgressStatus,
  StatusMappingKey,
  StatusMappings,
} from "@application-checker/contracts";

export interface StatusMappingRule {
  id: StatusMappingKey;
  status: ProgressStatus;
  terms: string[];
}

export interface StatusMappingMatch {
  rule: StatusMappingRule;
  term: string;
}

export const STATUS_MAPPING_KEYS: StatusMappingKey[] = [
  "screening",
  "screening_passed",
  "interview_pending",
  "interviewed",
  "signing_pending",
  "offer",
  "rejected",
];

// Later/terminal stages are matched before earlier stages. This prevents text
// such as "screening passed" and "offer pending" from matching a shorter,
// earlier-stage term.
const MATCH_PRIORITY: StatusMappingKey[] = [
  "rejected",
  "offer",
  "signing_pending",
  "interviewed",
  "interview_pending",
  "screening_passed",
  "screening",
];

export const EMPTY_STATUS_MAPPINGS: StatusMappings = {
  screening: [],
  screening_passed: [],
  interview_pending: [],
  interviewed: [],
  signing_pending: [],
  offer: [],
  rejected: [],
};

export const BUILTIN_STATUS_MAPPINGS: StatusMappings = {
  screening: [
    "待处理",
    "简历筛选", "简历初筛", "简历投递", "待评估", "投递简历", "申请成功", "已投递", "初筛", "筛选阶段",
    "resume screening", "CV screening", "application submitted", "application received",
    "under review", "pending review", "awaiting review", "pending evaluation", "to be evaluated",
  ],
  screening_passed: [
    "业务筛选", "业务筛选-进行中", "筛选通过", "已过初筛", "初筛通过",
    "business screening", "screening passed", "resume screening passed", "shortlisted", "advanced to next round",
  ],
  interview_pending: [
    "待面试", "面试邀约", "已安排面试", "面试安排", "面试中", "进入面试",
    "interview pending", "interview invitation", "interview scheduled", "awaiting interview", "interview in progress",
  ],
  interviewed: [
    "到面", "已面试", "面试完成", "已参加面试", "面试结束", "面试结果待定",
    "interviewed", "interview completed", "interview finished", "awaiting interview result",
  ],
  signing_pending: [
    "待签约", "待入职", "OFFER沟通", "录用审批", "待录用",
    "pending signature", "awaiting signature", "offer pending", "offer approval", "pending onboarding",
  ],
  offer: [
    "已收OFFER", "OFFER已发放", "录用成功", "正式录用", "已录用", "录用", "OFFER",
    "offer received", "offer extended", "hired", "accepted", "selected",
  ],
  rejected: [
    "流程终止", "投递已撤销", "已淘汰", "淘汰", "不合适", "不匹配", "未通过",
    "rejected", "not selected", "not suitable", "unsuccessful", "application closed",
    "process terminated", "no longer under consideration", "not hired", "withdrawn",
  ],
};

export function normalizeStatusMappingText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function normalizeCustomStatusMappings(input: unknown): StatusMappings {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return Object.fromEntries(STATUS_MAPPING_KEYS.map((key) => {
    const raw = Array.isArray(source[key]) ? source[key] : [];
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const value of raw) {
      if (typeof value !== "string") continue;
      const term = value.trim().slice(0, 120);
      const normalized = normalizeStatusMappingText(term);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      terms.push(term);
      if (terms.length >= 100) break;
    }
    return [key, terms];
  })) as StatusMappings;
}

export function parseStatusMappings(value: string | null | undefined): StatusMappings {
  if (!value) return normalizeCustomStatusMappings(BUILTIN_STATUS_MAPPINGS);
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const hasConfiguredCategory = STATUS_MAPPING_KEYS.some((key) => Array.isArray(parsed?.[key]));
    return normalizeCustomStatusMappings(hasConfiguredCategory ? parsed : BUILTIN_STATUS_MAPPINGS);
  } catch {
    return normalizeCustomStatusMappings(BUILTIN_STATUS_MAPPINGS);
  }
}

export function createStatusMappingRules(configured?: StatusMappings | null): StatusMappingRule[] {
  const mappings = normalizeCustomStatusMappings(configured ?? BUILTIN_STATUS_MAPPINGS);
  return MATCH_PRIORITY.map((key) => {
    const seen = new Set<string>();
    const terms = mappings[key]
      .filter((term) => {
        const normalized = normalizeStatusMappingText(term);
        if (!normalized || seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      })
      .sort((left, right) => normalizeStatusMappingText(right).length - normalizeStatusMappingText(left).length);
    return { id: key, status: key, terms };
  });
}

export function assertUnambiguousStatusMappings(configured: StatusMappings): void {
  const owners = new Map<string, StatusMappingKey>();
  for (const rule of createStatusMappingRules(configured)) {
    for (const term of rule.terms) {
      const normalized = normalizeStatusMappingText(term);
      const owner = owners.get(normalized);
      if (owner && owner !== rule.id) {
        throw new Error(`状态词条“${term}”同时属于“${owner}”和“${rule.id}”`);
      }
      owners.set(normalized, rule.id);
    }
  }
}

export function matchStatusMapping(
  text: string,
  custom?: StatusMappings | null,
): StatusMappingMatch | null {
  const normalized = normalizeStatusMappingText(text);
  if (!normalized) return null;
  for (const rule of createStatusMappingRules(custom)) {
    const term = rule.terms.find((candidate) => normalized.includes(normalizeStatusMappingText(candidate)));
    if (term) return { rule, term };
  }
  return null;
}

export function formatStatusMappingPrompt(custom?: StatusMappings | null): string {
  return createStatusMappingRules(custom)
    .map((rule) => `${rule.terms.join("/")}=${rule.status}`)
    .join("；");
}
