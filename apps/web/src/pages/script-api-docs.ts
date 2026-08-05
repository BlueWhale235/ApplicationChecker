export type ScriptApiSectionId = "data" | "helpers" | "result";

export interface ScriptApiEntry {
  signature: string;
  description: string;
  detail?: string;
  example?: string;
}

export interface ScriptApiSection {
  id: ScriptApiSectionId;
  title: string;
  subtitle: string;
  entries: ScriptApiEntry[];
}

const applicationFields: ScriptApiEntry[] = [
  { signature: "application", description: "当前检查组的主投递记录（只读）", detail: "字段结构与 applications 中的单条记录相同。" },
  { signature: "applications", description: "当前页面所属检查组的全部投递记录（只读数组）", example: "applications.map(item => item.jobTitle)" },
  { signature: "id: string", description: "岗位 ID；返回识别结果时用作 applicationId" },
  { signature: "company: string", description: "公司名称" },
  { signature: "jobTitle: string", description: "岗位名称" },
  { signature: "checkUrl: string | null", description: "检查链接" },
  { signature: "postingUrl: string | null", description: "投递链接" },
  { signature: "appliedAt: string | null", description: "投递时间" },
  { signature: "location: string | null", description: "岗位地点" },
  { signature: "notes: string | null", description: "备注" },
  { signature: "site: string", description: "招聘站点域名" },
  { signature: "progressStatus: string", description: "应用中当前保存的岗位状态" },
];

const helperMethods: ScriptApiEntry[] = [
  { signature: "helpers.log(...values): void", description: "记录仅在运行测试结果中显示的调试信息", detail: "最多 100 条、单条 2KB、总量 32KB；不会写入应用日志或长期保存。", example: "helpers.log('读取状态', { rawStatus });" },
  { signature: "helpers.exists(selector): boolean", description: "判断元素是否存在", example: "if (!helpers.exists('.result')) return null;" },
  { signature: "helpers.count(selector): number", description: "统计匹配元素数量" },
  { signature: "helpers.text(selector): string", description: "读取第一个匹配元素的文本", detail: "找不到元素时抛出错误。" },
  { signature: "helpers.texts(selector): string[]", description: "读取所有匹配元素的文本" },
  { signature: "helpers.textsWithin(container, child): string[][]", description: "按容器分组读取其内部子元素文本" },
  { signature: "helpers.value(selector): string", description: "读取 input、textarea 或 select 的当前值" },
  { signature: "helpers.attr(selector, name): string | null", description: "读取第一个匹配元素的属性" },
  { signature: "helpers.nextText(selector): string", description: "读取匹配元素的下一个同级元素文本" },
  { signature: "helpers.closestText(selector, ancestor): string", description: "读取最近匹配上级元素的完整文本" },
  { signature: "await helpers.fill(selector, value)", description: "填写 input、textarea 或 select", detail: "会依次触发 input、change 和 blur 事件。" },
  { signature: "await helpers.select(selector, value)", description: "选择原生 select 的值", detail: "会触发 input 和 change 事件。" },
  { signature: "await helpers.click(selector)", description: "点击第一个匹配的 HTML 元素" },
  { signature: "await helpers.waitForSelector(selector, timeoutMs = 5000)", description: "等待元素出现", detail: "单次等待限制为 100–60000ms，且不能突破规则总超时。" },
  { signature: "await helpers.waitForText(selector, expected, timeoutMs = 5000)", description: "等待元素文本包含 expected" },
  { signature: "await helpers.waitForTextChange(selector, previousText, timeoutMs = 5000)", description: "等待元素文本与 previousText 不同" },
  { signature: "helpers.scrollIntoView(selector)", description: "将元素滚动到页面中央附近" },
  { signature: "await helpers.sleep(milliseconds)", description: "暂停一小段时间", detail: "单次最多暂停 3000ms；优先使用条件等待方法。" },
];

const resultEntries: ScriptApiEntry[] = [
  { signature: "return null | undefined | []", description: "本脚本没有有效识别结果，继续使用内置识别和 AI 识别" },
  { signature: "return { applicationId, rawStatus, evidence? }", description: "返回一个岗位的原始状态", example: "return { applicationId: application.id, rawStatus: helpers.text('.status'), evidence: helpers.closestText('.status', '.card') };" },
  { signature: "return Array<{ applicationId, rawStatus, evidence? }>", description: "一次返回同页多个岗位的状态" },
  { signature: "applicationId: string", description: "必须是 application.id 或 applications 中存在的岗位 ID" },
  { signature: "rawStatus: string", description: "页面上的原始状态文本", detail: "不能为空，最长 500 个字符；返回后进入状态映射。" },
  { signature: "evidence?: string", description: "可选的识别证据文本", detail: "最长保留 2000 个字符。" },
  { signature: "结果限制", description: "同一岗位只能返回一条结果，整个返回数据不能超过 64KB" },
];

export const SCRIPT_API_SECTIONS: ScriptApiSection[] = [
  { id: "data", title: "投递数据", subtitle: "application 与 applications", entries: applicationFields },
  { id: "helpers", title: "页面操作", subtitle: "helpers 提供的安全 DOM API", entries: helperMethods },
  { id: "result", title: "返回结果", subtitle: "脚本必须返回的结构", entries: resultEntries },
];

export function filterScriptApiSections(query: string): ScriptApiSection[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return SCRIPT_API_SECTIONS;
  return SCRIPT_API_SECTIONS.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) =>
      `${entry.signature} ${entry.description} ${entry.detail ?? ""}`.toLocaleLowerCase().includes(normalized)),
  })).filter((section) => section.entries.length > 0);
}
