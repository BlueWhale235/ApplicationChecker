import type { ParserAdapter } from "./types.js";

export const MOKAHR_PARSER_VERSION = "1.0.2";

export const mokahrAdapter: ParserAdapter = {
  id: "mokahr",
  version: MOKAHR_PARSER_VERSION,
  priority: 100,
  routes: [
    { hostname: "mokahr.com", pathname: "/campus-recruitment/*" },
    { hostname: "*.mokahr.com", pathname: "/campus-recruitment/*" },
    { hostname: "mokahr.com", pathname: "/campus_apply/*" },
    { hostname: "*.mokahr.com", pathname: "/campus_apply/*" },
    { hostname: "mokahr.com", pathname: "/candidate/applications/deliver-query/*" },
    { hostname: "*.mokahr.com", pathname: "/candidate/applications/deliver-query/*" },
    { hostname: "mokahr.com", pathname: "/*" },
    { hostname: "*.mokahr.com", pathname: "/*" },
  ],
  domFeatures: ["mokahr", "moka", "Moka"],
  containerHints: ["preference", "application", "delivery", "process", "progress", "resume"],
};
