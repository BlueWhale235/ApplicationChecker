import { describe, expect, it } from "vitest";
import { SCRIPT_EDITOR_EXTRA_LIB } from "./monaco-script-types";

describe("Monaco script API declarations", () => {
  it("exposes the application globals and every supported helper", () => {
    expect(SCRIPT_EDITOR_EXTRA_LIB).toContain("declare const application");
    expect(SCRIPT_EDITOR_EXTRA_LIB).toContain("declare const applications");
    expect(SCRIPT_EDITOR_EXTRA_LIB).toContain("declare const helpers");

    for (const helper of [
      "currentUrl", "goto", "log", "status", "statusAll", "error", "errorAll", "runSelectorRule", "text", "texts", "textsWithin", "value", "attr", "nextText",
      "closestText", "exists", "count", "fill", "select", "click",
      "waitForSelector", "waitForText", "waitForTextChange", "scrollIntoView", "sleep",
    ]) {
      expect(SCRIPT_EDITOR_EXTRA_LIB).toContain(`${helper}(`);
    }
    expect(SCRIPT_EDITOR_EXTRA_LIB).toContain("readonly axios: ScriptAxios");
    expect(SCRIPT_EDITOR_EXTRA_LIB).toContain("get<T = unknown>");
  });

  it("provides Chinese hover documentation for fields and helpers", () => {
    expect(SCRIPT_EDITOR_EXTRA_LIB).toContain("页面脚本可使用的受控 DOM 操作与调试 API");
    expect(SCRIPT_EDITOR_EXTRA_LIB).toContain("等待元素出现；默认 5 秒");
    expect(SCRIPT_EDITOR_EXTRA_LIB).toContain("岗位 ID；返回识别结果时用作 applicationId");
  });
});
