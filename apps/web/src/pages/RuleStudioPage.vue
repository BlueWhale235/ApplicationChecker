<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type {
  AssistedParserRule,
  AssistedParserRuleDefinition,
  AssistedRuleTestResult,
  LocalDomNode,
  RecognitionPreviewDetail,
  RecognitionPreviewSnapshot,
  RuleStudioCheckGroupOption,
  ScriptParserRuleDefinition,
  SelectorParserRuleDefinition,
} from "@application-checker/contracts";
import { progressLabels } from "@application-checker/contracts";
import { api } from "../api";
import { isSelectableRuleNode, pickRuleNodeAtPoint } from "./rule-studio-selection";
import { parseSelectorRuleJson } from "./rule-studio-json";
import { highlightJavaScript } from "./rule-studio-syntax";

defineProps<{ busy: boolean }>();
const emit = defineEmits<{
  failure: [message: string];
  notice: [message: string];
  delete: [rule: AssistedParserRule];
  confirm: [
    options: { title: string; message: string; confirmLabel: string; danger: boolean },
    done: (confirmed: boolean) => void,
  ];
}>();

type RuleMode = "selector" | "script";

const SCRIPT_EXAMPLES = {
  query: {
    label: "填写信息并查询",
    code: `// 示例：用投递信息填写查询表单，再读取结果
await helpers.fill('input[name="keyword"]', application.jobTitle);
await helpers.click('button[type="submit"]');
await helpers.waitForSelector('.query-result', 8000);

return {
  applicationId: application.id,
  rawStatus: helpers.text('.query-result .status'),
  evidence: helpers.text('.query-result')
};`,
  },
  extract: {
    label: "直接提取状态",
    code: `const rawStatus = helpers.text('.application-status');

return {
  applicationId: application.id,
  rawStatus,
  evidence: helpers.text('.status-panel')
};`,
  },
  multiple: {
    label: "同页多个岗位",
    code: `return applications.map((item, index) => ({
  applicationId: item.id,
  rawStatus: helpers.text(
    \`.application-row:nth-child(\${index + 1}) .status\`
  )
}));`,
  },
} as const;

const APPLICATION_FIELDS = [
  ["id", "岗位 ID"], ["company", "公司"], ["jobTitle", "岗位名称"], ["checkUrl", "检查链接"],
  ["postingUrl", "投递链接"], ["appliedAt", "投递时间"], ["location", "地点"], ["notes", "备注"],
  ["site", "站点"], ["progressStatus", "当前状态"],
] as const;

const rules = ref<AssistedParserRule[]>([]);
const ruleQuery = ref("");
const selectedApplicationId = ref("");
const checkGroupOptions = ref<RuleStudioCheckGroupOption[]>([]);
const checkGroupSearch = ref("");
const loadingCheckGroups = ref(false);
const preview = ref<RecognitionPreviewDetail | null>(null);
const previewData = ref<RecognitionPreviewSnapshot | null>(null);
const loadingPreview = ref(false);
const selectedTitleNodeId = ref<number | null>(null);
const selectedStatusNodeId = ref<number | null>(null);
const picking = ref<"title" | "status">("title");
const hoveredNodeId = ref<number | null>(null);
const testResult = ref<AssistedRuleTestResult | null>(null);
const scriptTestResult = ref<RecognitionPreviewDetail | null>(null);
const scriptTesting = ref(false);
const lastTestedScriptSignature = ref("");
const draftDefinition = ref<SelectorParserRuleDefinition | null>(null);
const draftErrors = ref<string[]>([]);
const editingRuleId = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const scriptEditor = ref<HTMLTextAreaElement | null>(null);
const scriptHighlight = ref<HTMLElement | null>(null);
const selectorJsonHighlight = ref<HTMLElement | null>(null);
const selectorJsonMode = ref(false);
const selectorJson = ref("");
const selectedExample = ref<keyof typeof SCRIPT_EXAMPLES>("query");
const editor = reactive<{
  mode: RuleMode;
  name: string;
  hostname: string;
  pathname: string;
  priority: number;
  enabled: boolean;
  script: string;
  timeoutMs: number;
}>({
  mode: "selector" as RuleMode,
  name: "",
  hostname: "",
  pathname: "",
  priority: 100,
  enabled: true,
  script: SCRIPT_EXAMPLES.query.code,
  timeoutMs: 10_000,
});
let previewTimer: number | undefined;
let scriptTestTimer: number | undefined;
let checkGroupTimer: number | undefined;

const applicationItems = computed(() => checkGroupOptions.value.map((item) => ({
  title: `${item.company} · ${item.jobTitle}${item.memberCount > 1 ? ` · ${item.memberCount} 个岗位` : ""} · ${item.site}`,
  value: item.applicationId,
})));
const filteredRules = computed(() => {
  const query = ruleQuery.value.trim().toLocaleLowerCase();
  if (!query) return rules.value;
  return rules.value.filter((rule) =>
    `${rule.name} ${rule.definition.hostname} ${rule.definition.pathname}`.toLocaleLowerCase().includes(query));
});
const selectedNodes = computed(() => new Set([
  selectedTitleNodeId.value,
  selectedStatusNodeId.value,
  hoveredNodeId.value,
].filter((value): value is number => value !== null)));
const selectableNodes = computed(() => (previewData.value?.snapshot.nodes ?? []).filter((node) =>
  isSelectableRuleNode(node, previewData.value?.screenshotWidth ?? 1, previewData.value?.screenshotHeight ?? 1)));
const canGenerate = computed(() => Boolean(previewData.value && selectedTitleNodeId.value && selectedStatusNodeId.value));
const scriptSignature = computed(() => JSON.stringify({
  script: editor.script,
  hostname: editor.hostname,
  pathname: editor.pathname,
  timeoutMs: editor.timeoutMs,
}));
const highlightedScript = computed(() => highlightJavaScript(editor.script));
const highlightedSelectorJson = computed(() => highlightJavaScript(selectorJson.value));
const selectorJsonResult = computed(() => parseSelectorRuleJson(selectorJson.value));
const scriptTimeoutValid = computed(() => Number.isInteger(editor.timeoutMs)
  && editor.timeoutMs >= 1_000 && editor.timeoutMs <= 60_000);
