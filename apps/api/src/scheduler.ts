import type { Config } from "./config.js";
import type { DbContext } from "./db.js";
import { calculateNextRun, cleanupExpiredScreenshots, queueRun } from "./service.js";

function localClock(now: Date, timezone: string): { date: string; hour: number; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function startScheduler(context: DbContext, config: Config): () => void {
  let running = false;
  let lastCleanupDate = "";
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const due = await context.db.selectFrom("check_groups")
        .select(["id", "schedule_mode", "cron_expression"])
        .where("next_run_at", "<=", now.toISOString())
        .execute();
      for (const row of due) {
        const representative = await context.db.selectFrom("applications").select("id")
          .where("check_group_id", "=", row.id).where("automation_paused", "=", 0).orderBy("created_at").executeTakeFirst();
        if (!representative) continue;
        await queueRun(context, representative.id, "cron");
        const next = await calculateNextRun(context, row, now);
        await context.db.transaction().execute(async (trx) => {
          await trx.updateTable("check_groups").set({ next_run_at: next, updated_at: now.toISOString() })
            .where("id", "=", row.id).execute();
          await trx.updateTable("applications").set({ next_run_at: next, updated_at: now.toISOString() })
            .where("check_group_id", "=", row.id).where("automation_paused", "=", 0).execute();
        });
      }
      await context.db.updateTable("login_sessions").set({
        status: "expired",
        completed_at: now.toISOString(),
        updated_at: now.toISOString(),
      }).where("expires_at", "<=", now.toISOString())
        .where("status", "in", ["queued", "starting", "ready", "active", "saving"])
        .execute();
      const settings = await context.db.selectFrom("app_settings").select(["timezone", "screenshot_retention_days"])
        .where("id", "=", 1).executeTakeFirstOrThrow();
      const local = localClock(now, settings.timezone);
      if (local.hour === 3 && local.minute >= 15 && lastCleanupDate !== local.date) {
        await cleanupExpiredScreenshots(context, config, settings.screenshot_retention_days, now);
        lastCleanupDate = local.date;
      }
    } finally {
      running = false;
    }
  };
  const runTick = () => {
    void tick().catch((error) => console.error("Scheduler tick failed", error));
  };
  void cleanupExpiredScreenshots(context, config).catch(() => {});
  runTick();
  const timer = setInterval(runTick, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
