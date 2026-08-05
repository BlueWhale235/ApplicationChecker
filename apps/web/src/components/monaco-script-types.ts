export const SCRIPT_EDITOR_EXTRA_LIB = `
interface ScriptRuleApplication {
  /** 岗位 ID；返回识别结果时用作 applicationId。 */
  readonly id: string;
  /** 公司名称。 */
  readonly company: string;
  /** 岗位名称。 */
  readonly jobTitle: string;
  /** 用于检查投递状态的页面链接。 */
  readonly checkUrl: string | null;
  /** 最初投递该岗位的页面链接。 */
  readonly postingUrl: string | null;
  /** 投递时间；未填写时为 null。 */
  readonly appliedAt: string | null;
  /** 岗位地点；未填写时为 null。 */
  readonly location: string | null;
  /** 用户备注；未填写时为 null。 */
  readonly notes: string | null;
  /** 招聘站点域名。 */
  readonly site: string;
  /** 应用中当前保存的岗位状态。 */
  readonly progressStatus: string;
}

interface ScriptRuleResult {
  /** 必须对应 application.id 或 applications 中的岗位 ID。 */
  applicationId: string;
  /** 页面读取到的原始状态文本，返回后会进入状态映射。 */
  rawStatus: string;
  /** 可选的识别证据文本，最长保留 2000 个字符。 */
  evidence?: string;
}

interface ScriptRuleHelpers {
  /** 输出临时调试信息，仅在规则工作台测试结果中显示，不写入应用日志。 */
  log(...values: unknown[]): void;
  /** 判断当前页面是否存在匹配 CSS 选择器的元素。 */
  exists(selector: string): boolean;
  /** 统计当前页面中匹配 CSS 选择器的元素数量。 */
  count(selector: string): number;
  /** 读取第一个匹配元素的文本；找不到元素时抛出错误。 */
  text(selector: string): string;
  /** 读取所有匹配元素的文本。 */
  texts(selector: string): string[];
  /** 按容器分组读取其内部匹配子元素的文本。 */
  textsWithin(containerSelector: string, childSelector: string): string[][];
  /** 读取 input、textarea 或 select 的当前值。 */
  value(selector: string): string;
  /** 读取第一个匹配元素的指定属性；属性不存在时返回 null。 */
  attr(selector: string, name: string): string | null;
  /** 读取匹配元素的下一个同级元素文本。 */
  nextText(selector: string): string;
  /** 读取最近匹配上级元素的完整文本。 */
  closestText(selector: string, ancestorSelector: string): string;
  /** 填写 input、textarea 或 select，并触发 input、change 和 blur 事件。 */
  fill(selector: string, value: unknown): Promise<void>;
  /** 选择原生 select 的值，并触发 input 和 change 事件。 */
  select(selector: string, value: unknown): Promise<void>;
  /** 点击第一个匹配的 HTML 元素。 */
  click(selector: string): Promise<void>;
  /** 等待元素出现；默认 5 秒，且不能突破规则总超时。 */
  waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
  /** 等待元素文本包含 expected；默认 5 秒。 */
  waitForText(selector: string, expected: unknown, timeoutMs?: number): Promise<void>;
  /** 等待元素文本与 previousText 不同；默认 5 秒。 */
  waitForTextChange(selector: string, previousText: unknown, timeoutMs?: number): Promise<void>;
  /** 将第一个匹配元素滚动到页面中央附近。 */
  scrollIntoView(selector: string): void;
  /** 暂停指定毫秒数，单次最多 3000 毫秒。 */
  sleep(milliseconds: number): Promise<void>;
}

/** 当前检查组的主投递记录，只读。 */
declare const application: Readonly<ScriptRuleApplication>;
/** 当前页面所属检查组的全部投递记录，只读数组。 */
declare const applications: readonly Readonly<ScriptRuleApplication>[];
/** 页面脚本可使用的受控 DOM 操作与调试 API。 */
declare const helpers: Readonly<ScriptRuleHelpers>;
`;
