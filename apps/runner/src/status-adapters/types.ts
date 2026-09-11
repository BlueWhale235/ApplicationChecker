import type { Page } from "puppeteer-core";
import type {
  BuiltinParserAdapterId,
  ScriptRuleApplication,
  ScriptRuleExecution,
} from "@application-checker/contracts";

export interface RuntimeStatusAdapterContext {
  page: Page;
  primaryApplicationId: string;
  applications: ScriptRuleApplication[];
}

export interface RuntimeStatusAdapter {
  id: string;
  routeAdapterId: BuiltinParserAdapterId;
  version: number;
  matches(url: string): boolean;
  execute(context: RuntimeStatusAdapterContext): Promise<ScriptRuleExecution>;
}
