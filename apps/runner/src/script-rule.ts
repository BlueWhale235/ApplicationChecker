import type { Page } from "puppeteer-core";
import type {
  AssistedParserRule,
  ScriptParserRuleDefinition,
  ScriptRuleApplication,
  ScriptRuleExecution,
  ScriptRuleOutputItem,
} from "@application-checker/contracts";

const MAX_RESULT_BYTES = 64 * 1024;

function patternMatches(definition: ScriptParserRuleDefinition, input: string): boolean {
  const Pattern = (globalThis as unknown as {
    URLPattern?: new (value: { hostname: string; pathname: string }) => { test(value: string | URL): boolean };
  }).URLPattern;
  if (!Pattern) throw new Error("URLPattern requires Node.js 24 or newer");
  return new Pattern({ hostname: definition.hostname, pathname: definition.pathname }).test(input);
}

export function selectScriptRule(rules: AssistedParserRule[], url: string): AssistedParserRule | null {
  const matching = rules.filter((rule) =>
    rule.enabled && rule.definition.kind === "script" && patternMatches(rule.definition, url));
  return matching.sort((left, right) => {
    const specificity = (rule: AssistedParserRule) =>
      rule.definition.hostname.replaceAll("*", "").length + rule.definition.pathname.replaceAll("*", "").length;
    return specificity(right) - specificity(left) || right.priority - left.priority;
  })[0] ?? null;
}

export function normalizeScriptOutput(
  value: unknown,
  applications: ScriptRuleApplication[],
): ScriptRuleOutputItem[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  const applicationIds = new Set(applications.map((item) => item.id));
  const normalized = items.map((item, index): ScriptRuleOutputItem => {
    if (!item || typeof item !== "object") throw new Error(`脚本返回的第 ${index + 1} 项不是对象`);
    const source = item as Record<string, unknown>;
    const applicationId = typeof source.applicationId === "string" ? source.applicationId.trim() : "";
    const rawStatus = typeof source.rawStatus === "string" ? source.rawStatus.trim() : "";
    if (!applicationIds.has(applicationId)) throw new Error(`脚本返回了未知岗位 ID：${applicationId || "(空)"}`);
    if (!rawStatus) throw new Error(`脚本返回的第 ${index + 1} 项缺少 rawStatus`);
    if (rawStatus.length > 500) throw new Error("脚本返回的 rawStatus 不能超过 500 个字符");
    const evidence = typeof source.evidence === "string" ? source.evidence.trim().slice(0, 2_000) : undefined;
    return { applicationId, rawStatus, ...(evidence ? { evidence } : {}) };
  });
  if (new Set(normalized.map((item) => item.applicationId)).size !== normalized.length) {
    throw new Error("脚本不能为同一个岗位返回多条结果");
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_RESULT_BYTES) {
    throw new Error("脚本返回结果超过 64KB 限制");
  }
  return normalized;
}