const canSave = computed(() => editor.mode === "selector"
  ? (selectorJsonMode.value
    ? Boolean(editor.name.trim() && selectorJsonResult.value.definition)
    : Boolean(draftDefinition.value && !draftErrors.value.length && testResult.value?.valid))
  : Boolean(editor.script.trim() && scriptTimeoutValid.value && scriptTestResult.value?.status === "succeeded"
    && scriptTestResult.value.matchedCount > 0 && lastTestedScriptSignature.value === scriptSignature.value));

function describeNode(node: LocalDomNode | undefined): string {
  if (!node) return "尚未选择";
  const marker = [node.tag, node.role, ...node.classes, node.dataStatus, node.ariaCurrent].filter(Boolean).join(".");
  return `${node.text || "(无文本)"} · ${marker}`;
}
function nodeById(id: number | null): LocalDomNode | undefined {
  return previewData.value?.snapshot.nodes.find((node) => node.id === id);
}
function clearAuthoringTest(): void {
  testResult.value = null;
  scriptTestResult.value = null;
  lastTestedScriptSignature.value = "";
  draftErrors.value = [];
}
function clearSelectorDraft(): void {
  selectedTitleNodeId.value = null;
  selectedStatusNodeId.value = null;
  picking.value = "title";
  hoveredNodeId.value = null;
  draftDefinition.value = null;
  testResult.value = null;
}
function resetEditor(): void {
  clearSelectorDraft();
  clearAuthoringTest();
  editingRuleId.value = null;
  selectorJsonMode.value = false;
  selectorJson.value = "";
  preview.value = null;
  previewData.value = null;
  Object.assign(editor, {
    mode: "selector", name: "", hostname: "", pathname: "", priority: 100, enabled: true,
    script: SCRIPT_EXAMPLES.query.code, timeoutMs: 10_000,
  });
  selectedExample.value = "query";
}
function selectNode(node: LocalDomNode): void {
  clearAuthoringTest();
  draftDefinition.value = null;
  if (picking.value === "title") {
    selectedTitleNodeId.value = node.id;
    picking.value = "status";
  } else selectedStatusNodeId.value = node.id;
}

function pointFromEvent(event: MouseEvent): { x: number; y: number } | null {
  if (!previewData.value) return null;
  const rectangle = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (!rectangle.width || !rectangle.height) return null;
  return {
    x: (event.clientX - rectangle.left) / rectangle.width * previewData.value.screenshotWidth,
    y: (event.clientY - rectangle.top) / rectangle.height * previewData.value.screenshotHeight,
  };
}
function pickFromCanvas(event: MouseEvent): void {
  const point = pointFromEvent(event);
  if (!point || !previewData.value || editor.mode !== "selector") return;
  const node = pickRuleNodeAtPoint(previewData.value.snapshot.nodes, point,
    previewData.value.screenshotWidth, previewData.value.screenshotHeight);
  if (node) selectNode(node);
}
function hoverFromCanvas(event: MouseEvent): void {
  const point = pointFromEvent(event);
  if (!point || !previewData.value || editor.mode !== "selector") return;
  hoveredNodeId.value = pickRuleNodeAtPoint(previewData.value.snapshot.nodes, point,
    previewData.value.screenshotWidth, previewData.value.screenshotHeight)?.id ?? null;
}

async function loadRules(): Promise<void> {
  try { rules.value = await api.parserRules(); }
  catch (value) { emit("failure", value instanceof Error ? value.message : "加载规则失败"); }
}
async function loadCheckGroups(query = ""): Promise<void> {
  loadingCheckGroups.value = true;
  try { checkGroupOptions.value = await api.parserRuleCheckGroups(query, 30); }
  catch (value) { emit("failure", value instanceof Error ? value.message : "加载检查组失败"); }
  finally { loadingCheckGroups.value = false; }
}
async function pollPreview(): Promise<void> {
  if (!preview.value) return;
  try {
    preview.value = await api.recognitionPreview(preview.value.id);
    if (["queued", "running"].includes(preview.value.status)) {
      previewTimer = window.setTimeout(() => void pollPreview(), 1_000);
      return;
    }
    loadingPreview.value = false;
    if (preview.value.status !== "succeeded") {
      emit("failure", preview.value.error || `预览状态：${preview.value.status}`);
      return;
    }
    previewData.value = await api.recognitionPreviewSnapshot(preview.value.id);
    const url = new URL(previewData.value.snapshot.url);
    editor.hostname ||= url.hostname;
    editor.pathname ||= url.pathname || "/";
    editor.name ||= `${url.hostname} 状态规则`;
  } catch (value) {
    loadingPreview.value = false;
    emit("failure", value instanceof Error ? value.message : "加载预览失败");
  }
}
async function createPreview(): Promise<void> {
  if (!selectedApplicationId.value) return;
  if (previewTimer) clearTimeout(previewTimer);
  clearAuthoringTest();
  if (editor.mode === "selector") {
    selectedTitleNodeId.value = null;
    selectedStatusNodeId.value = null;
    picking.value = "title";
    hoveredNodeId.value = null;
    if (!editingRuleId.value) draftDefinition.value = null;
  }
  previewData.value = null;
  loadingPreview.value = true;
  try {
    preview.value = await api.createRecognitionPreview(selectedApplicationId.value);
    await pollPreview();
  } catch (value) {
    loadingPreview.value = false;
    emit("failure", value instanceof Error ? value.message : "创建预览失败");
  }
}

