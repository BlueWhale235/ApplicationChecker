import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistedParserRuleDefinition } from "@application-checker/contracts";
import { createDb, type DbContext } from "./db.js";
import { deleteParserRule, listParserRules, saveParserRule, validateDefinition } from "./parser-rules.js";

const folders: string[] = [];
const contexts: DbContext[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.db.destroy();
    context.raw.close();
  }
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const definition: AssistedParserRuleDefinition = {
  schemaVersion: 2,
  kind: "selector",
  hostname: "careers.example.com",
  pathname: "/applications/*",
  container: {
    tag: "div", role: null, classes: ["application-card"], dataStatus: null,
    ariaCurrent: null, ariaSelected: null, ancestorTags: ["main"],
  },
  title: {
    tag: "h3", role: null, classes: ["job-title"], dataStatus: null,
    ariaCurrent: null, ariaSelected: null, ancestorTags: ["main", "div"],
  },
  status: {
    tag: "span", role: null, classes: ["status"], dataStatus: null,
    ariaCurrent: null, ariaSelected: null, ancestorTags: ["main", "div"],
  },
};

async function setup(): Promise<DbContext> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "parser-rules-"));
  folders.push(folder);
  const context = createDb(path.join(folder, "test.sqlite"));
  contexts.push(context);
  return context;
}

describe("parser rule persistence", () => {
  it("persists, updates and deletes versioned declarative rules", async () => {
    const context = await setup();
    const created = await saveParserRule(context, {
      name: "Example",
      definition,
      tested: true,
    });
    expect(created).toMatchObject({ name: "Example", enabled: true, version: 1 });
    expect(JSON.stringify(created)).not.toContain("Cookie");

    const updated = await saveParserRule(context, {
      id: created.id,
      name: "Example disabled",
      enabled: false,
      priority: 90,
      definition,
    });
    expect(updated).toMatchObject({ enabled: false, priority: 90, version: 2 });
    expect(await listParserRules(context, true)).toEqual([]);
    expect(await deleteParserRule(context, created.id)).toBe(true);
    expect(await listParserRules(context)).toEqual([]);
  });

  it("rejects rules with the same scope and priority", async () => {
    const context = await setup();
    await saveParserRule(context, { name: "A", definition, priority: 100 });
    await expect(saveParserRule(context, { name: "B", definition, priority: 100 }))
      .rejects.toThrow(/已存在/);
  });

  it("validates and persists a bounded page script rule", async () => {
    const context = await setup();
    const scriptDefinition: AssistedParserRuleDefinition = {
      schemaVersion: 2,
      kind: "script",
      hostname: "careers.example.com",
      pathname: "/query/*",
      script: "return { applicationId: application.id, rawStatus: helpers.text('.status') };",
      timeoutMs: 8_000,
    };
    validateDefinition(scriptDefinition);
    const created = await saveParserRule(context, { name: "Query script", definition: scriptDefinition, tested: true });
    expect(created.definition).toEqual(scriptDefinition);
    expect(() => validateDefinition({ ...scriptDefinition, timeoutMs: 60_000 })).not.toThrow();
    expect(() => validateDefinition({ ...scriptDefinition, timeoutMs: 60_001 })).toThrow(/超时时间/);
  });
});
