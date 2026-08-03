import type {
  AssistedNodeLocator,
  AssistedParserRule,
  AssistedParserRuleDefinition,
  AssistedRuleSelection,
  AssistedRuleTestResult,
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
export const ASSISTED_RULE_SCHEMA_VERSION = 1;

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
    id: "beisen",
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
];

export const STATUS_RULES = createStatusMappingRules();

export function normalizeRecognitionText(value: string): string {
  return normalizeStatusMappingText(value);
}

function stableClasses(classes: string[]): string[] {
  return classes.filter((token) =>
    token.length <= 48
    && !/^\d+$/.test(token)
    && !/^[a-f\d]{8,}$/i.test(token)
    && !/(?:^|[-_])(?:css|sc|jsx|hash)[-_]?[a-z\d]{5,}$/i.test(token))
    .slice(0, 4);
}

function locatorFor(node: LocalDomNode, byId: Map<number, LocalDomNode>): AssistedNodeLocator {
  const ancestorTags: string[] = [];
  let current = node;
  for (let depth = 0; depth < 4 && current.parentId !== null; depth += 1) {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    ancestorTags.unshift(parent.tag);
    current = parent;
  }
  return {
    tag: node.tag || null,
    role: node.role,
    classes: stableClasses(node.classes),
    dataStatus: node.dataStatus,
    ariaCurrent: node.ariaCurrent && node.ariaCurrent !== "false" ? node.ariaCurrent : null,
    ariaSelected: node.ariaSelected && node.ariaSelected !== "false" ? node.ariaSelected : null,
    ancestorTags,
  };
}

function locatorMatches(node: LocalDomNode, locator: AssistedNodeLocator, byId: Map<number, LocalDomNode>): boolean {
  if (locator.tag && node.tag !== locator.tag) return false;
  if (locator.role && node.role !== locator.role) return false;
  if (locator.dataStatus && node.dataStatus !== locator.dataStatus) return false;
  if (locator.ariaCurrent && node.ariaCurrent !== locator.ariaCurrent) return false;
  if (locator.ariaSelected && node.ariaSelected !== locator.ariaSelected) return false;
  if (locator.classes.some((token) => !node.classes.includes(token))) return false;
  if (locator.ancestorTags.length) {
    const tags: string[] = [];
    let current = node;
    for (let depth = 0; depth < 4 && current.parentId !== null; depth += 1) {
      const parent = byId.get(current.parentId);
      if (!parent) break;
      tags.unshift(parent.tag);
      current = parent;
    }
    if (!tags.join("/").endsWith(locator.ancestorTags.join("/"))) return false;
  }
  return true;
}

function commonAncestor(left: LocalDomNode, right: LocalDomNode, byId: Map<number, LocalDomNode>): LocalDomNode | null {
  const leftAncestors = ancestorIds(left, byId);
  let current: LocalDomNode | undefined = right;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (leftAncestors.has(current.id)) return current;
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return null;
}

function hasActiveMarker(node: LocalDomNode): boolean {
  return Boolean(
    (node.ariaCurrent && node.ariaCurrent !== "false")
    || (node.ariaSelected && node.ariaSelected !== "false")
    || node.dataStatus
    || node.classes.some((token) => /(active|current|selected|processing|success|finished|done)/i.test(token)),
  );
}

function nearestActiveNode(node: LocalDomNode, byId: Map<number, LocalDomNode>): LocalDomNode | null {
  let current: LocalDomNode | undefined = node;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (hasActiveMarker(current)) return current;
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return null;
}

function generalizedPathname(url: URL): string {
  const parts = url.pathname.split("/").map((part) => {
    if (!part) return part;
    return /^\d{4,}$/.test(part)
      || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(part)
      || /^[a-z\d_-]{20,}$/i.test(part)
      ? "*"
      : part;
  });
  return parts.join("/") || "/";
}