async function confirmAction(options: { title: string; message: string; confirmLabel: string; danger: boolean }): Promise<boolean> {
  return new Promise((resolve) => emit("confirm", options, resolve));
}
async function switchMode(mode: RuleMode): Promise<void> {
  if (editor.mode === mode) return;
  const hasSelectorWork = Boolean(selectedTitleNodeId.value || selectedStatusNodeId.value || draftDefinition.value);
  const hasScriptWork = editor.script.trim() && editor.script !== SCRIPT_EXAMPLES.query.code;
  if ((editor.mode === "selector" && hasSelectorWork) || (editor.mode === "script" && hasScriptWork)) {
    const confirmed = await confirmAction({
      title: mode === "script" ? "改用页面脚本" : "改回点选规则",
      message: "切换规则类型会清除当前类型的草稿和测试结果，且一条规则不能同时使用两种方式。",
      confirmLabel: "确认切换",
      danger: false,
    });
    if (!confirmed) return;
  }
  clearSelectorDraft();
  clearAuthoringTest();
  selectorJsonMode.value = false;
  selectorJson.value = "";
  editor.mode = mode;
  if (mode === "script") editor.script ||= SCRIPT_EXAMPLES.query.code;
  else editor.script = SCRIPT_EXAMPLES.query.code;
}

async function generateRule(): Promise<void> {
  if (!preview.value || !selectedTitleNodeId.value || !selectedStatusNodeId.value) return;
  try {
    const generated = await api.generateParserRule(preview.value.id, {
      titleNodeId: selectedTitleNodeId.value,
      statusNodeId: selectedStatusNodeId.value,
      name: editor.name,
    });
    if (generated.definition.kind !== "selector") throw new Error("生成器返回了错误的规则类型");
    draftDefinition.value = generated.definition;
    editor.hostname = generated.definition.hostname;
    editor.pathname = generated.definition.pathname;
    draftErrors.value = generated.errors;
    testResult.value = null;
    if (!generated.errors.length) emit("notice", "规则草稿已生成，请执行无写入测试");
  } catch (value) { emit("failure", value instanceof Error ? value.message : "生成规则失败"); }
}

function currentRule(): AssistedParserRule | null {
  let definition: AssistedParserRuleDefinition;
  if (editor.mode === "selector") {
    if (selectorJsonMode.value) {
      if (!selectorJsonResult.value.definition) return null;
      definition = selectorJsonResult.value.definition;
    } else {
      if (!draftDefinition.value) return null;
      definition = { ...draftDefinition.value, hostname: editor.hostname, pathname: editor.pathname };
    }
  } else {
    definition = {
      schemaVersion: 2, kind: "script", hostname: editor.hostname, pathname: editor.pathname,
      script: editor.script, timeoutMs: Math.max(1_000, Math.min(60_000, Math.trunc(editor.timeoutMs))),
    } satisfies ScriptParserRuleDefinition;
  }
  const existing = editingRuleId.value ? rules.value.find((item) => item.id === editingRuleId.value) : null;
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? "draft", name: editor.name, enabled: editor.enabled, priority: editor.priority,
    version: existing?.version ?? 1, definition, createdAt: existing?.createdAt ?? now,
    updatedAt: now, lastTestedAt: existing?.lastTestedAt ?? null,
  };
}
async function testSelectorRule(): Promise<void> {
  if (!preview.value) return;
  const rule = currentRule();
  if (!rule || rule.definition.kind !== "selector") return;
  try {
    testResult.value = await api.testParserRule(preview.value.id, rule);
    draftErrors.value = testResult.value.errors;
    if (testResult.value.valid) emit("notice", "无写入测试通过");
    else emit("failure", testResult.value.errors.join("；"));
  } catch (value) { emit("failure", value instanceof Error ? value.message : "测试规则失败"); }
}
async function pollScriptTest(id: string, testedSignature: string): Promise<void> {
  try {
    const result = await api.recognitionPreview(id);
    scriptTestResult.value = result;
    if (["queued", "running"].includes(result.status)) {
      scriptTestTimer = window.setTimeout(() => void pollScriptTest(id, testedSignature), 1_000);
      return;
    }
    scriptTesting.value = false;
    if (result.status === "succeeded" && result.matchedCount > 0) {
      lastTestedScriptSignature.value = testedSignature;
      emit("notice", "页面脚本无写入测试通过");
    } else emit("failure", result.error || "脚本已执行，但没有返回可映射的岗位状态");
  } catch (value) {
    scriptTesting.value = false;
    emit("failure", value instanceof Error ? value.message : "页面脚本测试失败");
  }
}
async function testScriptRule(): Promise<void> {
  if (!preview.value) return;
  const rule = currentRule();
  if (!rule || rule.definition.kind !== "script") return;
  scriptTesting.value = true;
  scriptTestResult.value = null;
  lastTestedScriptSignature.value = "";
  const testedSignature = scriptSignature.value;
  try {
    const queued = await api.testScriptParserRule(preview.value.id, rule);
    await pollScriptTest(queued.id, testedSignature);
  } catch (value) {
    scriptTesting.value = false;
    emit("failure", value instanceof Error ? value.message : "页面脚本测试失败");
  }
}
async function saveRule(): Promise<void> {
  const rule = currentRule();
  if (!rule || !canSave.value) return;
  const wasEditing = Boolean(editingRuleId.value);
  try {
    const body = {
      name: editor.name, enabled: editor.enabled, priority: editor.priority, definition: rule.definition,
      tested: editor.mode === "selector" ? !selectorJsonMode.value : true,
    };
    if (editingRuleId.value) await api.updateParserRule(editingRuleId.value, body);
    else await api.createParserRule(body);
    await loadRules();
    resetEditor();
    emit("notice", wasEditing ? "解析规则已更新" : "解析规则已保存");
  } catch (value) { emit("failure", value instanceof Error ? value.message : "保存规则失败"); }
}
function editRule(rule: AssistedParserRule): void {
  resetEditor();
  editingRuleId.value = rule.id;
  Object.assign(editor, {
    mode: rule.definition.kind,
    name: rule.name,
    hostname: rule.definition.hostname,
    pathname: rule.definition.pathname,
    priority: rule.priority,
    enabled: rule.enabled,
    script: rule.definition.kind === "script" ? rule.definition.script : SCRIPT_EXAMPLES.query.code,
    timeoutMs: rule.definition.kind === "script" ? rule.definition.timeoutMs : 10_000,
  });
  if (rule.definition.kind === "selector") {
    selectorJsonMode.value = true;
    selectorJson.value = JSON.stringify(rule.definition, null, 2);
  }
}
async function toggleRule(rule: AssistedParserRule): Promise<void> {
  if (!rule.enabled && rule.definition.kind === "script") {
    const confirmed = await confirmAction({
      title: "启用页面脚本",
      message: "页面脚本会在匹配的网站中使用当前浏览器登录态执行。请确认你已经检查过脚本内容。",
      confirmLabel: "启用脚本",
      danger: false,
    });
    if (!confirmed) return;
  }
  try {
    await api.updateParserRule(rule.id, { name: rule.name, enabled: !rule.enabled, priority: rule.priority, definition: rule.definition });
    await loadRules();
  } catch (value) { emit("failure", value instanceof Error ? value.message : "更新规则失败"); }
}

