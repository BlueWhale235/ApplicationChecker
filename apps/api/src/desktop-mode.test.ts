import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createDb, type DbContext } from "./db.js";
import { registerRoutes } from "./routes.js";

const folders: string[] = [];
const contexts: DbContext[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.db.destroy();
    context.raw.close();
  }
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("desktop mode", () => {
  it("protects public API routes while allowing health checks and bearer-authorized runner routes", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "application-checker-desktop-"));
    folders.push(folder);
    const desktopToken = "desktop-session-token-with-at-least-32-bytes";
    const runnerToken = "runner-internal-token-with-at-least-32-bytes";
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_PATH: folder,
      RUNNER_INTERNAL_TOKEN: runnerToken,
      STATE_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
      DESKTOP_MODE: "1",
      DESKTOP_SESSION_TOKEN: desktopToken,
    });
    const context = createDb(config.databasePath);
    contexts.push(context);
    const app = Fastify();
    await app.register(cookie);
    await app.register(async (api) => {
      await registerRoutes(api, { context, config, runnerHeartbeat: { at: 0 } });
    }, { prefix: "/api" });

    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(401);

    const settings = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: `ac_desktop=${desktopToken}` },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      loginPresentation: "external-window",
      statusMappings: {
        screening: expect.arrayContaining(["简历筛选", "under review"]),
        screening_passed: expect.arrayContaining(["业务筛选", "shortlisted"]),
        rejected: expect.arrayContaining(["淘汰", "rejected"]),
      },
    });

    const customMappings = {
      screening: ["HR Review"],
      screening_passed: ["HR Approved"],
      interview_pending: [],
      interviewed: [],
      signing_pending: [],
      offer: [],
      rejected: ["Position Closed"],
    };
    const updateMappings = await app.inject({
      method: "POST",
      url: "/api/settings/status-mappings/update",
      headers: { cookie: `ac_desktop=${desktopToken}` },
      payload: { statusMappings: customMappings },
    });
    expect(updateMappings.statusCode).toBe(200);
    expect(updateMappings.json()).toMatchObject({ statusMappings: customMappings });
    const storedMappings = context.raw.prepare("SELECT status_mappings FROM app_settings WHERE id = 1").get() as {
      status_mappings: string;
    };
    expect(JSON.parse(storedMappings.status_mappings)).toMatchObject(customMappings);

    const conflictingMappings = await app.inject({
      method: "POST",
      url: "/api/settings/status-mappings/update",
      headers: { cookie: `ac_desktop=${desktopToken}` },
      payload: { statusMappings: { ...customMappings, screening: ["Position Closed"] } },
    });
    expect(conflictingMappings.statusCode).toBe(400);

    expect((await app.inject({ method: "POST", url: "/api/internal/heartbeat" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/api/internal/heartbeat",
      headers: { authorization: `Bearer ${runnerToken}` },
    })).statusCode).toBe(200);
    await app.close();
  });
});