export function generateAssistedRule(
  snapshot: LocalPageSnapshot,
  selection: AssistedRuleSelection,
): { definition: AssistedParserRuleDefinition; errors: string[] } {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const title = byId.get(selection.titleNodeId);
  const status = byId.get(selection.statusNodeId);
  const errors: string[] = [];
  if (!title) errors.push("所选岗位标题节点不存在");
  if (!status) errors.push("所选状态节点不存在");
  const url = new URL(snapshot.url);
  if (!title || !status) {
    const empty: AssistedNodeLocator = {
      tag: null, role: null, classes: [], dataStatus: null, ariaCurrent: null, ariaSelected: null, ancestorTags: [],
    };
    return {
      definition: {
        schemaVersion: 1,
        layout: selection.layout,
        hostname: selection.hostname ?? url.hostname,
        pathname: selection.pathname ?? generalizedPathname(url),
        container: null,
        title: empty,
        status: empty,
        active: null,
      },
      errors,
    };
  }
  const container = commonAncestor(title, status, byId);
  const activeNode = nearestActiveNode(status, byId);
  const activeLocator = activeNode ? locatorFor(activeNode, byId) : null;
  if (!title.text.trim()) errors.push("所选岗位标题节点没有可见文本");
  if (!status.text.trim()) errors.push("所选状态节点没有可见文本");
  if (selection.layout === "stepper" && !activeLocator) {
    errors.push("当前步骤节点没有可识别的 active/current/selected 标记");
  }
  const definition: AssistedParserRuleDefinition = {
    schemaVersion: 1,
    layout: selection.layout,
    hostname: selection.hostname ?? url.hostname,
    pathname: selection.pathname ?? generalizedPathname(url),
    container: container && container.id !== title.id && container.id !== status.id ? locatorFor(container, byId) : null,
    title: locatorFor(title, byId),
    status: locatorFor(status, byId),
    active: selection.layout === "stepper" ? activeLocator : null,
  };
  try {
    if (!urlPatternMatches(definition, url)) errors.push("规则范围与当前页面地址不匹配");
  } catch {
    errors.push("hostname 或 pathname 不是有效的 URLPattern");
  }
  return { definition, errors };
}

function descendantsOf(root: LocalDomNode, snapshot: LocalPageSnapshot): LocalDomNode[] {
  const ids = new Set<number>([root.id]);
  for (const node of snapshot.nodes) {
    if (node.parentId !== null && ids.has(node.parentId)) ids.add(node.id);
  }
  return snapshot.nodes.filter((node) => ids.has(node.id));
}

function nodeOrAncestorMatches(
  node: LocalDomNode,
  locator: AssistedNodeLocator,
  byId: Map<number, LocalDomNode>,
): boolean {
  let current: LocalDomNode | undefined = node;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (locatorMatches(current, locator, byId)) return true;
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return false;
}