function applyExample(): void {
  editor.script = SCRIPT_EXAMPLES[selectedExample.value].code;
  scriptTestResult.value = null;
  lastTestedScriptSignature.value = "";
}
function syncScriptScroll(event: Event): void {
  const editorElement = event.currentTarget as HTMLTextAreaElement;
  if (!scriptHighlight.value) return;
  scriptHighlight.value.scrollTop = editorElement.scrollTop;
  scriptHighlight.value.scrollLeft = editorElement.scrollLeft;
}
function syncSelectorJsonScroll(event: Event): void {
  const editorElement = event.currentTarget as HTMLTextAreaElement;
  if (!selectorJsonHighlight.value) return;
  selectorJsonHighlight.value.scrollTop = editorElement.scrollTop;
  selectorJsonHighlight.value.scrollLeft = editorElement.scrollLeft;
}
async function insertApplicationField(field: string): Promise<void> {
  const insertion = `application.${field}`;
  const element = scriptEditor.value;
  if (!element) {
    editor.script += insertion;
    return;
  }
  const start = element.selectionStart;
  const end = element.selectionEnd;
  editor.script = `${editor.script.slice(0, start)}${insertion}${editor.script.slice(end)}`;
  await nextTick();
  element.focus();
  element.setSelectionRange(start + insertion.length, start + insertion.length);
}

async function exportRules(): Promise<void> {
  try { downloadRules(await api.exportParserRules(), `application-checker-parser-rules-${new Date().toISOString().slice(0, 10)}.json`); }
  catch (value) { emit("failure", value instanceof Error ? value.message : "导出规则失败"); }
}
function downloadRules(data: { schemaVersion: number; exportedAt: string; rules: AssistedParserRule[] }, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}
async function exportRule(rule: AssistedParserRule): Promise<void> {
  try {
    const safeName = rule.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 80) || "parser-rule";
    downloadRules(await api.exportParserRule(rule.id), `${safeName}.json`);
  } catch (value) { emit("failure", value instanceof Error ? value.message : "导出规则失败"); }
}
async function importRules(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const body = JSON.parse(await file.text()) as { schemaVersion: number; rules: AssistedParserRule[] };
    const previewResult = await api.importParserRules({ ...body, confirm: false });
    if (!previewResult.added) throw new Error(`没有可导入规则，冲突或无效 ${previewResult.skipped} 条`);
    const confirmed = await confirmAction({
      title: "导入解析规则",
      message: `将新增 ${previewResult.added} 条规则，脚本规则会保持停用；跳过 ${previewResult.skipped} 条冲突或无效规则。`,
      confirmLabel: "导入规则", danger: false,
    });
    if (!confirmed) return;
    const result = await api.importParserRules({ ...body, confirm: true });
    await loadRules();
    emit("notice", `已导入 ${result.added} 条规则，跳过 ${result.skipped} 条`);
  } catch (value) { emit("failure", value instanceof Error ? value.message : "导入规则失败"); }
  finally { if (fileInput.value) fileInput.value.value = ""; }
}

watch(checkGroupSearch, (query) => {
  const selectedTitle = applicationItems.value.find((item) => item.value === selectedApplicationId.value)?.title;
  if (query === selectedTitle) return;
  if (checkGroupTimer) clearTimeout(checkGroupTimer);
  checkGroupTimer = window.setTimeout(() => void loadCheckGroups(query.trim()), 250);
});
onMounted(() => { void Promise.all([loadRules(), loadCheckGroups()]); });
onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer);
  if (scriptTestTimer) clearTimeout(scriptTestTimer);
  if (checkGroupTimer) clearTimeout(checkGroupTimer);
});
</script>

