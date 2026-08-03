import type { SelectorParserRuleDefinition } from "@application-checker/contracts";

export type SelectorRuleJsonResult =
  | { definition: SelectorParserRuleDefinition; error: null }
  | { definition: null; error: string };

export function parseSelectorRuleJson(source: string): SelectorRuleJsonResult {
  try {
    const value = JSON.parse(source) as Partial<SelectorParserRuleDefinition> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("规则定义必须是 JSON 对象");
    }
    if (value.schemaVersion !== 2) throw new Error("schemaVersion 必须为 2");
    if (value.kind !== "selector") throw new Error('kind 必须为 "selector"');
    if (typeof value.hostname !== "string" || !value.hostname.trim()) throw new Error("hostname 不能为空");
    if (typeof value.pathname !== "string" || !value.pathname.trim()) throw new Error("pathname 不能为空");
    if (!value.title || typeof value.title !== "object") throw new Error("title 定位器不能为空");
    if (!value.status || typeof value.status !== "object") throw new Error("status 定位器不能为空");
    if (value.container !== null && typeof value.container !== "object") {
      throw new Error("container 必须是对象或 null");
    }
    return { definition: value as SelectorParserRuleDefinition, error: null };
  } catch (error) {
    return { definition: null, error: error instanceof Error ? error.message : "JSON 格式无效" };
  }
}
