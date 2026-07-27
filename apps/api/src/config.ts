import path from "node:path";

export interface Config {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  dataPath: string;
  databasePath: string;
  screenshotsPath: string;
  runtimeSettingsPath: string;
  appBaseUrl: string;
  runnerUrl: string;
  runnerToken: string;
  stateKey: Buffer;
  upstreamProxyUrl: string | null;
  aiBaseUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  aiConfidenceThreshold: number;
  webDistPath: string | null;
  desktopMode: boolean;
  desktopSessionToken: string | null;
  debugTools: boolean;
}

function requiredSecret(name: string, value: string | undefined, fallback: string): string {
  const chosen = value || fallback;
  if (Buffer.byteLength(chosen) < 32) throw new Error(`${name} must contain at least 32 bytes`);
  return chosen;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV ?? "development") as Config["nodeEnv"];
  const dataPath = path.resolve(env.DATA_PATH ?? "./data");
  const runnerToken = requiredSecret(
    "RUNNER_INTERNAL_TOKEN",
    env.RUNNER_INTERNAL_TOKEN,
    nodeEnv === "production" ? "" : "development-runner-token-change-me-123456",
  );
  const defaultKey = Buffer.alloc(32, 11).toString("base64");
  const stateKey = Buffer.from(env.STATE_ENCRYPTION_KEY || (nodeEnv === "production" ? "" : defaultKey), "base64");
  if (stateKey.length !== 32) throw new Error("STATE_ENCRYPTION_KEY must be base64 for exactly 32 bytes");
  const confidence = Number(env.AI_CONFIDENCE_THRESHOLD ?? 0.75);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("AI_CONFIDENCE_THRESHOLD must be between 0 and 1");
  const desktopMode = env.DESKTOP_MODE === "1";
  const desktopSessionToken = env.DESKTOP_SESSION_TOKEN?.trim() || null;
  if (desktopMode && (!desktopSessionToken || Buffer.byteLength(desktopSessionToken) < 32)) {
    throw new Error("DESKTOP_SESSION_TOKEN must contain at least 32 bytes in desktop mode");
  }
  return {
    nodeEnv,
    host: env.WEB_HOST ?? "127.0.0.1",
    port: Number(env.WEB_PORT ?? 8080),
    dataPath,
    databasePath: path.join(dataPath, "application-checker.sqlite"),
    screenshotsPath: path.join(dataPath, "screenshots"),
    runtimeSettingsPath: path.join(dataPath, "runtime-settings.json"),
    appBaseUrl: (env.APP_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, ""),
    runnerUrl: (env.RUNNER_URL ?? "http://127.0.0.1:8090").replace(/\/$/, ""),
    runnerToken,
    stateKey,
    upstreamProxyUrl: env.UPSTREAM_PROXY_URL?.trim() || null,
    ...(env.AI_BASE_URL ? { aiBaseUrl: env.AI_BASE_URL } : {}),
    ...(env.AI_API_KEY ? { aiApiKey: env.AI_API_KEY } : {}),
    ...(env.AI_MODEL ? { aiModel: env.AI_MODEL } : {}),
    aiConfidenceThreshold: confidence,
    webDistPath: env.WEB_DIST_PATH ? path.resolve(env.WEB_DIST_PATH) : null,
    desktopMode,
    desktopSessionToken,
    debugTools: nodeEnv === "development" || env.DEBUG_TOOLS === "1",
  };
}
