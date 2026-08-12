import type {
  ScriptRuleApplication,
  ScriptRuleOutputItem,
  SelectorParserRuleDefinition,
} from "@application-checker/contracts";

/**
 * This function is serialized with toString() and evaluated inside the target page.
 * Keep every runtime dependency inside the function body.
 */
export function runSelectorRuleInPage(
  input: unknown,
  applications: ScriptRuleApplication[],
): ScriptRuleOutputItem[] {
  type Locator = SelectorParserRuleDefinition["title"];
  type PageElement = Element & { innerText?: string };

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const clean = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
  const normalize = (value: unknown): string => clean(value)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  const stringOrNull = (value: unknown, field: string): string | null => {
    if (value === null) return null;
    if (typeof value !== "string" || value.length > 120) throw new Error(`点选 JSON 的 ${field} 必须是字符串或 null`);
    return value;
  };
  const stringArray = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length > 80)) {
      throw new Error(`点选 JSON 的 ${field} 必须是字符串数组`);
    }
    return [...value] as string[];
  };
  const parseLocator = (value: unknown, field: string, nullable = false): Locator | null => {
    if (value === null && nullable) return null;
    if (!isRecord(value)) throw new Error(`点选 JSON 缺少 ${field} 定位器`);
    const locator: Locator = {
      tag: stringOrNull(value.tag, `${field}.tag`),
      role: stringOrNull(value.role, `${field}.role`),
      classes: stringArray(value.classes, `${field}.classes`),
      dataStatus: stringOrNull(value.dataStatus, `${field}.dataStatus`),
      ariaCurrent: stringOrNull(value.ariaCurrent, `${field}.ariaCurrent`),
      ariaSelected: stringOrNull(value.ariaSelected, `${field}.ariaSelected`),
      ancestorTags: stringArray(value.ancestorTags, `${field}.ancestorTags`),
    };
    if (locator.classes.length > 4 || locator.ancestorTags.length > 4) {
      throw new Error(`点选 JSON 的 ${field} 定位器层级超过限制`);
    }
    const serialized = JSON.stringify(locator);
    if (serialized.length > 2_000 || /(?:script|javascript:|<|>)/i.test(serialized)) {
      throw new Error(`点选 JSON 的 ${field} 定位器包含不安全内容`);
    }
    return locator;
  };
  if (!isRecord(input)) throw new Error("helpers.runSelectorRule 需要完整的点选规则 JSON");
  if (input.schemaVersion !== 2 || input.kind !== "selector") {
    throw new Error('点选 JSON 必须使用 schemaVersion 2 且 kind 为 "selector"');
  }
  const hostname = typeof input.hostname === "string" ? input.hostname.trim() : "";
  const pathname = typeof input.pathname === "string" ? input.pathname.trim() : "";
  if (!hostname || !pathname || /[\r\n{};]/.test(`${hostname}${pathname}`)) {
    throw new Error("点选 JSON 的 hostname 或 pathname 无效");
  }
  const definition = {
    schemaVersion: 2 as const,
    kind: "selector" as const,
    hostname,
    pathname,
    container: parseLocator(input.container, "container", true),
    title: parseLocator(input.title, "title")!,
    status: parseLocator(input.status, "status")!,
  } satisfies SelectorParserRuleDefinition;
  const Pattern = (globalThis as unknown as {
    URLPattern?: new (value: { hostname: string; pathname: string }) => { test(value: string | URL): boolean };
  }).URLPattern;
  if (!Pattern) throw new Error("helpers.runSelectorRule 需要浏览器支持 URLPattern");
  let pattern: { test(value: string | URL): boolean };
  try {
    pattern = new Pattern({ hostname: definition.hostname, pathname: definition.pathname });
  } catch {
    throw new Error("点选 JSON 的 URLPattern 无效");
  }
  if (!pattern.test(location.href)) return [];
  if (!document.body) return [];

  const isVisible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const nodeText = (element: PageElement): string => {
    const direct = clean([...element.childNodes]
      .filter((child) => child.nodeType === 3)
      .map((child) => child.textContent ?? "")
      .join(" "));
    if (direct) return direct.slice(0, 1_000);
    if (element.childElementCount <= 2) return clean(element.innerText ?? element.textContent ?? "").slice(0, 1_000);
    return "";
  };
  const locatorMatches = (element: Element, locator: Locator): boolean => {
    if (locator.tag && element.tagName.toLocaleLowerCase() !== locator.tag.toLocaleLowerCase()) return false;
    if (locator.role && element.getAttribute("role") !== locator.role) return false;
    if (locator.dataStatus && element.getAttribute("data-status") !== locator.dataStatus) return false;
    if (locator.ariaCurrent && element.getAttribute("aria-current") !== locator.ariaCurrent) return false;
    if (locator.ariaSelected && element.getAttribute("aria-selected") !== locator.ariaSelected) return false;
    if (locator.classes.some((token) => !element.classList.contains(token))) return false;
    if (locator.ancestorTags.length) {
      const tags: string[] = [];
      let current: Element | null = element;
      for (let depth = 0; depth < 4 && current.parentElement; depth += 1) {
        current = current.parentElement;
        tags.unshift(current.tagName.toLocaleLowerCase());
      }
      if (!tags.join("/").endsWith(locator.ancestorTags.map((tag) => tag.toLocaleLowerCase()).join("/"))) return false;
    }
    return true;
  };
  const elements = [...document.body.querySelectorAll("*")].filter(isVisible);
  const elementRect = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
  };
  const titleElements = elements.filter((element) => locatorMatches(element, definition.title));
  const results: ScriptRuleOutputItem[] = [];
  for (const application of applications) {
    const target = normalize(application.jobTitle);
    const possible = titleElements
      .map((element) => ({ element, text: nodeText(element as PageElement), normalized: normalize(nodeText(element as PageElement)) }))
      .filter((item) => item.normalized === target
        || (item.normalized.length <= Math.max(target.length * 2.5, target.length + 16) && item.normalized.includes(target)))
      .sort((left, right) => left.normalized.length - right.normalized.length)
      .filter((item, index, all) => {
        const rect = elementRect(item.element);
        return !all.slice(0, index).some((existing) => {
          const existingRect = elementRect(existing.element);
          return existing.normalized === item.normalized
            && Math.abs(existingRect.y - rect.y) <= 5
            && Math.abs(existingRect.x - rect.x) <= 12;
        });
      });
    const exact = possible.filter((item) => item.normalized === target);
    const chosen = exact.length === 1 ? exact[0] : exact.length === 0 && possible.length === 1 ? possible[0] : null;
    if (!chosen) continue;

    let scope: Element[];
    if (definition.container) {
      let container: Element | null = chosen.element;
      for (let depth = 0; container && depth < 8 && !locatorMatches(container, definition.container); depth += 1) {
        container = container.parentElement;
      }
      if (!container || !locatorMatches(container, definition.container)) continue;
      scope = [container, ...container.querySelectorAll("*")].filter(isVisible);
    } else {
      const titleRect = elementRect(chosen.element);
      scope = elements.filter((element) => {
        const rect = elementRect(element);
        return rect.y >= titleRect.y - 40 && rect.y <= titleRect.y + 360
          && rect.x + rect.width >= titleRect.x - 100
          && rect.x <= titleRect.x + Math.max(1_000, titleRect.width * 5);
      });
    }
    const statuses = scope
      .filter((element) => locatorMatches(element, definition.status))
      .map((element) => nodeText(element as PageElement))
      .filter(Boolean);
    const uniqueStatuses = new Map<string, string>();
    for (const status of statuses) {
      const normalized = normalize(status);
      if (!normalized) continue;
      const existing = uniqueStatuses.get(normalized);
      if (!existing || status.length < existing.length) uniqueStatuses.set(normalized, status);
    }
    if (uniqueStatuses.size !== 1) continue;
    const rawStatus = [...uniqueStatuses.values()][0]!;
    results.push({
      applicationId: application.id,
      rawStatus,
      evidence: `点选 JSON 匹配岗位“${application.jobTitle}”，附近状态文本为“${rawStatus}”`,
    });
  }
  return results;
}