function recognizeWithAssistedRule(
  snapshot: LocalPageSnapshot,
  candidates: LocalRecognitionCandidate[],
  rule: AssistedParserRule,
  statusRules: StatusMappingRule[],
): { result: LocalRecognitionResult; matchedNodeIds: number[] } | null {
  const url = new URL(snapshot.url);
  if (!rule.enabled || !urlPatternMatches(rule.definition, url)) return null;
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const titleNodes = snapshot.nodes.filter((node) => locatorMatches(node, rule.definition.title, byId));
  const matchedNodeIds: number[] = [];
  const results = candidates.map((candidate): LocalRecognitionResultItem => {
    const target = normalizeRecognitionText(candidate.jobTitle);
    const matches = titleNodes.filter((node) => normalizeRecognitionText(node.text) === target);
    if (matches.length !== 1) {
      return {
        applicationId: candidate.id, matched: false, rawStatus: null, status: null, confidence: 0,
        evidence: matches.length ? "辅助规则匹配到多个同名岗位" : "辅助规则未匹配岗位标题",
        titleMatch: "none", statusRule: null,
      };
    }
    const titleNode = matches[0]!;
    let scope = snapshot.nodes;
    if (rule.definition.container) {
      let current: LocalDomNode | undefined = titleNode;
      for (let depth = 0; current && depth < 8; depth += 1) {
        if (locatorMatches(current, rule.definition.container, byId)) {
          scope = descendantsOf(current, snapshot);
          break;
        }
        current = current.parentId === null ? undefined : byId.get(current.parentId);
      }
    } else {
      scope = snapshot.nodes.filter((node) =>
        node.y >= titleNode.y - 40 && node.y <= titleNode.y + 360
        && node.x + node.width >= titleNode.x - 100 && node.x <= titleNode.x + Math.max(1000, titleNode.width * 5));
    }
    let statusNodes = scope.filter((node) => locatorMatches(node, rule.definition.status, byId));
    if (rule.definition.layout === "stepper" && rule.definition.active) {
      statusNodes = statusNodes.filter((node) => nodeOrAncestorMatches(node, rule.definition.active!, byId));
    }
    let mapped = statusMatches(statusNodes, statusRules);
    if (mapped.length) {
      const longest = Math.max(...mapped.map((item) => normalizeRecognitionText(item.term).length));
      mapped = mapped.filter((item) => normalizeRecognitionText(item.term).length === longest);
    }
    const statuses = [...new Set(mapped.map((item) => item.rule.status))];
    if (mapped.length !== 1 || statuses.length !== 1) {
      return {
        applicationId: candidate.id, matched: false, rawStatus: null, status: null, confidence: 0,
        evidence: mapped.length ? "辅助规则提取到多个冲突状态" : "辅助规则未提取到可映射状态",
        titleMatch: "exact", statusRule: null,
      };
    }
    const selected = mapped[0]!;
    matchedNodeIds.push(titleNode.id, selected.node.id);
    return {
      applicationId: candidate.id,
      matched: true,
      rawStatus: selected.term,
      status: selected.rule.status,
      confidence: 0.99,
      evidence: `辅助规则“${rule.name}”完全匹配岗位与状态“${selected.term}”`,
      titleMatch: "exact",
      statusRule: selected.rule.id,
    };
  });
  return {
    result: {
      adapterId: `assisted:${rule.id}`,
      adapterVersion: String(rule.version),
      route: {
        adapterId: `assisted:${rule.id}`,
        version: String(rule.version),
        priority: rule.priority,
        hostname: rule.definition.hostname,
        pathname: rule.definition.pathname,
      },
      pageType: "status",
      pageEvidence: `命中用户辅助规则“${rule.name}”`,
      results,
      fallbackReason: results.some((item) => !item.matched) ? "辅助规则未可靠匹配全部岗位" : null,
    },
    matchedNodeIds: [...new Set(matchedNodeIds)],
  };
}

export function testAssistedRule(
  snapshot: LocalPageSnapshot,
  candidates: LocalRecognitionCandidate[],
  rule: AssistedParserRule,
  customStatusMappings?: StatusMappings | null,
): AssistedRuleTestResult {
  const errors: string[] = [];
  let matched: ReturnType<typeof recognizeWithAssistedRule> = null;
  try {
    matched = recognizeWithAssistedRule(snapshot, candidates, rule, createStatusMappingRules(customStatusMappings));
  } catch {
    errors.push("规则 URLPattern 无效");
  }
  if (!matched) errors.push("规则未命中当前页面");
  const fallback = recognizeLocalPage(snapshot, candidates, customStatusMappings, []);
  const result = matched?.result ?? fallback;
  if (result.results.every((item) => !item.matched)) errors.push("规则未可靠识别任何岗位");
  return { valid: errors.length === 0, errors, result, matchedNodeIds: matched?.matchedNodeIds ?? [] };
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
  adapter: ParserAdapter | null;
  route: ParserRouteRule | null;
  matchedBy: "path" | "dom" | null;
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
    if (adapter.domFeatures?.some((feature) => fingerprint.includes(normalizeRecognitionText(feature)))) {
      return { adapter, route: null, matchedBy: "dom" };
    }
  }
  return { adapter: null, route: null, matchedBy: null };
}

