export interface ScriptRuleDraft {
  name: string;
  hostname: string;
  pathname: string;
  script: string;
  timeoutMs: number;
}

export interface ScriptRuleDialogDraft extends ScriptRuleDraft {
  priority: number;
  enabled: boolean;
}

export function scriptRuleDefinitionSignature(draft: Omit<ScriptRuleDraft, "name">): string {
  return JSON.stringify({
    script: draft.script,
    hostname: draft.hostname,
    pathname: draft.pathname,
    timeoutMs: draft.timeoutMs,
  });
}

export function scriptRuleDialogSignature(draft: ScriptRuleDialogDraft): string {
  return JSON.stringify({
    name: draft.name,
    hostname: draft.hostname,
    pathname: draft.pathname,
    priority: draft.priority,
    enabled: draft.enabled,
    script: draft.script,
    timeoutMs: draft.timeoutMs,
  });
}

export function canSaveScriptRule(input: {
  draft: ScriptRuleDraft;
  editing: boolean;
  initialDefinitionSignature: string;
  lastTestedDefinitionSignature: string;
  testPassed: boolean;
}): boolean {
  const { draft } = input;
  const fieldsAreValid = Boolean(
    draft.name.trim()
    && draft.hostname.trim()
    && draft.pathname.trim()
    && draft.script.trim()
    && Number.isInteger(draft.timeoutMs)
    && draft.timeoutMs >= 1_000
    && draft.timeoutMs <= 60_000,
  );
  if (!fieldsAreValid) return false;

  const signature = scriptRuleDefinitionSignature(draft);
  const definitionIsUnchanged = input.editing && signature === input.initialDefinitionSignature;
  const currentDefinitionWasTested = input.testPassed && signature === input.lastTestedDefinitionSignature;
  return definitionIsUnchanged || currentDefinitionWasTested;
}

export function matchingCheckGroupApplicationId(
  rule: AssistedParserRule,
  options: RuleStudioCheckGroupOption[],
): string {
  const Pattern = (globalThis as unknown as {
    URLPattern?: new (input: { hostname: string; pathname: string }) => { test(input: string | URL): boolean };
  }).URLPattern;
  if (!Pattern) return "";
  let pattern: { test(input: string | URL): boolean };
  try {
    pattern = new Pattern({ hostname: rule.definition.hostname, pathname: rule.definition.pathname });
  } catch {
    return "";
  }
  const normalizedName = rule.name.normalize("NFKC").toLocaleLowerCase();
  return options
    .map((option, index) => {
      if (!pattern.test(option.url)) return null;
      const company = option.company.normalize("NFKC").toLocaleLowerCase();
      const jobTitle = option.jobTitle.normalize("NFKC").toLocaleLowerCase();
      const url = new URL(option.url);
      const score = (company && normalizedName.includes(company) ? 20 : 0)
        + (jobTitle && normalizedName.includes(jobTitle) ? 10 : 0)
        + (rule.definition.hostname === url.hostname ? 4 : 0)
        + (rule.definition.pathname === url.pathname ? 4 : 0);
      return { applicationId: option.applicationId, score, index };
    })
    .filter((item): item is { applicationId: string; score: number; index: number } => Boolean(item))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.applicationId ?? "";
}
import type { AssistedParserRule, RuleStudioCheckGroupOption } from "@application-checker/contracts";