export async function executeScriptRule(
  page: Page,
  rule: AssistedParserRule,
  primaryApplicationId: string,
  applications: ScriptRuleApplication[],
): Promise<ScriptRuleExecution> {
  if (rule.definition.kind !== "script") throw new Error("只能执行页面脚本规则");
  const definition = rule.definition;
  const primary = applications.find((item) => item.id === primaryApplicationId) ?? applications[0];
  if (!primary) throw new Error("页面脚本没有可用的投递数据");
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const evaluation = page.evaluate(async ({ source, application, allApplications }) => {
    const freeze = <T>(input: T): T => {
      if (input && typeof input === "object") {
        Object.freeze(input);
        Object.values(input as Record<string, unknown>).forEach((child) => freeze(child));
      }
      return input;
    };
    const requireElement = (selector: string): Element => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`未找到页面元素：${selector}`);
      return element;
    };
    const helpers = Object.freeze({
      exists(selector: string): boolean {
        return document.querySelector(selector) !== null;
      },
      count(selector: string): number {
        return document.querySelectorAll(selector).length;
      },
      text(selector: string): string {
        return (requireElement(selector).textContent ?? "").trim();
      },
      texts(selector: string): string[] {
        return [...document.querySelectorAll(selector)].map((element) => (element.textContent ?? "").trim());
      },
      textsWithin(containerSelector: string, childSelector: string): string[][] {
        return [...document.querySelectorAll(containerSelector)].map((container) =>
          [...container.querySelectorAll(childSelector)].map((element) => (element.textContent ?? "").trim()),
        );
      },
      value(selector: string): string {
        const element = requireElement(selector);
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
          throw new Error(`元素不支持读取值：${selector}`);
        }
        return element.value;
      },
      attr(selector: string, name: string): string | null {
        return requireElement(selector).getAttribute(String(name));
      },
      nextText(selector: string): string {
        const sibling = requireElement(selector).nextElementSibling;
        if (!sibling) throw new Error(`元素没有下一个同级元素：${selector}`);
        return (sibling.textContent ?? "").trim();
      },
      closestText(selector: string, ancestorSelector: string): string {
        const ancestor = requireElement(selector).closest(String(ancestorSelector));
        if (!ancestor) throw new Error(`元素没有匹配的上级元素：${ancestorSelector}`);
        return (ancestor.textContent ?? "").trim();
      },
      async fill(selector: string, value: unknown): Promise<void> {
        const element = requireElement(selector);
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
          throw new Error(`元素不支持填写：${selector}`);
        }
        const text = value === null || value === undefined ? "" : String(value);
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, text);
        else element.value = text;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
      },
      async select(selector: string, value: unknown): Promise<void> {
        const element = requireElement(selector);
        if (!(element instanceof HTMLSelectElement)) throw new Error(`元素不是下拉选择框：${selector}`);
        element.value = value === null || value === undefined ? "" : String(value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      },
      async click(selector: string): Promise<void> {
        const element = requireElement(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`元素不可点击：${selector}`);
        element.click();
      },
      async waitForSelector(selector: string, timeoutMs = 5_000): Promise<void> {
        const timeout = Math.max(100, Math.min(60_000, Number(timeoutMs) || 5_000));
        const start = Date.now();
        while (!document.querySelector(selector)) {
          if (Date.now() - start >= timeout) throw new Error(`等待页面元素超时：${selector}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      async waitForText(selector: string, expected: unknown, timeoutMs = 5_000): Promise<void> {
        const target = String(expected);
        const timeout = Math.max(100, Math.min(60_000, Number(timeoutMs) || 5_000));
        const start = Date.now();
        while (((document.querySelector(selector)?.textContent ?? "").trim()).includes(target) === false) {
          if (Date.now() - start >= timeout) throw new Error(`等待页面文本超时：${selector}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      async waitForTextChange(selector: string, previousText: unknown, timeoutMs = 5_000): Promise<void> {
        const previous = String(previousText ?? "").trim();
        const timeout = Math.max(100, Math.min(60_000, Number(timeoutMs) || 5_000));
        const start = Date.now();
        while (((document.querySelector(selector)?.textContent ?? "").trim()) === previous) {
          if (Date.now() - start >= timeout) throw new Error(`等待页面文本变化超时：${selector}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      scrollIntoView(selector: string): void {
        requireElement(selector).scrollIntoView({ block: "center", inline: "nearest" });
      },
      async sleep(milliseconds: number): Promise<void> {
        const delay = Math.max(0, Math.min(3_000, Number(milliseconds) || 0));
        await new Promise((resolve) => setTimeout(resolve, delay));
      },
    });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...parameters: string[]
    ) => (...values: unknown[]) => Promise<unknown>;
    const runnable = new AsyncFunction("application", "applications", "helpers", `"use strict";\n${source}`);
    return runnable(freeze(application), freeze(allApplications), helpers);
  }, {
    source: definition.script,
    application: structuredClone(primary),
    allApplications: structuredClone(applications),
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void page.close().catch(() => {});
      reject(new Error(`页面脚本执行超过 ${definition.timeoutMs}ms`));
    }, definition.timeoutMs);
  });
  try {
    const output = await Promise.race([evaluation, timeout]);
    return {
      ruleId: rule.id,
      ruleVersion: rule.version,
      durationMs: Date.now() - startedAt,
      results: normalizeScriptOutput(output, applications),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
