import { randomUUID } from "node:crypto";
import type {
  AssistedNodeLocator,
  AssistedParserRule,
  AssistedParserRuleDefinition,
} from "@application-checker/contracts";
import type { DbContext, ParserRulesTable } from "./db.js";

function definitionFromJson(value: string): AssistedParserRuleDefinition {
  const parsed = JSON.parse(value) as Record<string, unknown> & { schemaVersion?: number };
  const definition = parsed.schemaVersion === 1 && "title" in parsed && "status" in parsed
    ? {
      schemaVersion: 2 as const,
      kind: "selector" as const,
      hostname: String(parsed.hostname ?? ""),
      pathname: String(parsed.pathname ?? ""),
      container: (parsed.container ?? null) as AssistedNodeLocator | null,
      title: parsed.title as AssistedNodeLocator,
      status: parsed.status as AssistedNodeLocator,
    }
    : parsed as unknown as AssistedParserRuleDefinition;
  validateDefinition(definition);
  return definition;
}

export function validateDefinition(value: AssistedParserRuleDefinition): void {
  if (value.schemaVersion !== 2) throw new Error("不支持的规则版本");
  if (!["selector", "script"].includes(value.kind)) throw new Error("不支持的规则类型");
  if (!value.hostname || !value.pathname) throw new Error("hostname 和 pathname 不能为空");
  if (/[\r\n{};]/.test(`${value.hostname}${value.pathname}`)) throw new Error("Path 规则包含非法字符");
  const Pattern = (globalThis as unknown as {
    URLPattern?: new (input: { hostname: string; pathname: string }) => unknown;
  }).URLPattern;
  if (!Pattern) throw new Error("规则工作台需要 Node.js 24 或更高版本");
  new Pattern({ hostname: value.hostname, pathname: value.pathname });
  if (value.kind === "script") {
    if (!value.script.trim()) throw new Error("页面脚本不能为空");
    if (value.script.length > 20_000) throw new Error("页面脚本不能超过 20000 个字符");
    if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1_000 || value.timeoutMs > 60_000) {
      throw new Error("脚本超时时间必须在 1000 到 60000 毫秒之间");
    }
    return;
  }
  for (const locator of [value.container, value.title, value.status]) {
    if (!locator) continue;
    if (locator.classes.length > 4 || locator.ancestorTags.length > 4) throw new Error("定位器层级超出限制");
    const serialized = JSON.stringify(locator);
    if (serialized.length > 2_000 || /(?:script|javascript:|<|>)/i.test(serialized)) throw new Error("定位器包含不安全内容");
  }
}

function mapRule(row: ParserRulesTable): AssistedParserRule {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    priority: row.priority,
    version: row.version,
    definition: definitionFromJson(row.rule_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTestedAt: row.last_tested_at,
  };
}

export async function listParserRules(context: DbContext, enabledOnly = false): Promise<AssistedParserRule[]> {
  let query = context.db.selectFrom("parser_rules").selectAll();
  if (enabledOnly) query = query.where("enabled", "=", 1);
  return (await query.orderBy("priority", "desc").orderBy("updated_at", "desc").execute()).map(mapRule);
}

async function assertNoConflict(
  context: DbContext,
  definition: AssistedParserRuleDefinition,
  priority: number,
  excludeId?: string,
): Promise<void> {
  let query = context.db.selectFrom("parser_rules").select("id")
    .where("hostname", "=", definition.hostname)
    .where("pathname", "=", definition.pathname)
    .where("priority", "=", priority);
  if (excludeId) query = query.where("id", "!=", excludeId);
  if (await query.executeTakeFirst()) throw new Error("相同 hostname、pathname 和优先级的规则已存在");
}

export async function saveParserRule(
  context: DbContext,
  input: {
    id?: string;
    name: string;
    enabled?: boolean;
    priority?: number;
    definition: AssistedParserRuleDefinition;
    tested?: boolean;
  },
): Promise<AssistedParserRule> {
  validateDefinition(input.definition);
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("规则名称不能为空");
  const priority = Math.max(-1_000, Math.min(1_000, Math.trunc(input.priority ?? 100)));
  await assertNoConflict(context, input.definition, priority, input.id);
  const now = new Date().toISOString();
  if (input.id) {
    const existing = await context.db.selectFrom("parser_rules").selectAll().where("id", "=", input.id).executeTakeFirst();
    if (!existing) throw new Error("规则不存在");
    await context.db.updateTable("parser_rules").set({
      name,
      enabled: input.enabled === false ? 0 : 1,
      priority,
      version: existing.version + 1,
      hostname: input.definition.hostname,
      pathname: input.definition.pathname,
      rule_json: JSON.stringify(input.definition),
      updated_at: now,
      last_tested_at: input.tested ? now : existing.last_tested_at,
    }).where("id", "=", input.id).execute();
    return (await listParserRules(context)).find((rule) => rule.id === input.id)!;
  }
  const id = randomUUID();
  await context.db.insertInto("parser_rules").values({
    id,
    name,
    enabled: input.enabled === false ? 0 : 1,
    priority,
    version: 1,
    hostname: input.definition.hostname,
    pathname: input.definition.pathname,
    rule_json: JSON.stringify(input.definition),
    created_at: now,
    updated_at: now,
    last_tested_at: input.tested ? now : null,
  }).execute();
  return (await listParserRules(context)).find((rule) => rule.id === id)!;
}

export async function deleteParserRule(context: DbContext, id: string): Promise<boolean> {
  return Number((await context.db.deleteFrom("parser_rules").where("id", "=", id).executeTakeFirst()).numDeletedRows) > 0;
}