<template>
  <section class="page-content rule-studio">
    <div class="page-heading">
      <div><h1>规则工作台</h1><p>点选规则适合常规列表；高级页面可改用加载后执行的页面脚本。</p></div>
      <div class="heading-actions">
        <input ref="fileInput" type="file" accept="application/json" hidden @change="importRules">
        <v-btn variant="outlined" prepend-icon="mdi-upload-outline" @click="fileInput?.click()">导入</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-download-outline" :disabled="!rules.length" @click="exportRules">导出</v-btn>
      </div>
    </div>

    <div class="security-note" :class="{ advanced: editor.mode === 'script' }">
      <i class="mdi" :class="editor.mode === 'script' ? 'mdi-code-braces' : 'mdi-shield-lock-outline'"></i>
      <span v-if="editor.mode === 'selector' && !selectorJsonMode">点选规则只保存路径与稳定 DOM 特征，不保存页面输入值、Cookie、完整 HTML 或截图。</span>
      <span v-else-if="editor.mode === 'selector'">正在直接编辑点选规则 JSON；保存前会检查格式和规则类型。</span>
      <span v-else>页面脚本会在匹配的 Edge 页面内运行，可以读取和操作当前页面；不会开放 Node.js、本地文件或应用密钥。</span>
    </div>

    <div class="studio-layout">
      <aside class="rule-list">
        <div class="panel-title"><strong>本地规则</strong><span>{{ rules.length }}</span><button @click="resetEditor">＋ 新建</button></div>
        <v-text-field v-model="ruleQuery" class="rule-search" placeholder="搜索规则或网址" prepend-inner-icon="mdi-magnify"
          density="compact" variant="outlined" hide-details clearable />
        <div class="rule-items">
          <article v-for="rule in filteredRules" :key="rule.id" :class="{ disabled: !rule.enabled, selected: editingRuleId === rule.id }">
            <header class="rule-card-heading">
              <strong>{{ rule.name }}</strong>
              <span class="kind-badge" :class="{ script: rule.definition.kind === 'script' }">{{ rule.definition.kind === "script" ? "脚本" : "点选" }}</span>
            </header>
            <p class="rule-scope"><i class="mdi mdi-link-variant"></i><span>{{ rule.definition.hostname }}{{ rule.definition.pathname }}</span></p>
            <div class="rule-meta-row">
              <span>优先级 <b>{{ rule.priority }}</b></span>
              <span class="rule-state" :class="{ off: !rule.enabled }"><i class="mdi mdi-circle"></i>{{ rule.enabled ? "已启用" : "已停用" }}</span>
            </div>
            <div class="rule-actions">
              <button @click="editRule(rule)">编辑</button><button @click="exportRule(rule)">导出</button>
              <button @click="toggleRule(rule)">{{ rule.enabled ? "停用" : "启用" }}</button>
              <button class="danger" @click="emit('delete', rule)">删除</button>
            </div>
          </article>
          <div v-if="!rules.length" class="empty-small">还没有用户辅助规则</div>
          <div v-else-if="!filteredRules.length" class="empty-small">没有匹配的规则或网址</div>
        </div>
      </aside>

      <main class="editor">
        <div class="mode-heading" :class="{ script: editor.mode === 'script' }">
          <div><strong>{{ editor.mode === "script" ? "页面脚本" : selectorJsonMode ? "点选规则 JSON" : "点选规则" }}</strong><small>{{ editor.mode === "script" ? "高级" : selectorJsonMode ? "直接编辑" : "默认" }}</small></div>
          <button v-if="editor.mode === 'script'" @click="switchMode('selector')">← 改回点选规则</button>
        </div>
        <div v-if="!selectorJsonMode" class="preview-toolbar">
          <v-autocomplete v-model="selectedApplicationId" v-model:search="checkGroupSearch" :items="applicationItems"
            :loading="loadingCheckGroups" label="选择检查组中的岗位" placeholder="输入公司、岗位、域名或链接筛选"
            no-data-text="没有匹配的检查组" density="compact" hide-details no-filter clearable />
          <v-btn color="primary" prepend-icon="mdi-camera-outline" :loading="loadingPreview" :disabled="!selectedApplicationId" @click="createPreview">加载页面</v-btn>
        </div>

        <div v-if="editor.mode === 'selector' && selectorJsonMode" class="selector-json-grid">
          <section class="json-panel">
            <div class="json-toolbar"><div><i class="mdi mdi-code-json"></i><strong>规则定义 JSON</strong></div><span>修改后直接保存</span></div>
            <div class="json-editor-shell">
              <pre ref="selectorJsonHighlight" class="json-highlight" aria-hidden="true" v-html="highlightedSelectorJson"></pre>
              <textarea v-model="selectorJson" class="json-editor" spellcheck="false" aria-label="点选规则 JSON" @scroll="syncSelectorJsonScroll" />
            </div>
            <div class="json-status" :class="{ invalid: selectorJsonResult.error }">
              <i class="mdi" :class="selectorJsonResult.error ? 'mdi-alert-circle-outline' : 'mdi-check-circle-outline'"></i>
              <span>{{ selectorJsonResult.error || "JSON 格式有效，可更新规则" }}</span>
            </div>
          </section>
          <aside class="json-side">
            <v-text-field v-model="editor.name" label="规则名称" density="compact" />
            <div class="field-block scope-summary"><strong>匹配范围</strong><p>范围直接来自左侧 JSON</p>
              <code>{{ selectorJsonResult.definition?.hostname || "—" }}</code>
              <code>{{ selectorJsonResult.definition?.pathname || "—" }}</code>
            </div>
            <v-text-field v-model.number="editor.priority" type="number" label="优先级" density="compact" />
            <v-switch v-model="editor.enabled" label="保存后启用" color="primary" hide-details />
            <p class="json-help">直接编辑不会重新运行页面测试。后端仍会校验 URLPattern、定位器长度和不安全内容。</p>
            <v-btn color="primary" block :disabled="!canSave" @click="saveRule">更新规则</v-btn>
          </aside>
        </div>

        <div v-else-if="previewData && editor.mode === 'selector'" class="authoring-grid">
          <div class="canvas-column">
            <div class="canvas-tools"><button :class="{ active: picking === 'title' }" @click="picking = 'title'">1. 点选岗位标题</button>
              <button :class="{ active: picking === 'status' }" @click="picking = 'status'">2. 点选当前状态</button>
              <span>{{ selectableNodes.length }} 个可选元素</span></div>
            <div class="canvas-scroll"><div class="screenshot-canvas" :style="{ aspectRatio: `${previewData.screenshotWidth}/${previewData.screenshotHeight}` }"
              @click="pickFromCanvas" @mousemove="hoverFromCanvas" @mouseleave="hoveredNodeId = null">
              <img :src="api.recognitionPreviewScreenshotUrl(preview!.id)" alt="招聘页面预览">
              <button v-for="node in selectableNodes" :key="node.id" class="node-box"
                :class="{ selected: selectedNodes.has(node.id), title: selectedTitleNodeId === node.id,
                  status: selectedStatusNodeId === node.id, matched: testResult?.matchedNodeIds.includes(node.id) }"
                :style="{ left: `${node.x / previewData.screenshotWidth * 100}%`, top: `${node.y / previewData.screenshotHeight * 100}%`,
                  width: `${node.width / previewData.screenshotWidth * 100}%`, height: `${node.height / previewData.screenshotHeight * 100}%` }"
                :title="describeNode(node)" />
            </div></div>
            <button class="advanced-link" @click="switchMode('script')"><span>点选规则无法适配？</span><b>改用页面脚本</b><i class="mdi mdi-chevron-right"></i></button>
          </div>
          <aside class="rule-editor">
            <v-text-field v-model="editor.name" label="规则名称" density="compact" />
            <div class="selection-card"><small>岗位标题</small><strong>{{ describeNode(nodeById(selectedTitleNodeId)) }}</strong>
              <small>当前状态</small><strong>{{ describeNode(nodeById(selectedStatusNodeId)) }}</strong></div>
            <v-text-field v-model="editor.hostname" label="Hostname URLPattern" density="compact" />
            <v-text-field v-model="editor.pathname" label="Pathname URLPattern" density="compact" />
            <v-text-field v-model.number="editor.priority" type="number" label="优先级" density="compact" />
            <v-switch v-model="editor.enabled" label="保存后启用" color="primary" hide-details />
            <div v-if="draftErrors.length" class="errors"><p v-for="message in draftErrors" :key="message">{{ message }}</p></div>
            <div class="editor-actions"><v-btn variant="outlined" :disabled="!canGenerate" @click="generateRule">生成草稿</v-btn>
              <v-btn variant="outlined" :disabled="!draftDefinition" @click="testSelectorRule">无写入测试</v-btn>
              <v-btn color="primary" :disabled="!canSave" @click="saveRule">{{ editingRuleId ? "更新规则" : "保存规则" }}</v-btn></div>
            <div v-if="testResult" class="test-results"><strong>{{ testResult.valid ? "测试通过" : "测试未通过" }}</strong>
              <article v-for="item in testResult.result.results" :key="item.applicationId"><span>{{ previewData.applications.find((candidate) => candidate.id === item.applicationId)?.jobTitle }}</span>
                <b>{{ item.status ? progressLabels[item.status] : "未匹配" }}</b><small>{{ item.evidence }}</small></article></div>
          </aside>
        </div>

        <div v-else-if="editor.mode === 'script'" class="script-grid">
          <section class="script-panel">
            <div class="script-toolbar"><label>示例脚本<select v-model="selectedExample" @change="applyExample"><option v-for="(item, key) in SCRIPT_EXAMPLES" :key="key" :value="key">{{ item.label }}</option></select></label>
              <span>最长执行 {{ editor.timeoutMs / 1000 }} 秒</span></div>
            <div class="script-editor-shell">
              <pre ref="scriptHighlight" class="script-highlight" aria-hidden="true" v-html="highlightedScript"></pre>
              <textarea ref="scriptEditor" v-model="editor.script" class="script-editor" spellcheck="false" aria-label="页面脚本" @scroll="syncScriptScroll" />
            </div>
            <div class="script-foot"><span>可用对象：<code>application</code>、<code>applications</code>、<code>helpers</code></span><small>helpers：text · texts · textsWithin · value · attr · nextText · closestText · exists · count · fill · select · click · waitForSelector · waitForText · waitForTextChange · scrollIntoView · sleep</small></div>
          </section>
          <aside class="script-side">
            <v-text-field v-model="editor.name" label="规则名称" density="compact" />
            <div class="field-block"><strong>投递字段</strong><p>点击插入当前投递的只读字段</p><div class="field-buttons">
              <button v-for="field in APPLICATION_FIELDS" :key="field[0]" @click="insertApplicationField(field[0])"><code>{{ field[0] }}</code><span>{{ field[1] }}</span></button>
            </div></div>
            <div class="field-block"><strong>当前页面投递</strong><p v-if="!previewData">加载页面后显示该检查组的投递数据</p><article v-for="item in previewData?.applications ?? []" :key="item.id">
              <span>{{ item.jobTitle }}</span><small>{{ item.company }} · {{ item.appliedAt || "未填投递时间" }}</small></article></div>
            <v-text-field v-model="editor.hostname" label="Hostname URLPattern" density="compact" />
            <v-text-field v-model="editor.pathname" label="Pathname URLPattern" density="compact" />
            <div class="number-row"><v-text-field v-model.number="editor.priority" type="number" label="优先级" density="compact" />
              <v-text-field v-model.number="editor.timeoutMs" type="number" min="1000" max="60000" step="1000" label="超时毫秒（最多 60000）"
                :error-messages="scriptTimeoutValid ? [] : ['请输入 1000 到 60000 之间的整数']" density="compact" /></div>
            <v-switch v-model="editor.enabled" label="保存后启用" color="primary" hide-details />
            <div class="editor-actions"><v-btn variant="outlined" prepend-icon="mdi-play" :loading="scriptTesting" :disabled="!preview || !editor.script.trim() || !scriptTimeoutValid" @click="testScriptRule">运行测试</v-btn>
              <v-btn color="primary" :disabled="!canSave" @click="saveRule">{{ editingRuleId ? "更新规则" : "保存规则" }}</v-btn></div>
            <div v-if="scriptTestResult" class="test-results script-test"><strong>{{ scriptTestResult.status === "succeeded" && scriptTestResult.matchedCount ? "测试通过" : "测试未通过" }}<small v-if="scriptTestResult.scriptDurationMs !== null">{{ scriptTestResult.scriptDurationMs }}ms</small></strong>
              <article v-for="item in scriptTestResult.results" :key="item.applicationId"><span>{{ previewData?.applications.find((candidate) => candidate.id === item.applicationId)?.jobTitle }}</span>
                <b>{{ item.status ? progressLabels[item.status] : "未匹配" }}</b><small>原始状态：{{ item.rawStatus || "无" }}</small><small>{{ item.evidence }}</small></article>
              <p v-if="scriptTestResult.error" class="error-text">{{ scriptTestResult.error }}</p></div>
          </aside>
        </div>

        <div v-else class="preview-empty"><i class="mdi mdi-vector-square"></i>
          <h2>{{ editingRuleId ? `正在编辑“${editor.name}”` : "选择岗位并加载页面" }}</h2>
          <p>预览任务不会新增检查任务、修改岗位状态或发送通知。</p>
          <button class="advanced-link" @click="switchMode('script')"><span>点选规则无法适配？</span><b>改用页面脚本</b><i class="mdi mdi-chevron-right"></i></button>
        </div>
      </main>
    </div>
  </section>
