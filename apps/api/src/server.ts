import "dotenv/config";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
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

const config = loadConfig();
const context = createDb(config.databasePath);
await initializeRuntimeSettings(context, config);
const recovery = await recoverInterruptedWork(context);
if (recovery.runsRequeued || recovery.loginSessionsFailed || recovery.applicationStatusesRepaired) {
  console.warn(`[startup-recovery] requeued ${recovery.runsRequeued} run(s), closed ${recovery.loginSessionsFailed} login session(s), repaired ${recovery.applicationStatusesRepaired} application status(es)`);
}
const runnerHeartbeat = { at: 0 };
const aiDebugStore = config.debugTools ? new AiDebugStore() : undefined;
const recognitionPreviewStore = new RecognitionPreviewStore();
const app = Fastify({
  logger: { level: "warn" },
  disableRequestLogging: true,
  bodyLimit: 35 * 1024 * 1024,
});
await app.register(cookie);
app.setErrorHandler((error, _request, reply) => {
  const failure = error instanceof Error ? error : new Error("Unknown server error");
  const status = "statusCode" in failure && typeof failure.statusCode === "number" ? failure.statusCode : 500;
  if (status >= 500) app.log.error(error);
  void reply.code(status).send({ error: failure.message });
});

await app.register(async (api) => {
  await registerRoutes(api, {
    context,
    config,
    runnerHeartbeat,
    ...(aiDebugStore ? { aiDebugStore } : {}),
    recognitionPreviewStore,
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

const stopScheduler = startScheduler(context, config);
await app.listen({ host: config.host, port: config.port });

async function shutdown() {
  stopScheduler();
  await app.close();
  await context.db.destroy();
  context.raw.close();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
