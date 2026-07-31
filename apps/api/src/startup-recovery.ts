import type { DbContext } from "./db.js";

export interface StartupRecoveryResult {
  runsRequeued: number;
  loginSessionsFailed: number;
  applicationStatusesRepaired: number;
}

export async function recoverInterruptedWork(context: DbContext): Promise<StartupRecoveryResult> {
  const now = new Date().toISOString();
  return context.db.transaction().execute(async (trx) => {
    const interruptedRuns = await trx.selectFrom("runs")
      .select(["id", "check_group_id", "application_id"])
      .where("status", "=", "running")
      .execute();

    if (interruptedRuns.length) {
      const runIds = interruptedRuns.map((run) => run.id);
      await trx.updateTable("runs").set({
        status: "queued",
        started_at: null,
        completed_at: null,
        error_code: "RECOVERED_AFTER_RESTART",
        error_message: "程序上次退出时任务仍在执行，已自动重新排队",
        recognition_status: "pending",
      }).where("id", "in", runIds).execute();

      const groupIds = [...new Set(interruptedRuns
        .map((run) => run.check_group_id)
        .filter((id): id is string => Boolean(id)))];
      if (groupIds.length) {
        await trx.updateTable("applications").set({ last_run_status: "queued", updated_at: now })
          .where("check_group_id", "in", groupIds).execute();
      }
      const legacyApplicationIds = interruptedRuns
        .filter((run) => !run.check_group_id)
        .map((run) => run.application_id);
      if (legacyApplicationIds.length) {
        await trx.updateTable("applications").set({ last_run_status: "queued", updated_at: now })
          .where("id", "in", legacyApplicationIds).execute();
      }
    }

    const activeApplications = await trx.selectFrom("applications")
      .select(["id", "check_group_id"])
      .where("last_run_status", "in", ["queued", "running", "needs_login"])
      .execute();
    const activeRuns = await trx.selectFrom("runs")
      .select(["application_id", "check_group_id"])
      .where("status", "in", ["queued", "running", "needs_login"])
      .execute();
    const activeGroupIds = new Set(activeRuns
      .map((run) => run.check_group_id)
      .filter((id): id is string => Boolean(id)));
    const activeLegacyApplicationIds = new Set(activeRuns
      .filter((run) => !run.check_group_id)
      .map((run) => run.application_id));
    const orphanedApplicationIds = activeApplications
      .filter((application) => application.check_group_id
        ? !activeGroupIds.has(application.check_group_id)
        : !activeLegacyApplicationIds.has(application.id))
      .map((application) => application.id);

    if (orphanedApplicationIds.length) {
      await trx.updateTable("applications").set({
        last_run_status: null,
        last_run_at: null,
        updated_at: now,
      }).where("id", "in", orphanedApplicationIds).execute();
    }

    const failedSessions = await trx.updateTable("login_sessions").set({
      status: "failed",
      error_message: "程序重启，原登录窗口已关闭，请重新打开登录",
      updated_at: now,
      completed_at: now,
    }).where("status", "in", ["starting", "ready", "active", "saving"]).executeTakeFirst();

    return {
      runsRequeued: interruptedRuns.length,
      loginSessionsFailed: Number(failedSessions.numUpdatedRows),
      applicationStatusesRepaired: orphanedApplicationIds.length,
    };
  });
}
