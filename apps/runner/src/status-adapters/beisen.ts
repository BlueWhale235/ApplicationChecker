import type { AssistedParserRule } from "@application-checker/contracts";
import { executeScriptRule } from "../script-rule.js";
import type { RuntimeStatusAdapter } from "./types.js";

export const BEISEN_API_ADAPTER_SCRIPT = String.raw`
const requireLogin = (reason) => {
  helpers.log("需要重新登录", reason);
  return applications.map((item) => helpers.status("needs_login", {
    applicationId: item.id,
    evidence: reason
  }));
};

const currentUrl = helpers.currentUrl();
if (currentUrl.toLowerCase().includes("login")) {
  return requireLogin("当前页面是登录页：" + currentUrl);
}

let response;
try {
  response = await helpers.axios.post(
    "/api/Submission/GetAllDeliveryRecord",
    {},
    {
      headers: { "Content-Type": "application/json" },
      responseType: "json",
      withCredentials: true,
      timeout: 15000
    }
  );
} catch (error) {
  const status = Number(error?.response?.status || 0);
  const responseUrl = String(error?.response?.url || "");
  if (responseUrl.toLowerCase().includes("login") || status === 401 || status === 403) {
    return requireLogin(
      responseUrl
        ? "接口请求跳转到登录页：" + responseUrl
        : "接口返回 HTTP " + status + "，登录状态可能已失效"
    );
  }
  throw error;
}

if (String(response.url).toLowerCase().includes("login")) {
  return requireLogin("接口被重定向到登录页：" + response.url);
}

const payload = response.data;
if (String(payload?.ReturnUrl || "").toLowerCase().includes("login")) {
  return requireLogin("接口返回登录地址：" + payload.ReturnUrl);
}
if (Number(payload?.Code) !== 200) {
  throw new Error("北森接口调用失败：" + (payload?.Message || "未知错误"));
}

const getDatas = (section) => (section?.Submissions || []).flatMap(
  (submission) => Array.isArray(submission?.Datas) ? submission.Datas : []
);
const records = [
  ...getDatas(payload?.Data?.Finished),
  ...getDatas(payload?.Data?.UnFinished)
];
const uniqueRecords = [...new Map(records.map((record, index) => [
  String(record?.ApplyId ?? record?.Id ?? (record?.JobAdTitle + "-" + record?.DeliveryDate + "-" + index)),
  record
])).values()];

helpers.log("北森投递记录", uniqueRecords.map((record) => ({
  jobTitle: record.JobAdTitle,
  jobCode: record.JobCode,
  status: record.DeliveryStatus,
  deliveryDate: record.DeliveryDate,
  cancelled: record.IsCancel
})));

const normalizeTitle = (value) => String(value || "")
  .normalize("NFKC")
  .toLowerCase()
  .replace(/\s+/g, "")
  .replace(/[·•｜|]/g, "")
  .replace(/[（(]\s*[a-z]?\d+\s*[）)]$/i, "")
  .trim();

return applications.flatMap((item) => {
  const expectedTitle = normalizeTitle(item.jobTitle);
  let matched = uniqueRecords.find((record) => normalizeTitle(record?.JobAdTitle) === expectedTitle);
  if (!matched && expectedTitle.length >= 4) {
    matched = uniqueRecords.find((record) => {
      const actualTitle = normalizeTitle(record?.JobAdTitle);
      return actualTitle.length >= 4 && (
        actualTitle.includes(expectedTitle) || expectedTitle.includes(actualTitle)
      );
    });
  }
  if (!matched) {
    helpers.log("未匹配到北森岗位", item.jobTitle);
    return [];
  }
  let rawStatus = String(matched.DeliveryStatus || "").trim();
  if (matched.IsCancel) rawStatus = "投递已撤销";
  if (!rawStatus) {
    helpers.log("岗位没有返回状态", { jobTitle: matched.JobAdTitle, jobCode: matched.JobCode });
    return [];
  }
  return [{
    applicationId: item.id,
    rawStatus,
    evidence: [
      "北森接口岗位：" + matched.JobAdTitle,
      matched.JobCode ? "岗位编号：" + matched.JobCode : "",
      "投递状态：" + rawStatus,
      matched.DeliveryDate ? "投递时间：" + matched.DeliveryDate : ""
    ].filter(Boolean).join("；")
  }];
});
`;

const now = new Date(0).toISOString();
const rule: AssistedParserRule = {
  id: "builtin-beisen-api",
  name: "内置北森投递记录接口",
  enabled: true,
  priority: 0,
  version: 1,
  definition: {
    schemaVersion: 2,
    kind: "script",
    hostname: "*.zhiye.com",
    pathname: "/*",
    script: BEISEN_API_ADAPTER_SCRIPT,
    timeoutMs: 20_000,
  },
  createdAt: now,
  updatedAt: now,
  lastTestedAt: null,
};

export const beisenRuntimeStatusAdapter: RuntimeStatusAdapter = {
  id: "beisen-api",
  routeAdapterId: "beisen",
  version: 1,
  matches(input) {
    try {
      const hostname = new URL(input).hostname.toLowerCase();
      return hostname === "zhiye.com" || hostname.endsWith(".zhiye.com");
    } catch {
      return false;
    }
  },
  execute({ page, primaryApplicationId, applications }) {
    return executeScriptRule(page, rule, primaryApplicationId, applications);
  },
};
