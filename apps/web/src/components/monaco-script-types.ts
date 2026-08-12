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
  /** 绕过文本映射，直接使用指定状态。通常通过 helpers.status() 生成。 */
  directStatus?: ScriptDirectStatus;
  /** 可选的识别证据文本，最长保留 2000 个字符。 */
  evidence?: string;
}

type ScriptDirectStatus =
  | "unset"
  | "screening"
  | "screening_passed"
  | "interview_pending"
  | "interviewed"
  | "signing_pending"
  | "offer"
  | "rejected"
  | "needs_login";

interface ScriptStatusOptions {
  /** 不填写时使用当前 application.id；同页多岗位时传入目标岗位 ID。 */
  applicationId?: string;
  /** 可选的判定证据，会显示在检查结果和状态通知中。 */
  evidence?: string;
}

interface SelectorRuleLocator {
  readonly tag: string | null;
  readonly role: string | null;
  readonly classes: readonly string[];
  readonly dataStatus: string | null;
  readonly ariaCurrent: string | null;
  readonly ariaSelected: string | null;
  readonly ancestorTags: readonly string[];
}

interface SelectorParserRuleDefinition {
  readonly schemaVersion: 2;
  readonly kind: "selector";
  readonly hostname: string;
  readonly pathname: string;
  readonly container: SelectorRuleLocator | null;
  readonly title: SelectorRuleLocator;
  readonly status: SelectorRuleLocator;
}

interface ScriptAxiosConfig {
  /** 请求地址；支持相对当前页面的地址和 HTTP(S) 绝对地址。 */
  url?: string;
  method?: string;
  baseURL?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  data?: unknown;
  /** 单次请求超时，范围 1000–60000ms，且不能突破规则总超时。 */
  timeout?: number;
  responseType?: "json" | "text";
  /** 是否按浏览器规则向跨域请求携带凭据。 */
  withCredentials?: boolean;
}

interface ScriptAxiosResponse<T = unknown> {
  readonly data: T;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

interface ScriptAxios {
  <T = unknown>(config: ScriptAxiosConfig): Promise<ScriptAxiosResponse<T>>;
  get<T = unknown>(url: string, config?: ScriptAxiosConfig): Promise<ScriptAxiosResponse<T>>;
  delete<T = unknown>(url: string, config?: ScriptAxiosConfig): Promise<ScriptAxiosResponse<T>>;
  post<T = unknown>(url: string, data?: unknown, config?: ScriptAxiosConfig): Promise<ScriptAxiosResponse<T>>;
  put<T = unknown>(url: string, data?: unknown, config?: ScriptAxiosConfig): Promise<ScriptAxiosResponse<T>>;
  patch<T = unknown>(url: string, data?: unknown, config?: ScriptAxiosConfig): Promise<ScriptAxiosResponse<T>>;
}

interface ScriptRuleHelpers {
  /** 获取当前页面的完整 URL。 */
  currentUrl(): string;
  /** 跳转到规则 hostname 范围内的页面；加载后从脚本开头重新执行。 */
  goto(url: string): Promise<never>;
  /** Axios 风格 HTTP 请求；使用当前页面的浏览器网络环境。 */
  readonly axios: ScriptAxios;
  /** 输出临时调试信息，仅在规则工作台测试结果中显示，不写入应用日志。 */
  log(...values: unknown[]): void;
  /** 创建一个直接状态结果；脚本必须 return 该结果才会生效。 */
  status(status: ScriptDirectStatus, options?: ScriptStatusOptions): ScriptRuleResult;
  /** 为当前检查组的全部岗位创建相同的直接状态结果。 */
  statusAll(status: ScriptDirectStatus, options?: Omit<ScriptStatusOptions, "applicationId">): ScriptRuleResult[];
  runSelectorRule(definition: SelectorParserRuleDefinition): ScriptRuleResult[];
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
