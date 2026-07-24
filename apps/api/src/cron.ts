import { CronExpressionParser } from "cron-parser";
import type { ScheduleMode } from "@application-checker/contracts";

export function validateCron(expression: string, timezone: string): void {
  CronExpressionParser.parse(expression, { tz: timezone });
}

export function nextCronAt(expression: string, timezone: string, after = new Date()): string {
  return CronExpressionParser.parse(expression, { currentDate: after, tz: timezone }).next().toDate().toISOString();
}

export function effectiveCron(
  application: { schedule_mode: ScheduleMode; cron_expression: string | null },
  globalCron: string | null,
): string | null {
  if (application.schedule_mode === "manual") return null;
  return application.schedule_mode === "custom" ? application.cron_expression : globalCron;
}
