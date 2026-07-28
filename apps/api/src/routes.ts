import type { FastifyInstance } from "fastify";
import {
  registerApplicationController,
  registerCoreController,
  registerLoginController,
  registerNotificationSettingsController,
  registerRunController,
  registerRunnerController,
  type RouteDeps,
} from "./controllers/index.js";

export type { RouteDeps } from "./controllers/index.js";
export { authorizeVncRequest, exchangeRemoteLogin } from "./controllers/index.js";

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  await registerCoreController(app, deps);
  await registerApplicationController(app, deps);
  await registerRunController(app, deps);
  await registerNotificationSettingsController(app, deps);
  await registerLoginController(app, deps);
  await registerRunnerController(app, deps);
}
