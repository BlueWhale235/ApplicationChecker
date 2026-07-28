import type {
  LocalDomNode,
  LocalPageSnapshot,
  LocalRecognitionResult,
  LocalRecognitionResultItem,
  ParserRouteRule,
  StatusMappings,
} from "@application-checker/contracts";
import {
  createStatusMappingRules,
  normalizeStatusMappingText,
  type StatusMappingRule,
} from "@application-checker/status-mapping";

export const LOCAL_PARSER_VERSION = "1.0.0";
export const LOCAL_AUTO_APPLY_THRESHOLD = 0.9;

export interface LocalRecognitionCandidate {
  id: string;
  jobTitle: string;
  location?: string | null;
}

export interface ParserAdapter {
  id: string;
  version: string;
  priority: number;
  routes: Array<{ hostname: string; pathname: string }>;
  domFeatures?: string[];
  containerHints: string[];
}

const adapters: ParserAdapter[] = [
  {
    id: "zhiye",
    version: LOCAL_PARSER_VERSION,
    priority: 100,
    routes: [
      { hostname: "zhiye.com", pathname: "/*" },
      { hostname: "*.zhiye.com", pathname: "/*" },
    ],
    domFeatures: ["zhiye", "beisen", "北森"],
    containerHints: ["resume", "application", "delivery", "process", "progress"],
  },
  {
    id: "feishu",
    version: LOCAL_PARSER_VERSION,
    priority: 100,
    routes: [
      { hostname: "feishu.cn", pathname: "/*" },
      { hostname: "*.feishu.cn", pathname: "/*" },
    ],
    domFeatures: ["feishu", "atsx", "飞书招聘"],
    containerHints: ["application", "delivery", "process", "progress"],
  },
  {
    id: "mokahr",
    version: LOCAL_PARSER_VERSION,
    priority: 100,
    routes: [
      { hostname: "mokahr.com", pathname: "/*" },
      { hostname: "*.mokahr.com", pathname: "/*" },
    ],
    domFeatures: ["mokahr", "moka", "Moka"],
    containerHints: ["application", "delivery", "process", "progress", "resume"],
  },
  {
    id: "generic",
    version: LOCAL_PARSER_VERSION,
    priority: 0,
    routes: [],
    containerHints: ["application", "job", "position", "resume", "process", "progress"],
  },
];

export const STATUS_RULES = createStatusMappingRules();

export function normalizeRecognitionText(value: string): string {
  return normalizeStatusMappingText(value);
}

function urlPatternMatches(rule: { hostname: string; pathname: string }, url: URL): boolean {
  const Pattern = (globalThis as unknown as {
    URLPattern?: new (input: { hostname: string; pathname: string }) => { test(input: URL | string): boolean };
  }).URLPattern;
  if (!Pattern) throw new Error("URLPattern requires Node.js 24 or newer");
  return new Pattern({ hostname: rule.hostname, pathname: rule.pathname }).test(url);
}

export function validateParserAdapters(items: ParserAdapter[] = adapters): void {
  const seen = new Map<string, string>();
  for (const adapter of items) {
    for (const route of adapter.routes) {
      const key = `${adapter.priority}\0${route.hostname.toLowerCase()}\0${route.pathname}`;
      const previous = seen.get(key);
      if (previous && previous !== adapter.id) {
        throw new Error(`Conflicting parser routes at priority ${adapter.priority}: ${previous} and ${adapter.id}`);
      }
      seen.set(key, adapter.id);
    }
  }
}

export function resolveParserAdapter(snapshot: LocalPageSnapshot): {
  adapter: ParserAdapter;
  route: ParserRouteRule | null;
  matchedBy: "path" | "dom" | "generic";
} {
  validateParserAdapters();
  const url = new URL(snapshot.url);
  const ordered = [...adapters].sort((a, b) => b.priority - a.priority);
  for (const adapter of ordered) {
    for (const candidate of adapter.routes) {
      if (urlPatternMatches(candidate, url)) {
        return {
          adapter,
          matchedBy: "path",
          route: {
            adapterId: adapter.id,
            version: adapter.version,
            priority: adapter.priority,
            hostname: candidate.hostname,
            pathname: candidate.pathname,
          },
        };
      }
    }
  }
  const fingerprint = normalizeRecognitionText([
    snapshot.title,
    ...snapshot.nodes.slice(0, 500).flatMap((node) => [node.classes.join(" "), node.dataStatus ?? ""]),
  ].join(" "));
  for (const adapter of ordered) {
    if (adapter.id !== "generic" && adapter.domFeatures?.some((feature) => fingerprint.includes(normalizeRecognitionText(feature)))) {
      return { adapter, route: null, matchedBy: "dom" };
    }
  }
  return { adapter: adapters.find((adapter) => adapter.id === "generic")!, route: null, matchedBy: "generic" };
}

