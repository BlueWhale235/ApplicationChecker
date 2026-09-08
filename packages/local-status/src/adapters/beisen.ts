import { LOCAL_PARSER_VERSION, type ParserAdapter } from "./types.js";

export const beisenAdapter: ParserAdapter = {
  id: "beisen",
  version: LOCAL_PARSER_VERSION,
  priority: 100,
  routes: [
    { hostname: "zhiye.com", pathname: "/*" },
    { hostname: "*.zhiye.com", pathname: "/*" },
  ],
  domFeatures: ["zhiye", "beisen", "北森"],
  containerHints: ["resume", "application", "delivery", "process", "progress"],
};
