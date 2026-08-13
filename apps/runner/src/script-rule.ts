import type { Page } from "puppeteer-core";
import type {
  AssistedParserRule,
  ScriptParserRuleDefinition,
  ScriptRuleApplication,
  ScriptRuleExecution,
  ScriptRuleLogEntry,
  ScriptRuleOutputItem,
} from "@application-checker/contracts";
import { randomUUID } from "node:crypto";
import {
  formatScriptLogValues,
  ScriptRuleLogCollector,
  type ScriptRuleLogPayload,
} from "./script-rule-log.js";
import { runSelectorRuleInPage } from "./script-selector-rule.js";

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_HTTP_REQUEST_BYTES = 256 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SCRIPT_NAVIGATIONS = 3;
const SCRIPT_LOG_BRIDGE = "__applicationCheckerScriptLog";
const SCRIPT_DIRECT_STATUSES = new Set([
  "unset", "screening", "screening_passed", "interview_pending", "interviewed",
  "signing_pending", "offer", "rejected", "needs_login",
]);

export class ScriptRuleExecutionError extends Error {
  constructor(
    message: string,
    readonly durationMs: number,
    readonly logs: ScriptRuleLogEntry[],
    readonly logsTruncated: boolean,
  ) {
    super(message);
    this.name = "ScriptRuleExecutionError";
  }
}

function patternMatches(definition: ScriptParserRuleDefinition, input: string): boolean {
  const Pattern = (globalThis as unknown as {
    URLPattern?: new (value: { hostname: string; pathname: string }) => { test(value: string | URL): boolean };
  }).URLPattern;
  if (!Pattern) throw new Error("URLPattern requires Node.js 24 or newer");
  return new Pattern({ hostname: definition.hostname, pathname: definition.pathname }).test(input);
}