function classifySnapshot(snapshot: LocalPageSnapshot, candidates: LocalRecognitionCandidate[]) {
  const text = snapshot.visibleText.trim();
  const normalized = normalizeRecognitionText(`${snapshot.title} ${text}`);
  if (text.length < 8) return { type: "blank" as const, evidence: "页面没有足够的可见文本" };
  const hasCandidate = candidates.some((candidate) => normalized.includes(normalizeRecognitionText(candidate.jobTitle)));
  if (!hasCandidate && /(请登录|立即登录|账号登录|密码登录|扫码登录|验证码登录|sign\s?in|log\s?in)/i.test(`${snapshot.title} ${text.slice(0, 3000)}`)) {
    return { type: "login" as const, evidence: "页面包含登录或验证码提示" };
  }
  const path = new URL(snapshot.url).pathname.replace(/\/+$/, "") || "/";
  if (!hasCandidate && path === "/" && /(公司官网|企业官网|官方网站|关于我们)/.test(text.slice(0, 5000))) {
    return { type: "official_homepage" as const, evidence: "根页面仅显示官网导航，未发现目标岗位" };
  }
  return { type: "status" as const, evidence: null };
}

function ancestorIds(node: LocalDomNode, byId: Map<number, LocalDomNode>): Set<number> {
  const ids = new Set<number>([node.id]);
  let current = node;
  for (let depth = 0; depth < 5 && current.parentId !== null; depth += 1) {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    ids.add(parent.id);
    current = parent;
  }
  return ids;
}

function contextForTitle(
  titleNode: LocalDomNode,
  snapshot: LocalPageSnapshot,
  adapter: ParserAdapter,
  statusRules: StatusMappingRule[],
): LocalDomNode[] {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const ancestors = ancestorIds(titleNode, byId);
  const hintedAncestors = [...ancestors].filter((id) => {
    const node = byId.get(id);
    if (!node) return false;
    const marker = normalizeRecognitionText(`${node.classes.join(" ")} ${node.role ?? ""}`);
    return adapter.containerHints.some((hint) => marker.includes(normalizeRecognitionText(hint)));
  });
  const rootId = hintedAncestors[0];
  const descendants = new Set<number>();
  if (rootId !== undefined) {
    descendants.add(rootId);
    let changed = true;
    while (changed && descendants.size < 400) {
      changed = false;
      for (const node of snapshot.nodes) {
        if (node.parentId !== null && descendants.has(node.parentId) && !descendants.has(node.id)) {
          descendants.add(node.id);
          changed = true;
        }
      }
    }
  }
  const sameContainer = snapshot.nodes.filter((node) => descendants.has(node.id));
  if (sameContainer.length > 1 && sameContainer.length < 400 && statusMatches(sameContainer, statusRules).length) return sameContainer;
  return snapshot.nodes.filter((node) =>
    node.y >= titleNode.y - 30
    && node.y <= titleNode.y + Math.max(260, titleNode.height * 8)
    && node.x < titleNode.x + Math.max(900, titleNode.width * 5)
    && node.x + node.width > titleNode.x - 100);
}

function statusMatches(
  nodes: LocalDomNode[],
  statusRules: StatusMappingRule[],
): Array<{ rule: StatusMappingRule; term: string; node: LocalDomNode; active: boolean }> {
  const matches: Array<{ rule: StatusMappingRule; term: string; node: LocalDomNode; active: boolean }> = [];
  for (const node of nodes) {
    const text = normalizeRecognitionText(node.text);
    if (!text) continue;
    const marker = normalizeRecognitionText(`${node.classes.join(" ")} ${node.dataStatus ?? ""} ${node.role ?? ""}`);
    const active = /(active|current|selected|processing|success|finished|done|进行中|当前)/i.test(marker);
    for (const rule of statusRules) {
      const term = rule.terms.find((candidate) => text.includes(normalizeRecognitionText(candidate)));
      if (term) matches.push({ rule, term, node, active });
    }
  }
  return matches;
}

