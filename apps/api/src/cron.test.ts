import { describe, expect, it } from "vitest";
import { effectiveCron, nextCronAt, validateCron } from "./cron.js";

describe("cron scheduling", () => {
  it("uses per-application schedule precedence", () => {
    expect(effectiveCron({ schedule_mode: "manual", cron_expression: null }, "0 9 * * *")).toBeNull();
    expect(effectiveCron({ schedule_mode: "inherit", cron_expression: null }, "0 9 * * *")).toBe("0 9 * * *");
    expect(effectiveCron({ schedule_mode: "custom", cron_expression: "30 8 * * 1" }, "0 9 * * *")).toBe("30 8 * * 1");
  });

  it("calculates a timezone-aware next run", () => {
    validateCron("0 9 * * *", "Asia/Shanghai");
    expect(nextCronAt("0 9 * * *", "Asia/Shanghai", new Date("2026-07-24T00:30:00Z"))).toBe("2026-07-24T01:00:00.000Z");
  });
});
