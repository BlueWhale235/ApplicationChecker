import type { Page } from "puppeteer-core";
import type { ScriptRuleApplication, ScriptRuleExecution } from "@application-checker/contracts";
import { beisenRuntimeStatusAdapter } from "./beisen.js";
import type { RuntimeStatusAdapter } from "./types.js";

const adapters: RuntimeStatusAdapter[] = [beisenRuntimeStatusAdapter];

export function resolveRuntimeStatusAdapter(url: string): RuntimeStatusAdapter | null {
  return adapters.find((adapter) => adapter.matches(url)) ?? null;
}

export async function executeRuntimeStatusAdapter(input: {
  page: Page;
  primaryApplicationId: string;
  applications: ScriptRuleApplication[];
}): Promise<ScriptRuleExecution | null> {
  const adapter = resolveRuntimeStatusAdapter(input.page.url());
  return adapter ? adapter.execute(input) : null;
}

export const runtimeStatusAdapters = adapters;
