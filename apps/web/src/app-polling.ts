export interface AppPollingTasks {
  refreshApplications: () => Promise<void>;
  refreshHealth: () => Promise<void>;
  refreshUnreadNotifications: () => Promise<void>;
}

const APPLICATION_POLL_INTERVAL_MS = 30_000;
const LIGHTWEIGHT_POLL_INTERVAL_MS = 5_000;

export function startAppPolling(tasks: AppPollingTasks): () => void {
  let applicationRefreshPending = false;
  const runApplicationRefresh = async (): Promise<void> => {
    if (applicationRefreshPending) return;
    applicationRefreshPending = true;
    try {
      await tasks.refreshApplications();
    } finally {
      applicationRefreshPending = false;
    }
  };
  const safely = (task: () => Promise<void>): void => { void task().catch(() => {}); };
  const applicationTimer = globalThis.setInterval(
    () => safely(runApplicationRefresh),
    APPLICATION_POLL_INTERVAL_MS,
  );
  const lightweightTimer = globalThis.setInterval(() => {
    safely(tasks.refreshHealth);
    safely(tasks.refreshUnreadNotifications);
  }, LIGHTWEIGHT_POLL_INTERVAL_MS);

  return () => {
    globalThis.clearInterval(applicationTimer);
    globalThis.clearInterval(lightweightTimer);
  };
}
