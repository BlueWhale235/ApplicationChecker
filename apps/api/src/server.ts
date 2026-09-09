import "dotenv/config";
import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import proxy from "@fastify/http-proxy";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { authorizeVncRequest, exchangeRemoteLogin, registerRoutes } from "./routes.js";
import { initializeRuntimeSettings } from "./runtime-settings.js";
import { startScheduler } from "./scheduler.js";
import { AiDebugStore } from "./ai-debug.js";
import { RecognitionPreviewStore } from "./recognition-preview.js";
import { recoverInterruptedWork } from "./startup-recovery.js";
import { DataTransferService, verifyStateEncryptionKey } from "./data-transfer.js";

const config = loadConfig();
const context = createDb(config.databasePath);
await verifyStateEncryptionKey(context, config);
await initializeRuntimeSettings(context, config);
const recovery = await recoverInterruptedWork(context);
if (recovery.runsRequeued || recovery.loginSessionsFailed || recovery.applicationStatusesRepaired) {
  console.warn(`[startup-recovery] requeued ${recovery.runsRequeued} run(s), closed ${recovery.loginSessionsFailed} login session(s), repaired ${recovery.applicationStatusesRepaired} application status(es)`);
}
const runnerHeartbeat = { at: 0 };
const aiDebugStore = config.debugTools ? new AiDebugStore() : undefined;
const recognitionPreviewStore = new RecognitionPreviewStore();
const maintenance = { active: false };
const dataTransfer = new DataTransferService(context, config, maintenance);
const app = Fastify({
  logger: { level: "warn" },
  logController: new LogController({ disableRequestLogging: true }),
  bodyLimit: 35 * 1024 * 1024,
});
await app.register(cookie);
await app.register(multipart, {
  limits: { files: 1, fields: 2, fileSize: 4 * 1024 * 1024 * 1024 },
});
app.setErrorHandler((error, _request, reply) => {
  const failure = error instanceof Error ? error : new Error("Unknown server error");
  const status = "statusCode" in failure && typeof failure.statusCode === "number" ? failure.statusCode : 500;
  if (status >= 500) app.log.error(error);
  void reply.code(status).send({ error: failure.message });
});

await app.register(async (api) => {
  api.addHook("preHandler", async (request) => {
    if (!maintenance.active || request.method === "GET" || request.url.startsWith("/internal/heartbeat")) return;
    throw Object.assign(new Error("数据导入正在进行，请稍后重试"), { statusCode: 503 });
  });
  await registerRoutes(api, {
    context,
    config,
    runnerHeartbeat,
    ...(aiDebugStore ? { aiDebugStore } : {}),
    recognitionPreviewStore,
    maintenance,
    dataTransfer,
  });
}, { prefix: "/api" });

if (!config.desktopMode) {
app.get("/remote-login/:id", async (request, reply) => exchangeRemoteLogin(request, reply, context));

await app.register(async (vnc) => {
  vnc.addHook("onRequest", async (request, reply) => {
    if (!await authorizeVncRequest(request, context)) return reply.code(401).send("远程登录会话已失效");
  });
  await vnc.register(proxy, {
    upstream: config.runnerUrl,
    prefix: "/vnc",
    rewritePrefix: "",
    websocket: true,
  });
});
}

const webRoot = config.webDistPath && existsSync(config.webDistPath)
  ? config.webDistPath
  : path.resolve("apps/web/dist");
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/vnc/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

const stopScheduler = startScheduler(context, config, maintenance);
const transferCleanupTimer = setInterval(() => void dataTransfer.cleanupExpired().catch(() => {}), 60_000);
transferCleanupTimer.unref();
await app.listen({ host: config.host, port: config.port });

async function shutdown() {
  stopScheduler();
  clearInterval(transferCleanupTimer);
  await app.close();
  await context.db.destroy();
  context.raw.close();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
