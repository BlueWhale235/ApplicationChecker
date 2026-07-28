import type {
  AssistedParserRule,
  AssistedParserRuleDefinition,
  AssistedRuleSelection,
  RuleStudioCheckGroupOption,
} from "@application-checker/contracts";
import { generateAssistedRule, testAssistedRule } from "@application-checker/local-status";
import { parseStatusMappings } from "@application-checker/status-mapping";
import { appSettings } from "../service.js";
import {
  deleteParserRule,
  listParserRules,
  saveParserRule,
  validateDefinition,
} from "../parser-rules.js";
import { httpError } from "./shared.js";
import type { FastifyInstance, RouteDeps } from "./shared.js";

function requireDebug(deps: RouteDeps) {
  if (!deps.config.debugTools || !deps.recognitionPreviewStore) throw httpError(404, "规则工作台未启用");
  return deps.recognitionPreviewStore;
}

export async function registerParserRuleController(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { context } = deps;

  app.get("/debug/parser-rules", async () => {
    requireDebug(deps);
    return listParserRules(context);
  });

  app.get("/debug/parser-rules/check-groups", async (request) => {
    requireDebug(deps);
    const query = (request.query as { q?: string; limit?: string }).q?.trim().slice(0, 100) ?? "";
    const limit = Math.min(50, Math.max(1, Number((request.query as { limit?: string }).limit) || 30));
    const like = `%${query}%`;
    const rows = context.raw.prepare(`
      SELECT
        applications.id AS application_id,
        COALESCE(check_groups.id, applications.id) AS group_id,
        COALESCE(check_groups.company, applications.company) AS company,
        applications.job_title,
        applications.site,
        COALESCE(check_groups.resolved_url, applications.resolved_url, check_groups.check_url, applications.check_url) AS url,
        (
          SELECT COUNT(1)
          FROM applications AS members
          WHERE COALESCE(members.check_group_id, members.id) = COALESCE(check_groups.id, applications.id)
        ) AS member_count
      FROM applications
      LEFT JOIN check_groups ON check_groups.id = applications.check_group_id
      WHERE COALESCE(check_groups.resolved_url, applications.resolved_url, check_groups.check_url, applications.check_url) <> ''
        AND (
          ? = ''
          OR COALESCE(check_groups.company, applications.company) LIKE ?
          OR applications.job_title LIKE ?
          OR applications.site LIKE ?
          OR COALESCE(check_groups.resolved_url, applications.resolved_url, check_groups.check_url, applications.check_url) LIKE ?
        )
      GROUP BY COALESCE(check_groups.id, applications.id)
      ORDER BY COALESCE(check_groups.updated_at, applications.updated_at) DESC
      LIMIT ?
    `).all(query, like, like, like, like, limit) as Array<{
      application_id: string;
      group_id: string;
      company: string;
      job_title: string;
      site: string;
      url: string;
      member_count: number;
    }>;
    return rows.map((row): RuleStudioCheckGroupOption => ({
      applicationId: row.application_id,
      groupId: row.group_id,
      company: row.company,
      jobTitle: row.job_title,
      site: row.site,
      url: row.url,
      memberCount: Number(row.member_count),
    }));
  });

  app.post("/debug/parser-rules/generate", async (request) => {
    const store = requireDebug(deps);
    const body = request.body as { previewId?: string; selection?: AssistedRuleSelection };
    if (!body.previewId || !body.selection) throw httpError(400, "previewId 和 selection 不能为空");
    const preview = store.snapshot(body.previewId);
    if (!preview) throw httpError(404, "预览快照不存在");
    return generateAssistedRule(preview.snapshot, body.selection);
  });

  app.post("/debug/parser-rules/test", async (request) => {
    const store = requireDebug(deps);
    const body = request.body as { previewId?: string; rule?: AssistedParserRule };
    if (!body.previewId || !body.rule) throw httpError(400, "previewId 和 rule 不能为空");
    const preview = store.snapshot(body.previewId);
    if (!preview) throw httpError(404, "预览快照不存在");
    validateDefinition(body.rule.definition);
    const settings = await appSettings(context);
    return testAssistedRule(
      preview.snapshot,
      preview.applications,
      { ...body.rule, enabled: true },
      parseStatusMappings(settings.status_mappings),
    );
  });

  app.post("/debug/parser-rules", async (request) => {
    requireDebug(deps);
    const body = request.body as {
      name?: string;
      enabled?: boolean;
      priority?: number;
      definition?: AssistedParserRuleDefinition;
      tested?: boolean;
    };
    if (!body.name || !body.definition) throw httpError(400, "规则名称和定义不能为空");
    try {
      return await saveParserRule(context, {
        name: body.name,
        definition: body.definition,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.tested !== undefined ? { tested: body.tested } : {}),
      });
    } catch (error) {
      throw httpError(400, error instanceof Error ? error.message : "规则保存失败");
    }
  });

  app.put("/debug/parser-rules/:id", async (request) => {
    requireDebug(deps);
    const id = (request.params as { id: string }).id;
    const body = request.body as {
      name?: string;
      enabled?: boolean;
      priority?: number;
      definition?: AssistedParserRuleDefinition;
      tested?: boolean;
    };
    if (!body.name || !body.definition) throw httpError(400, "规则名称和定义不能为空");
    try {
      return await saveParserRule(context, {
        id,
        name: body.name,
        definition: body.definition,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.tested !== undefined ? { tested: body.tested } : {}),
      });
    } catch (error) {
      throw httpError(400, error instanceof Error ? error.message : "规则更新失败");
    }
  });

  app.post("/debug/parser-rules/:id/delete", async (request) => {
    requireDebug(deps);
    const deleted = await deleteParserRule(context, (request.params as { id: string }).id);
    if (!deleted) throw httpError(404, "规则不存在");
    return { deleted: 1 };
  });

  app.get("/debug/parser-rules/export", async () => {
    requireDebug(deps);
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), rules: await listParserRules(context) };
  });

  app.post("/debug/parser-rules/import", async (request) => {
    requireDebug(deps);
    const body = request.body as { schemaVersion?: number; rules?: AssistedParserRule[]; confirm?: boolean };
    if (body.schemaVersion !== 1 || !Array.isArray(body.rules)) throw httpError(400, "规则文件格式不正确");
    const existing = await listParserRules(context);
    const conflicts: string[] = [];
    const accepted = body.rules.filter((rule) => {
      try {
        validateDefinition(rule.definition);
        const conflict = existing.some((item) =>
          item.definition.hostname === rule.definition.hostname
          && item.definition.pathname === rule.definition.pathname
          && item.priority === rule.priority);
        if (conflict) conflicts.push(rule.name);
        return !conflict;
      } catch {
        conflicts.push(rule.name || "未命名规则");
        return false;
      }
    });
    if (!body.confirm) return { added: accepted.length, skipped: conflicts.length, conflicts };
    let added = 0;
    for (const rule of accepted) {
      await saveParserRule(context, {
        name: rule.name,
        enabled: rule.enabled,
        priority: rule.priority,
        definition: rule.definition,
      });
      added += 1;
    }
    return { added, skipped: conflicts.length, conflicts };
  });
}