</template>

<style scoped>
.rule-studio { max-width: 1500px; }
.page-heading, .heading-actions, .panel-title, .rule-actions, .preview-toolbar, .canvas-tools, .editor-actions, .mode-heading, .script-toolbar, .number-row { display: flex; align-items: center; gap: 10px; }
.page-heading { justify-content: space-between; }
.page-heading p { margin-top: 4px; color: #77847e; }
.security-note { margin: 14px 0; padding: 11px 14px; border: 1px solid #cfe2da; border-radius: 10px; background: #eef7f2; color: #356454; }
.security-note.advanced { border-color: #e3d1b4; background: #fbf3e6; color: #7d5b2d; }
.security-note i { margin-right: 8px; }
.studio-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); height: calc(100vh - 180px); min-height: 700px; overflow: hidden; border: 1px solid #ded5c6; border-radius: 16px; background: #fffdf9; }
.rule-list { display: flex; min-height: 0; padding: 16px; overflow: hidden; flex-direction: column; border-right: 1px solid #e4ddcf; background: #f7f3ea; }
.panel-title { justify-content: space-between; margin-bottom: 12px; }
.panel-title span { padding: 2px 7px; border-radius: 12px; background: #e5ded1; font-size: 12px; }
.panel-title button { margin-left: auto; border: 0; background: transparent; color: #28735c; }
.rule-search { margin-bottom: 14px; }
.rule-items { min-height: 0; padding-right: 4px; overflow-y: auto; scrollbar-gutter: stable; }
.rule-items::-webkit-scrollbar { width: 7px; }
.rule-items::-webkit-scrollbar-thumb { border-radius: 999px; background: #b8c7c0; }
.rule-items::-webkit-scrollbar-track { background: transparent; }
.rule-items article { margin-bottom: 10px; padding: 13px 13px 9px; border: 1px solid #ded6c8; border-radius: 11px; background: #fff; transition: border-color .16s ease, box-shadow .16s ease; }
.rule-items article.selected { border-color: #438b73; box-shadow: 0 0 0 1px #438b73; }
.rule-items article.disabled { background: #fbfaf7; }
.rule-card-heading { display: flex; align-items: flex-start; gap: 8px; }
.rule-card-heading strong { min-width: 0; flex: 1; display: -webkit-box; overflow: hidden; font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.kind-badge { flex: none; padding: 2px 7px; border-radius: 10px; background: #edf4f0; color: #2d725b; font-size: 11px; white-space: nowrap; }
.kind-badge.script { background: #fff0df; color: #b65e20; }
.rule-scope { display: flex; align-items: center; gap: 5px; min-width: 0; margin: 9px 0 8px; color: #66756f; font-size: 12px; }
.rule-scope i { flex: none; color: #94a099; }
.rule-scope span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-meta-row { display: flex; align-items: center; justify-content: space-between; color: #839089; font-size: 11px; }
.rule-meta-row b { color: #5f6f68; font-weight: 500; }
.rule-state { display: inline-flex; align-items: center; gap: 4px; color: #388066; }
.rule-state i { font-size: 7px; }
.rule-state.off { color: #99938a; }
.rule-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; margin: 10px -5px 0; padding-top: 7px; border-top: 1px solid #eee9df; }
.rule-actions button { min-width: 0; padding: 5px 2px; border: 0; border-radius: 6px; background: transparent; color: #28735c; font-size: 12px; }
.rule-actions button:hover { background: #edf5f1; }
.rule-actions .danger { color: #b74f42; }
.rule-actions .danger:hover { background: #fff0ed; }
.editor { min-width: 0; padding: 18px; overflow-y: auto; }
.mode-heading { justify-content: space-between; margin-bottom: 12px; }
.mode-heading div { display: flex; align-items: center; gap: 8px; }
.mode-heading small { padding: 2px 7px; border-radius: 10px; background: #eee8dd; color: #796d5b; }
.mode-heading.script > div > strong { color: #a9521d; }
.mode-heading.script small { background: #fff0df; color: #b65e20; }
.mode-heading button, .advanced-link { border: 0; background: transparent; color: #28735c; }
.preview-toolbar { margin-bottom: 16px; }
.preview-toolbar .v-input { max-width: 720px; }
.authoring-grid, .script-grid, .selector-json-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; align-items: start; }
.canvas-column { min-width: 0; }
.canvas-tools { margin-bottom: 10px; flex-wrap: wrap; }
.canvas-tools button { padding: 7px 10px; border: 1px solid #d6cec0; border-radius: 8px; background: #fff; color: #5d6d66; }
.canvas-tools button.active { border-color: #338168; background: #e9f4ef; color: #216a54; }
.canvas-tools span { margin-left: auto; color: #839089; font-size: 12px; }
.canvas-scroll { max-height: calc(100vh - 320px); overflow: auto; border: 1px solid #d8d0c2; border-radius: 10px; background: #e9e6df; }
.screenshot-canvas { position: relative; width: 100%; min-width: 620px; }
.screenshot-canvas img { position: absolute; inset: 0; width: 100%; height: 100%; }
.node-box { position: absolute; z-index: 2; min-width: 2px; min-height: 2px; padding: 0; border: 1px solid transparent; background: transparent; pointer-events: none; }
.node-box.selected { z-index: 4; border-color: #e2933d; background: #f0a54b33; }
.node-box.title { border: 2px solid #287fd1; background: #4a9be533; }
.node-box.status { border: 2px solid #d46b3f; background: #e8865633; }
.node-box.matched { box-shadow: 0 0 0 2px #39a66b; }
.advanced-link { display: inline-flex; align-items: center; gap: 7px; margin: 14px auto 0; padding: 7px 8px 7px 13px; border: 1px solid #efd4bc; border-radius: 999px; background: #fff8f0; font-size: 13px; transition: border-color .16s ease, background .16s ease, transform .16s ease; }
.advanced-link span { color: #718079; }
.advanced-link b { color: #aa5620; font-weight: 600; }
.advanced-link i { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: #f9e4d1; color: #b65e20; font-size: 18px; transition: background .16s ease, transform .16s ease; }
.advanced-link:hover { border-color: #dfa978; background: #fff1e2; transform: translateY(-1px); }
.advanced-link:hover i { background: #f3d4b8; transform: translateX(2px); }
.rule-editor, .script-side { min-width: 0; }
.selection-card, .field-block { margin: 8px 0 16px; padding: 12px; border-radius: 10px; background: #f6f2e9; }
.selection-card { display: grid; gap: 5px; }
.selection-card small, .field-block p, .field-block article small { color: #75827c; }
.selection-card strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.errors { margin-bottom: 12px; padding: 10px; border-radius: 8px; background: #fff0ed; color: #a8483b; font-size: 12px; }
.errors p { margin: 2px 0; }
.editor-actions { flex-wrap: wrap; }
.test-results { margin-top: 16px; display: grid; gap: 8px; }
.test-results > strong { display: flex; justify-content: space-between; }
.test-results article { padding: 9px; border: 1px solid #e3dccf; border-radius: 8px; display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; }
.test-results article small { grid-column: 1 / -1; color: #78857f; }
.script-panel { min-width: 0; align-self: start; overflow: hidden; border: 1px solid #dca673; border-radius: 10px; background: #18231f; box-shadow: 0 0 0 1px #fff4e8 inset; }
.script-toolbar, .script-foot { padding: 10px 12px; background: #f6f2e9; color: #65746d; }
.script-toolbar { justify-content: space-between; }
.script-toolbar label { display: flex; align-items: center; gap: 8px; }
.script-toolbar select { padding: 5px 8px; border: 1px solid #d4ccbe; border-radius: 6px; background: white; }
.script-editor-shell { position: relative; height: clamp(480px, calc(100vh - 330px), 720px); background: #18231f; }
.script-highlight, .script-editor { width: 100%; height: 100%; min-height: 0; margin: 0; padding: 16px; border: 0; font: 13px/1.65 Consolas, monospace; tab-size: 2; white-space: pre; overflow: auto; }
.script-highlight { position: absolute; inset: 0; overflow: hidden; color: #d9e8e2; pointer-events: none; }
.script-editor { position: relative; display: block; resize: none; outline-offset: -2px; background: transparent; color: transparent; caret-color: #fff3e8; -webkit-text-fill-color: transparent; }
.script-editor::selection { background: #d9793655; }
.script-highlight :deep(.syntax-keyword) { color: #f6a65f; font-weight: 600; }
.script-highlight :deep(.syntax-string) { color: #b8d98c; }
.script-highlight :deep(.syntax-comment) { color: #7d938a; font-style: italic; }
.script-highlight :deep(.syntax-number) { color: #e6c07b; }
.script-highlight :deep(.syntax-api) { color: #7ec8d9; font-weight: 600; }
.json-panel { min-width: 0; overflow: hidden; border: 1px solid #8eb7a8; border-radius: 10px; background: #18231f; box-shadow: 0 0 0 1px #edf8f3 inset; }
.json-toolbar, .json-status { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 14px; background: #eff6f2; color: #45685c; }
.json-toolbar div { display: flex; align-items: center; gap: 8px; }
.json-toolbar span { color: #7b8a84; font-size: 12px; }
.json-editor-shell { position: relative; height: clamp(480px, calc(100vh - 330px), 720px); background: #18231f; }
.json-highlight, .json-editor { width: 100%; height: 100%; min-height: 0; margin: 0; padding: 16px; border: 0; font: 13px/1.65 Consolas, monospace; tab-size: 2; white-space: pre; overflow: auto; }
.json-highlight { position: absolute; inset: 0; overflow: hidden; color: #d9e8e2; pointer-events: none; }
.json-editor { position: relative; display: block; resize: none; outline-offset: -2px; background: transparent; color: transparent; caret-color: #e9fff5; -webkit-text-fill-color: transparent; }
.json-editor::selection { background: #4a9d7a55; }
.json-highlight :deep(.syntax-keyword) { color: #f6a65f; font-weight: 600; }
.json-highlight :deep(.syntax-string) { color: #b8d98c; }
.json-highlight :deep(.syntax-number) { color: #e6c07b; }
.json-status { justify-content: flex-start; border-top: 1px solid #d5e6de; font-size: 12px; }
.json-status.invalid { background: #fff0ed; color: #a8483b; }
.json-side { min-width: 0; }
.scope-summary { display: grid; gap: 7px; }
.scope-summary code { overflow: hidden; padding: 7px 9px; border-radius: 6px; background: #fff; color: #47665b; text-overflow: ellipsis; white-space: nowrap; }
.json-help { margin: 12px 0 16px; color: #75827c; font-size: 12px; line-height: 1.6; }
.script-foot { display: grid; gap: 4px; font-size: 12px; }
.script-foot small { color: #849089; line-height: 1.5; }
.script-foot code { color: #8a572f; }
.field-block p { margin: 4px 0 10px; font-size: 12px; }
.field-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.field-buttons button { display: grid; padding: 7px; border: 1px solid #ded6c8; border-radius: 7px; background: #fff; text-align: left; }
.field-buttons span { color: #7b8882; font-size: 11px; }
.field-block article { display: grid; padding: 8px 0; border-bottom: 1px solid #e3dccf; }
.field-block article:last-child { border-bottom: 0; }
.number-row > * { min-width: 0; }
.error-text { color: #b74f42; }
.preview-empty { min-height: 560px; display: grid; place-content: center; justify-items: center; color: #7e8b85; text-align: center; }
.preview-empty > i { font-size: 54px; color: #9eb7ad; }
.preview-empty h2 { color: #31554b; }
.empty-small { padding: 35px 0; color: #87938d; text-align: center; }
@media (max-width: 1180px) {
  .studio-layout { grid-template-columns: 250px minmax(0, 1fr); }
  .authoring-grid, .script-grid, .selector-json-grid { grid-template-columns: 1fr; }
  .rule-editor { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .selection-card, .errors, .editor-actions, .test-results { grid-column: 1 / -1; }
}
@media (max-width: 900px) {
  .studio-layout { height: auto; grid-template-columns: 1fr; }
  .rule-list { overflow: visible; border-right: 0; border-bottom: 1px solid #e4ddcf; }
  .rule-items { max-height: 320px; overflow-y: auto; }
  .editor { overflow-y: visible; }
  .preview-toolbar { flex-wrap: wrap; }
  .preview-toolbar .v-input { max-width: none; }
}
</style>
