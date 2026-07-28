import { randomUUID } from "node:crypto";
import type {
  AssistedParserRule,
  AssistedParserRuleDefinition,
} from "@application-checker/contracts";
import type { DbContext, ParserRulesTable } from "./db.js";

function definitionFromJson(value: string): AssistedParserRuleDefinition {
  const definition = JSON.parse(value) as AssistedParserRuleDefinition;
  validateDefinition(definition);
  return definition;
}

export function validateDefinition(value: AssistedParserRuleDefinition): void {
  if (value.schemaVersion !== 1) throw new Error("不支持的规则版本");
  if (!["list", "stepper"].includes(value.layout)) throw new Error("不支持的页面模板");
  if (!value.hostname || !value.pathname) throw new Error("hostname 和 pathname 不能为空");
  if (/[\r\n{};]/.test(`${value.hostname}${value.pathname}`)) throw new Error("Path 规则包含非法字符");
  const Pattern = (globalThis as unknown as {
    URLPattern?: new (input: { hostname: string; pathname: string }) => unknown;
  }).URLPattern;
  if (!Pattern) throw new Error("规则工作台需要 Node.js 24 或更高版本");
  new Pattern({ hostname: value.hostname, pathname: value.pathname });
  for (const locator of [value.container, value.title, value.status, value.active]) {
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
