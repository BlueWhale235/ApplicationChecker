import { describe, expect, it } from "vitest";
import {
  formatScriptLogValues,
  SCRIPT_LOG_MAX_ENTRIES,
  ScriptRuleLogCollector,
} from "./script-rule-log.js";

describe("script rule debug logs", () => {
  it("formats primitives, objects and circular references safely", () => {
    const circular: Record<string, unknown> = { status: "面试中" };
    circular.self = circular;
    expect(formatScriptLogValues(["读取状态", 2, true, null, { rawStatus: "待面试" }]))
      .toBe('读取状态 2 true null {"rawStatus":"待面试"}');
    expect(formatScriptLogValues([circular])).toContain('"self":"[Circular]"');
  });

  it("deduplicates streamed logs and keeps relative timestamps", () => {
    const collector = new ScriptRuleLogCollector();
    collector.add({ index: 0, atMs: 12.9, message: "开始" });
    collector.add({ index: 0, atMs: 12.9, message: "重复" });
    expect(collector.snapshot()).toEqual({ logs: [{ atMs: 12, message: "开始" }], logsTruncated: false });
  });

  it("limits single entries, entry count and total output", () => {
    const longEntry = new ScriptRuleLogCollector();
    longEntry.add({ index: 0, atMs: 0, message: "状".repeat(2_000) });
    expect(Buffer.byteLength(longEntry.snapshot().logs[0]!.message, "utf8")).toBeLessThanOrEqual(2_048);
    expect(longEntry.snapshot().logsTruncated).toBe(true);

    const manyEntries = new ScriptRuleLogCollector();
    for (let index = 0; index <= SCRIPT_LOG_MAX_ENTRIES; index += 1) {
      manyEntries.add({ index, atMs: index, message: `log-${index}` });
    }
    expect(manyEntries.snapshot().logs).toHaveLength(SCRIPT_LOG_MAX_ENTRIES);
    expect(manyEntries.snapshot().logsTruncated).toBe(true);

    const largeTotal = new ScriptRuleLogCollector();
    for (let index = 0; index < 20; index += 1) {
      largeTotal.add({ index, atMs: index, message: "x".repeat(2_000) });
    }
    expect(largeTotal.snapshot().logs.length).toBeLessThan(20);
    expect(largeTotal.snapshot().logsTruncated).toBe(true);
  });
});
