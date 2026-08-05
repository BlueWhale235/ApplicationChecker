import { describe, expect, it } from "vitest";
import appSource from "../App.vue?raw";
import monacoEditorSource from "../components/MonacoScriptEditor.vue?raw";
import workbenchSource from "./RuleStudioPage.vue?raw";

describe("rule studio lazy loading", () => {
  it("keeps the workbench out of the application startup bundle", () => {
    expect(appSource).toContain('defineAsyncComponent(() => import("./pages/RuleStudioPage.vue"))');
    expect(appSource).not.toMatch(/import\s+RuleStudioPage\s+from/);
  });

  it("loads the script dialog and Monaco runtime only on demand", () => {
    expect(workbenchSource).toContain('defineAsyncComponent(() => import("../components/ScriptRuleEditorDialog.vue"))');
    expect(monacoEditorSource).toContain('import("monaco-editor/editor/editor.api")');
    expect(monacoEditorSource).not.toMatch(/^import\s+\*\s+as\s+monaco/m);
  });
});