function hostnameMatches(definition: ScriptParserRuleDefinition, input: string): boolean {
  const Pattern = (globalThis as unknown as {
    URLPattern?: new (value: { hostname: string; pathname: string }) => { test(value: string | URL): boolean };
  }).URLPattern;
  if (!Pattern) throw new Error("URLPattern requires Node.js 24 or newer");
  return new Pattern({ hostname: definition.hostname, pathname: "/*" }).test(input);
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
    const directStatus = typeof source.directStatus === "string" ? source.directStatus.trim() : "";
    const scriptError = typeof source.error === "string" ? source.error.trim() : "";
    const errorLine = Number.isInteger(source.errorLine) && Number(source.errorLine) > 0 ? Number(source.errorLine) : undefined;
    if (!applicationIds.has(applicationId)) throw new Error(`脚本返回了未知岗位 ID：${applicationId || "(空)"}`);
    if (!rawStatus) throw new Error(`脚本返回的第 ${index + 1} 项缺少 rawStatus`);
    if (rawStatus.length > 500) throw new Error("脚本返回的 rawStatus 不能超过 500 个字符");
    if (directStatus && !SCRIPT_DIRECT_STATUSES.has(directStatus)) {
      throw new Error(`脚本返回了不支持的直接状态：${directStatus}`);
    }
    if (scriptError.length > 500) throw new Error("脚本错误原因不能超过 500 个字符");
    if (scriptError && directStatus) throw new Error("脚本结果不能同时包含 error 和 directStatus");
    const evidence = typeof source.evidence === "string" ? source.evidence.trim().slice(0, 2_000) : undefined;
    return {
      applicationId,
      rawStatus,
      ...(directStatus ? { directStatus: directStatus as NonNullable<ScriptRuleOutputItem["directStatus"]> } : {}),
      ...(evidence ? { evidence } : {}),
      ...(scriptError ? { error: scriptError } : {}),
      ...(errorLine ? { errorLine } : {}),
    };
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
  const logCollector = new ScriptRuleLogCollector();
  const logBridgeName = `${SCRIPT_LOG_BRIDGE}_${randomUUID().replaceAll("-", "")}`;
  await page.exposeFunction(logBridgeName, (entry: unknown) => logCollector.add(entry));
  let timer: NodeJS.Timeout | undefined;
  const evaluateOnce = (logIndexOffset: number) => page.evaluate(async ({
    source, application, allApplications, logBridgeName, formatLogSource, scriptStartedAt,
    logIndexOffset, maxRequestBytes, maxResponseBytes, selectorRuleSource,
  }) => {
    class NavigationRequest extends Error {
      constructor(readonly url: string) { super("页面脚本请求跳转"); }
    }
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
    const logEntries: ScriptRuleLogPayload[] = [];
    let logBytes = 0;
    let logsTruncated = false;
    const logBridge = (globalThis as unknown as Record<string, (entry: unknown) => Promise<void>>)[logBridgeName];
    if (typeof logBridge !== "function") throw new Error("页面脚本调试日志桥不可用");
    const formatLog = new Function(`return (${formatLogSource})`)() as (values: unknown[]) => string;
    const runSelectorRule = new Function(`return (${selectorRuleSource})`)() as
      (definition: unknown, candidates: typeof allApplications) => ScriptRuleOutputItem[];
    const markLogsTruncated = (): void => {
      if (logsTruncated) return;
      logsTruncated = true;
      void logBridge({ truncated: true });
    };
    type AxiosConfig = {
      url?: string; method?: string; baseURL?: string; params?: Record<string, unknown>;
      headers?: Record<string, unknown>; data?: unknown; timeout?: number;
      responseType?: "json" | "text"; withCredentials?: boolean;
    };
    type AxiosResponse = {
      data: unknown; status: number; statusText: string; headers: Record<string, string>; url: string;
    };
    const forbiddenHeader = (name: string): boolean => {
      const normalized = name.trim().toLowerCase();
      return ["cookie", "host", "origin", "referer"].includes(normalized) || normalized.startsWith("sec-");
    };
    const axios = async (config: AxiosConfig): Promise<AxiosResponse> => {
      if (!config || typeof config !== "object") throw new Error("helpers.axios 需要请求配置");
      const rawUrl = typeof config.url === "string" ? config.url.trim() : "";
      if (!rawUrl) throw new Error("helpers.axios 缺少 url");
      const base = config.baseURL ? new URL(config.baseURL, location.href) : new URL(location.href);
      const url = new URL(rawUrl, base);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("helpers.axios 仅支持 HTTP(S) 地址");
      for (const [name, value] of Object.entries(config.params ?? {})) {
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(name, String(item)));
        else url.searchParams.set(name, String(value));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(config.headers ?? {})) {
        if (forbiddenHeader(name)) throw new Error(`helpers.axios 不允许设置请求头：${name}`);
        if (value !== null && value !== undefined) headers.set(name, String(value));
      }
      let body: BodyInit | undefined;
      if (config.data !== null && config.data !== undefined) {
        if (typeof config.data === "string" || config.data instanceof Blob
          || config.data instanceof FormData || config.data instanceof URLSearchParams) body = config.data;
        else {
          body = JSON.stringify(config.data);
          if (!headers.has("content-type")) headers.set("content-type", "application/json");
        }
        const size = typeof body === "string" ? new TextEncoder().encode(body).byteLength
          : body instanceof Blob ? body.size
            : body instanceof URLSearchParams ? new TextEncoder().encode(body.toString()).byteLength
              : body instanceof FormData ? (await new Response(body).arrayBuffer()).byteLength : null;
        if (size !== null && size > maxRequestBytes) throw new Error("helpers.axios 请求体超过 256KB 限制");
      }
      const method = String(config.method ?? (body === undefined ? "GET" : "POST")).toUpperCase();
      const timeout = Math.max(1_000, Math.min(60_000, Number(config.timeout) || 10_000));
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, {
          method, headers, ...(body === undefined ? {} : { body }), signal: controller.signal,
          credentials: config.withCredentials ? "include" : "same-origin",
        });
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxResponseBytes) {
              await reader.cancel();
              throw new Error("helpers.axios 响应体超过 2MB 限制");
            }
            chunks.push(value);
          }
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const text = new TextDecoder().decode(bytes);
        let data: unknown = text;
        if (config.responseType === "json" || (!config.responseType && response.headers.get("content-type")?.includes("json"))) {
          data = text ? JSON.parse(text) : null;
        }
        const result = {
          data, status: response.status, statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()), url: response.url,
        };
        if (!response.ok) {
          const error = new Error(`helpers.axios 请求失败：HTTP ${response.status}`) as Error & { response?: AxiosResponse };
          error.response = result;
          throw error;
        }
        return result;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw new Error(`helpers.axios 请求超过 ${timeout}ms`);
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    };
    const axiosApi = Object.freeze(Object.assign(axios, {
      get: (url: string, config: AxiosConfig = {}) => axios({ ...config, url, method: "GET" }),
      delete: (url: string, config: AxiosConfig = {}) => axios({ ...config, url, method: "DELETE" }),
      post: (url: string, data?: unknown, config: AxiosConfig = {}) => axios({ ...config, url, data, method: "POST" }),
      put: (url: string, data?: unknown, config: AxiosConfig = {}) => axios({ ...config, url, data, method: "PUT" }),
      patch: (url: string, data?: unknown, config: AxiosConfig = {}) => axios({ ...config, url, data, method: "PATCH" }),
    }));
    const helpers = Object.freeze({
      currentUrl(): string { return location.href; },
      async goto(url: string): Promise<never> {
        const target = new URL(String(url), location.href);
        if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("helpers.goto 仅支持 HTTP(S) 地址");
        throw new NavigationRequest(target.href);
      },
      axios: axiosApi,
      log(...values: unknown[]): void {
        if (logsTruncated || logEntries.length >= 100) { markLogsTruncated(); return; }
        const original = formatLog(values);
        const encoded = new TextEncoder().encode(original);
        const suffix = new TextEncoder().encode("…");
        const message = encoded.byteLength <= 2_048 ? original
          : `${new TextDecoder().decode(encoded.slice(0, Math.max(0, 2_048 - suffix.byteLength)))}…`;
        const bytes = new TextEncoder().encode(message).byteLength;
        if (logBytes + bytes > 32_768) { markLogsTruncated(); return; }
        const entry = { index: logIndexOffset + logEntries.length, atMs: Date.now() - scriptStartedAt, message };
        logEntries.push(entry); logBytes += bytes;
        if (message !== original) markLogsTruncated();
        void logBridge(entry);
      },
      status(status: string, options: { applicationId?: string; evidence?: string } = {}): ScriptRuleOutputItem {
        const labels: Record<string, string> = {
          unset: "未设置",
          screening: "初筛",
          screening_passed: "已过初筛",
          interview_pending: "待面试",
          interviewed: "已面试",
          signing_pending: "待签约",
          offer: "已收 OFFER",
          rejected: "淘汰",
          needs_login: "login_required",
        };
        if (!(status in labels)) throw new Error(`helpers.status 不支持状态：${status}`);
        const applicationId = String(options.applicationId ?? application.id).trim();
        if (!allApplications.some((item) => item.id === applicationId)) {
          throw new Error(`helpers.status 收到未知岗位 ID：${applicationId || "(空)"}`);
        }
        const evidence = typeof options.evidence === "string" ? options.evidence.trim().slice(0, 2_000) : "";
        return {
          applicationId,
          rawStatus: labels[status]!,
          directStatus: status as NonNullable<ScriptRuleOutputItem["directStatus"]>,
          ...(evidence ? { evidence } : {}),
        };
      },
      statusAll(status: string, options: { evidence?: string } = {}): ScriptRuleOutputItem[] {
        const labels: Record<string, string> = {
          unset: "未设置", screening: "初筛", screening_passed: "已过初筛", interview_pending: "待面试",
          interviewed: "已面试", signing_pending: "待签约", offer: "已收 OFFER", rejected: "淘汰", needs_login: "login_required",
        };
        if (!(status in labels)) throw new Error(`helpers.statusAll 不支持状态：${status}`);
        const evidence = typeof options.evidence === "string" ? options.evidence.trim().slice(0, 2_000) : "";
        return allApplications.map((item) => ({
          applicationId: item.id,
          rawStatus: labels[status]!,
          directStatus: status as NonNullable<ScriptRuleOutputItem["directStatus"]>,
          ...(evidence ? { evidence } : {}),
        }));
      },
      error(message?: unknown, options: { applicationId?: string } = {}): ScriptRuleOutputItem {
        const applicationId = String(options.applicationId ?? application.id).trim();
        if (!allApplications.some((item) => item.id === applicationId)) {
          throw new Error(`helpers.error 收到未知岗位 ID：${applicationId || "(空)"}`);
        }
        const stack = new Error().stack ?? "";
        const frames = [...stack.matchAll(/<anonymous>:(\d+):(\d+)/g)];
        const runtimeLine = frames.length ? Number(frames[frames.length - 1]?.[1]) : 0;
        const errorLine = runtimeLine > 3 ? runtimeLine - 3 : undefined;
        const custom = typeof message === "string" ? message.trim().slice(0, 500) : "";
        const error = custom || "脚本运行时错误";
        return { applicationId, rawStatus: "script_error", error, ...(errorLine ? { errorLine } : {}), evidence: error };
      },
      errorAll(message?: unknown): ScriptRuleOutputItem[] {
        const stack = new Error().stack ?? "";
        const frames = [...stack.matchAll(/<anonymous>:(\d+):(\d+)/g)];
        const runtimeLine = frames.length ? Number(frames[frames.length - 1]?.[1]) : 0;
        const errorLine = runtimeLine > 3 ? runtimeLine - 3 : undefined;
        const custom = typeof message === "string" ? message.trim().slice(0, 500) : "";
        const error = custom || "脚本运行时错误";
        return allApplications.map((item) => ({
          applicationId: item.id, rawStatus: "script_error", error,
          ...(errorLine ? { errorLine } : {}), evidence: error,
        }));
      },
      runSelectorRule: (selectorDefinition: unknown): ScriptRuleOutputItem[] =>
        runSelectorRule(selectorDefinition, allApplications),
      exists: (selector: string): boolean => document.querySelector(selector) !== null,
      count: (selector: string): number => document.querySelectorAll(selector).length,
      text: (selector: string): string => (requireElement(selector).textContent ?? "").trim(),
      texts: (selector: string): string[] => [...document.querySelectorAll(selector)].map((element) => (element.textContent ?? "").trim()),
      textsWithin: (containerSelector: string, childSelector: string): string[][] =>
        [...document.querySelectorAll(containerSelector)].map((container) =>
          [...container.querySelectorAll(childSelector)].map((element) => (element.textContent ?? "").trim())),
      value(selector: string): string {
        const element = requireElement(selector);
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error(`元素不支持读取值：${selector}`);
        return element.value;
      },
      attr: (selector: string, name: string): string | null => requireElement(selector).getAttribute(String(name)),
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
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error(`元素不支持填写：${selector}`);
        const text = value === null || value === undefined ? "" : String(value);
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, text); else element.value = text;
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
        const timeout = Math.max(100, Math.min(60_000, Number(timeoutMs) || 5_000)); const start = Date.now();
        while (!document.querySelector(selector)) { if (Date.now() - start >= timeout) throw new Error(`等待页面元素超时：${selector}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
      },
      async waitForText(selector: string, expected: unknown, timeoutMs = 5_000): Promise<void> {
        const target = String(expected); const timeout = Math.max(100, Math.min(60_000, Number(timeoutMs) || 5_000)); const start = Date.now();
        while (!((document.querySelector(selector)?.textContent ?? "").trim()).includes(target)) { if (Date.now() - start >= timeout) throw new Error(`等待页面文本超时：${selector}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
      },
      async waitForTextChange(selector: string, previousText: unknown, timeoutMs = 5_000): Promise<void> {
        const previous = String(previousText ?? "").trim(); const timeout = Math.max(100, Math.min(60_000, Number(timeoutMs) || 5_000)); const start = Date.now();
        while (((document.querySelector(selector)?.textContent ?? "").trim()) === previous) { if (Date.now() - start >= timeout) throw new Error(`等待页面文本变化超时：${selector}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
      },
      scrollIntoView: (selector: string): void => requireElement(selector).scrollIntoView({ block: "center", inline: "nearest" }),
      async sleep(milliseconds: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(3_000, Number(milliseconds) || 0)))); },
    });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...parameters: string[]) => (...values: unknown[]) => Promise<unknown>;
    const runnable = new AsyncFunction("application", "applications", "helpers", `"use strict";\n${source}`);
    try {
      const output = await runnable(freeze(application), freeze(allApplications), helpers);
      return { kind: "success" as const, output, logs: logEntries, logsTruncated };
    } catch (error) {
      if (error instanceof NavigationRequest) return { kind: "navigate" as const, url: error.url, logs: logEntries, logsTruncated };
      return { kind: "failure" as const, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), logs: logEntries, logsTruncated };
    }
  }, {
    source: definition.script, application: structuredClone(primary), allApplications: structuredClone(applications),
    logBridgeName, formatLogSource: formatScriptLogValues.toString(), scriptStartedAt: startedAt,
    logIndexOffset, maxRequestBytes: MAX_HTTP_REQUEST_BYTES, maxResponseBytes: MAX_HTTP_RESPONSE_BYTES,
    selectorRuleSource: runSelectorRuleInPage.toString(),
  });
  const workflow = async (): Promise<ScriptRuleExecution> => {
    let navigationCount = 0;
    while (true) {
      const envelope = await evaluateOnce(logCollector.snapshot().logs.length);
      logCollector.merge(envelope.logs, envelope.logsTruncated);
      if (envelope.kind === "navigate") {
        if (navigationCount >= MAX_SCRIPT_NAVIGATIONS) throw new Error(`页面脚本跳转超过 ${MAX_SCRIPT_NAVIGATIONS} 次限制`);
        if (!hostnameMatches(definition, envelope.url)) throw new Error(`helpers.goto 不允许跳转到规则范围外的域名：${new URL(envelope.url).hostname}`);
        const remaining = definition.timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) throw new Error(`页面脚本执行超过 ${definition.timeoutMs}ms`);
        await page.goto(envelope.url, { waitUntil: "domcontentloaded", timeout: remaining });
        if (!hostnameMatches(definition, page.url())) throw new Error(`helpers.goto 跳转后离开了规则范围：${page.url()}`);
        navigationCount += 1;
        continue;
      }
      const snapshot = logCollector.snapshot();
      if (envelope.kind === "failure") throw new ScriptRuleExecutionError(envelope.error, Date.now() - startedAt, snapshot.logs, snapshot.logsTruncated);
      return {
        ruleId: rule.id, ruleVersion: rule.version, durationMs: Date.now() - startedAt,
        results: normalizeScriptOutput(envelope.output, applications), logs: snapshot.logs, logsTruncated: snapshot.logsTruncated,
      };
    }
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void page.close().catch(() => {});
      const snapshot = logCollector.snapshot();
      reject(new ScriptRuleExecutionError(
        `页面脚本执行超过 ${definition.timeoutMs}ms`,
        Date.now() - startedAt,
        snapshot.logs,
        snapshot.logsTruncated,
      ));
    }, definition.timeoutMs);
  });
  try {
    return await Promise.race([workflow(), timeout]);
  } catch (error) {
    if (error instanceof ScriptRuleExecutionError) throw error;
    const snapshot = logCollector.snapshot();
    throw new ScriptRuleExecutionError(
      error instanceof Error ? error.message : "页面脚本执行失败",
      Date.now() - startedAt,
      snapshot.logs,
      snapshot.logsTruncated,
    );
  } finally {
    if (timer) clearTimeout(timer);
    await page.removeExposedFunction(logBridgeName).catch(() => {});
  }
}