function parseCandidate(
  snapshot: LocalPageSnapshot,
  adapter: ParserAdapter,
  candidate: LocalRecognitionCandidate,
  statusRules: StatusMappingRule[],
): LocalRecognitionResultItem {
  const target = normalizeRecognitionText(candidate.jobTitle);
  const rawTitleNodes = snapshot.nodes
    .map((node) => ({ node, normalized: normalizeRecognitionText(node.text) }))
    .filter(({ normalized }) => normalized === target || (normalized.length <= Math.max(target.length * 2.5, target.length + 16) && normalized.includes(target)))
    .sort((left, right) => left.normalized.length - right.normalized.length);
  const titleNodes = rawTitleNodes.filter((candidateNode, index, all) => !all.slice(0, index).some((existing) =>
    existing.normalized === candidateNode.normalized
    && Math.abs(existing.node.y - candidateNode.node.y) <= 5
    && Math.abs(existing.node.x - candidateNode.node.x) <= 12));
  const exact = titleNodes.filter(({ normalized }) => normalized === target);
  const topZhiyeExact = adapter.id === "zhiye" && exact.length > 1
    ? [...exact].sort((left, right) => left.node.y - right.node.y)[0]
    : null;
  const chosen = exact.length === 1 ? exact[0]
    : topZhiyeExact
      ? topZhiyeExact
      : exact.length === 0 && titleNodes.length === 1 ? titleNodes[0] : null;
  const selectedLatestZhiyeDuplicate = Boolean(topZhiyeExact);
  const titleMatch = exact.length === 1 || selectedLatestZhiyeDuplicate ? "exact" : chosen ? "contains" : "none";
  if (!chosen) {
    return {
      applicationId: candidate.id, matched: false, rawStatus: null, status: null, confidence: 0,
      evidence: titleNodes.length > 1 ? "页面中存在多个同名或包含该标题的岗位，无法唯一定位" : "未在页面中找到岗位标题",
      titleMatch, statusRule: null,
    };
  }
  let matches = statusMatches(contextForTitle(chosen.node, snapshot, adapter, statusRules), statusRules);
  const active = matches.filter((match) => match.active);
  if (active.length) {
    matches = active;
  } else if (matches.length) {
    const nearest = Math.min(...matches.map((match) => Math.abs(match.node.y - chosen.node.y)));
    matches = matches.filter((match) => Math.abs(match.node.y - chosen.node.y) <= nearest + 48);
  }
  const statuses = [...new Set(matches.map((match) => match.rule.status))];
  const contradictoryTerminals = statuses.filter((status) => status === "rejected" || status === "offer");
  if (!statuses.length || contradictoryTerminals.length > 1) {
    return {
      applicationId: candidate.id, matched: false, rawStatus: null, status: null,
      confidence: contradictoryTerminals.length > 1 ? 0.45 : 0,
      evidence: contradictoryTerminals.length > 1 ? `岗位附近出现相互冲突的终态：${contradictoryTerminals.join("、")}` : "岗位附近未找到可信状态文本",
      titleMatch, statusRule: null,
    };
  }
  const selected = matches.sort((left, right) => statusRules.indexOf(left.rule) - statusRules.indexOf(right.rule))[0]!;
  const confidence = selectedLatestZhiyeDuplicate ? 0.92
    : titleMatch === "exact" ? (selected.active ? 0.99 : 0.96) : (selected.active ? 0.94 : 0.91);
  return {
    applicationId: candidate.id,
    matched: true,
    rawStatus: selected.term,
    status: selected.rule.status,
    confidence,
    evidence: `${selectedLatestZhiyeDuplicate ? "智业同名历史记录中选择页面最上方的最新记录" : titleMatch === "exact" ? "完全" : "唯一包含"}匹配岗位“${candidate.jobTitle}”，附近状态文本为“${selected.term}”`,
    titleMatch,
    statusRule: selected.rule.id,
  };
}

export function recognizeLocalPage(
  snapshot: LocalPageSnapshot,
  candidates: LocalRecognitionCandidate[],
  customStatusMappings?: StatusMappings | null,
): LocalRecognitionResult {
  const resolved = resolveParserAdapter(snapshot);
  const classification = classifySnapshot(snapshot, candidates);
  const statusRules = createStatusMappingRules(customStatusMappings);
  if (classification.type !== "status") {
    return {
      adapterId: resolved.adapter.id,
      adapterVersion: resolved.adapter.version,
      route: resolved.route,
      pageType: classification.type,
      pageEvidence: classification.evidence,
      results: candidates.map((candidate) => ({
        applicationId: candidate.id,
        matched: true,
        rawStatus: classification.type,
        status: "unset",
        confidence: 0.99,
        evidence: classification.evidence,
        titleMatch: "none",
        statusRule: classification.type,
      })),
      fallbackReason: null,
    };
  }
  const results = candidates.map((candidate) => parseCandidate(snapshot, resolved.adapter, candidate, statusRules));
  return {
    adapterId: resolved.adapter.id,
    adapterVersion: resolved.adapter.version,
    route: resolved.route,
    pageType: "status",
    pageEvidence: null,
    results,
    fallbackReason: results.every((result) => !result.matched)
      ? `适配器 ${resolved.adapter.id} 未可靠匹配任何岗位`
      : results.some((result) => !result.matched) ? "部分岗位需要 AI 回退" : null,
  };
}

export const parserAdapters = adapters;
