import { LOCAL_PARSER_VERSION, type ParserAdapter } from "./types.js";

export const feishuAdapter: ParserAdapter = {
  id: "feishu",
  version: LOCAL_PARSER_VERSION,
  priority: 100,
  routes: [
    { hostname: "feishu.cn", pathname: "/*" },
    { hostname: "*.feishu.cn", pathname: "/*" },
  ],
  domFeatures: ["feishu", "atsx", "飞书招聘"],
  containerHints: ["application", "delivery", "process", "progress"],
};