function classifySnapshot(snapshot: LocalPageSnapshot, candidates: LocalRecognitionCandidate[]) {
  const text = snapshot.visibleText.trim();
  const normalized = normalizeRecognitionText(`${snapshot.title} ${text}`);
  if (text.length < 8) return { type: "blank" as const, evidence: "页面没有足够的可见文本" };
  const hasCandidate = candidates.some((candidate) => normalized.includes(normalizeRecognitionText(candidate.jobTitle)));
  if (!hasCandidate && /(登录|请登录|立即登录|账号登录|密码登录|扫码登录|验证码登录|sign\s?in|log\s?in)/i.test(`${snapshot.title} ${text.slice(0, 3000)}`)) {
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
    const marker = normalizeRecognitionText(
      `${node.classes.join(" ")} ${node.dataStatus ?? ""} ${node.role ?? ""} ${node.ariaCurrent ?? ""} ${node.ariaSelected ?? ""}`,
    );
    const active = Boolean(
      (node.ariaCurrent && node.ariaCurrent !== "false")
      || (node.ariaSelected && node.ariaSelected !== "false")
      || /(active|current|selected|processing|success|finished|done|进行中|当前)/i.test(marker),
    );
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
  const topZhiyeExact = adapter.id === "beisen" && exact.length > 1
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
  assistedRules: AssistedParserRule[] = [],
): LocalRecognitionResult {
  const statusRules = createStatusMappingRules(customStatusMappings);
  const orderedRules = assistedRules
    .filter((rule) => rule.enabled)
    .sort((left, right) => {
      const specificity = (value: AssistedParserRule) =>
        value.definition.hostname.replaceAll("*", "").length + value.definition.pathname.replaceAll("*", "").length;
      return specificity(right) - specificity(left) || right.priority - left.priority;
    });
  for (const rule of orderedRules) {
    try {
      const assisted = recognizeWithAssistedRule(snapshot, candidates, rule, statusRules);
      if (assisted && assisted.result.results.some((result) => result.matched)) return assisted.result;
    } catch {
      // Invalid or stale user rules safely fall through to built-in parsing.
    }
  }
  const resolved = resolveParserAdapter(snapshot);
  const classification = classifySnapshot(snapshot, candidates);
  if (!resolved.adapter) {
    return {
      adapterId: null,
      adapterVersion: null,
      route: null,
      pageType: classification.type === "status" ? "unknown" : classification.type,
      pageEvidence: classification.evidence,
      results: candidates.map((candidate) => ({
        applicationId: candidate.id,
        matched: false,
        rawStatus: null,
        status: null,
        confidence: 0,
        evidence: "当前页面未命中北森、Moka、飞书或已启用的用户规则",
        titleMatch: "none",
        statusRule: null,
      })),
      fallbackReason: "未命中支持的本地适配器，需要 AI 回退",
    };
  }
  const adapter = resolved.adapter;
  if (classification.type !== "status") {
    return {
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      route: resolved.route,
      pageType: classification.type,
      pageEvidence: classification.evidence,
      results: candidates.map((candidate) => ({
        applicationId: candidate.id,
        matched: false,
        rawStatus: classification.type === "login" ? "login_required" : classification.type,
        status: null,
        confidence: 0.99,
        evidence: classification.evidence,
        titleMatch: "none",
        statusRule: classification.type,
      })),
      fallbackReason: classification.evidence,
    };
  }
  const results = candidates.map((candidate) => parseCandidate(snapshot, adapter, candidate, statusRules));
  return {
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    route: resolved.route,
    pageType: "status",
    pageEvidence: null,
    results,
    fallbackReason: results.every((result) => !result.matched)
      ? `适配器 ${adapter.id} 未可靠匹配任何岗位`
      : results.some((result) => !result.matched) ? "部分岗位需要 AI 回退" : null,
  };
}

export const parserAdapters = adapters;
